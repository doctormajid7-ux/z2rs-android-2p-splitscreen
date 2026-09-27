//! Finding the game program and running it.
//!
//! The game's standard output and error go to `<data-dir>/last-game.log`
//! rather than a pipe: the game keeps running (and printing) after the
//! launcher closes, and a write into a pipe nobody reads any more would stop
//! it. The file also survives for bug reports.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Environment variable that names the game program explicitly.
pub const GAME_BIN_ENV: &str = "Z2RS_GAME_BIN";
/// Game output log file name inside the data dir.
pub const GAME_LOG_FILE_NAME: &str = "last-game.log";
/// How many trailing log lines an error shows.
pub const ERROR_TAIL_LINES: usize = 20;

/// Program names tried next to the launcher, in order.
pub fn game_binary_names() -> Vec<String> {
    let exe = std::env::consts::EXE_SUFFIX;
    vec![format!("z2rs{exe}"), format!("z2-native{exe}")]
}

/// Every path [`resolve_game_binary`] would try for `exe_dir`, in order.
///
/// Release archives and the macOS `.app` bundle (`Contents/MacOS/`) ship the
/// game next to the launcher. In a cargo checkout a debug launcher also looks
/// in the sibling `release` folder, since the debug game is too slow to play.
pub fn candidate_paths(exe_dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = game_binary_names()
        .iter()
        .map(|n| exe_dir.join(n))
        .collect();
    if exe_dir.file_name().is_some_and(|n| n == "debug") {
        if let Some(target) = exe_dir.parent() {
            let exe = std::env::consts::EXE_SUFFIX;
            out.push(target.join("release").join(format!("z2-native{exe}")));
        }
    }
    out
}

/// Where the game program is, or an explanation of where we looked.
///
/// Order: the manual override (when non-empty), then `$Z2RS_GAME_BIN`, then
/// [`candidate_paths`] next to the launcher.
pub fn resolve_game_binary(
    override_path: &str,
    env_value: Option<OsString>,
    exe_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let override_path = override_path.trim();
    if !override_path.is_empty() {
        let p = PathBuf::from(override_path);
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!(
                "The game program set under Advanced was not found: {override_path}"
            ))
        };
    }
    if let Some(v) = env_value.filter(|v| !v.is_empty()) {
        let p = PathBuf::from(&v);
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!(
                "{GAME_BIN_ENV} is set but that file was not found: {}",
                p.display()
            ))
        };
    }
    let Some(dir) = exe_dir else {
        return Err(
            "Could not tell where the launcher is installed, so the game could not be \
             found. Set the game program under Advanced."
                .to_string(),
        );
    };
    let tried = candidate_paths(dir);
    if let Some(found) = tried.iter().find(|p| p.is_file()) {
        return Ok(found.clone());
    }
    let list = tried
        .iter()
        .map(|p| format!("  {}", p.display()))
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "The game program was not found. The launcher looked for:\n{list}\n\
         Keep the launcher in the same folder as the game, or set the game program \
         under Advanced."
    ))
}

/// [`resolve_game_binary`] with this process's environment and location.
pub fn resolve_game_binary_here(override_path: &str) -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    resolve_game_binary(
        override_path,
        std::env::var_os(GAME_BIN_ENV),
        exe_dir.as_deref(),
    )
}

/// A running game process.
pub struct RunningGame {
    child: Child,
    log_path: PathBuf,
}

/// How a finished game ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameExit {
    /// `true` on a zero exit status.
    pub success: bool,
    /// Human-readable status (exit code or signal).
    pub status: String,
    /// Last lines of the game's output.
    pub tail: Vec<String>,
}

impl RunningGame {
    /// Start `program args`, output to `log_path`.
    pub fn spawn(program: &Path, args: &[String], log_path: &Path) -> std::io::Result<Self> {
        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let log = std::fs::File::create(log_path)?;
        let log_err = log.try_clone()?;
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));
        // Run the game from its own folder so it finds anything shipped next
        // to it.
        if let Some(dir) = program.parent().filter(|d| !d.as_os_str().is_empty()) {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            /// Keep a console window from flashing up behind the game.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd.spawn()?;
        Ok(RunningGame {
            child,
            log_path: log_path.to_path_buf(),
        })
    }

    /// `Some` once the game has exited.
    pub fn poll(&mut self) -> Option<GameExit> {
        match self.child.try_wait() {
            Ok(None) => None,
            Ok(Some(status)) => {
                let text = std::fs::read_to_string(&self.log_path).unwrap_or_default();
                Some(GameExit {
                    success: status.success(),
                    status: match status.code() {
                        Some(c) => format!("exit code {c}"),
                        None => format!("{status}"),
                    },
                    tail: last_lines(&text, ERROR_TAIL_LINES),
                })
            }
            Err(e) => Some(GameExit {
                success: false,
                status: format!("could not check the game: {e}"),
                tail: Vec::new(),
            }),
        }
    }
}

/// The last `n` non-empty lines of `text`.
pub fn last_lines(text: &str, n: usize) -> Vec<String> {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..]
        .iter()
        .map(|l| l.to_string())
        .collect()
}

/// Open `dir` in the system file browser, creating it first.
pub fn open_folder(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    Command::new(opener)
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("z2-launcher-game-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn resolution_order() {
        let d = temp_dir("resolve");
        let names = game_binary_names();
        // Nothing there: the error lists every place tried.
        let err = resolve_game_binary("", None, Some(&d)).unwrap_err();
        for n in &names {
            assert!(err.contains(n.as_str()), "{err}");
        }
        // z2-native only.
        let native = d.join(&names[1]);
        std::fs::write(&native, b"").unwrap();
        assert_eq!(resolve_game_binary("", None, Some(&d)).unwrap(), native);
        // z2rs wins over z2-native.
        let z2rs = d.join(&names[0]);
        std::fs::write(&z2rs, b"").unwrap();
        assert_eq!(resolve_game_binary("", None, Some(&d)).unwrap(), z2rs);
        // The environment wins over the launcher folder.
        let env_bin = d.join("custom-game");
        std::fs::write(&env_bin, b"").unwrap();
        assert_eq!(
            resolve_game_binary("", Some(env_bin.clone().into()), Some(&d)).unwrap(),
            env_bin
        );
        assert!(resolve_game_binary("", Some(d.join("gone").into()), Some(&d)).is_err());
        // The manual override wins over everything.
        assert_eq!(
            resolve_game_binary(&native.to_string_lossy(), Some(env_bin.into()), Some(&d)).unwrap(),
            native
        );
        assert!(resolve_game_binary("/definitely/not/here", None, Some(&d)).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn debug_launcher_also_tries_release_game() {
        let c = candidate_paths(Path::new("/w/target/debug"));
        assert_eq!(c.len(), 3);
        assert!(c[2].starts_with("/w/target/release"));
        assert_eq!(candidate_paths(Path::new("/w/target/release")).len(), 2);
    }

    #[test]
    fn tail_keeps_last_non_empty_lines() {
        let text = (1..=30)
            .map(|i| format!("line {i}\n\n"))
            .collect::<String>();
        let t = last_lines(&text, 20);
        assert_eq!(t.len(), 20);
        assert_eq!(t[0], "line 11");
        assert_eq!(t[19], "line 30");
        assert!(last_lines("", 5).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn spawn_captures_output_and_exit_code() {
        let d = temp_dir("spawn");
        let log = d.join("game.log");
        let args = vec![
            "-c".to_string(),
            "echo hello; echo oops >&2; exit 3".to_string(),
        ];
        let mut g = RunningGame::spawn(Path::new("/bin/sh"), &args, &log).unwrap();
        let exit = loop {
            if let Some(e) = g.poll() {
                break e;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert!(!exit.success);
        assert_eq!(exit.status, "exit code 3");
        assert_eq!(exit.tail, vec!["hello", "oops"]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
