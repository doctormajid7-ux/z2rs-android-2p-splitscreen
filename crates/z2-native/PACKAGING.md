# Packaging `z2-native`

Releases are built by `.github/workflows/release.yml`. Pushing a tag such as `v0.3.0` builds every target and attaches the archives and a `SHA256SUMS` file to a GitHub release. Running the workflow by hand builds the same archives as workflow artifacts without publishing anything.

## What each archive holds

The workflow builds three binaries in release mode: `z2-native` (the game), `z2-launcher` (the settings window that starts the game) and `z2-signal` (the signalling server for online co-op). They are renamed as they are packed:

| Target | Archive | Contents |
|---|---|---|
| `x86_64-unknown-linux-gnu` | `.tar.gz` | `z2rs`, `z2rs-launcher`, `z2-signal` |
| `x86_64-pc-windows-msvc` | `.zip` | `z2rs.exe`, `z2rs-launcher.exe`, `z2-signal.exe` |
| `aarch64-apple-darwin`, `x86_64-apple-darwin` | `.zip` | `z2rs.app`, plus a bare `z2rs` for terminal use |

Every archive also carries `README.md`, `LICENSE`, `LEGAL.md` and `HOW-TO-PLAY.txt`. The last one is a short plain-text guide for players, kept at `packaging/HOW-TO-PLAY.txt`.

The launcher looks for the game next to its own executable, under the name `z2rs` or `z2-native` (with `.exe` on Windows), so the binaries must stay in the same folder.

## The macOS app bundle

`z2rs.app` is assembled by hand in the workflow. `Contents/MacOS/` holds `z2rs-launcher` (the bundle's `CFBundleExecutable`), `z2rs` and `z2-signal`. `Contents/Info.plist` sets the bundle identifier `com.z2rs.launcher`, the name `z2rs`, the version from the tag, `NSHighResolutionCapable` and a minimum of macOS 11.0. There is no icon yet.

The macOS archives are zip files made with `ditto -c -k --keepParent`, which keeps the bundle's permissions and attributes and unpacks with a double click in Finder.

The Intel build is cross-compiled on the Apple Silicon runner.

## Code signing

Nothing is signed with a real certificate. macOS Gatekeeper (Developer ID plus notarization), Windows Authenticode and Linux package signatures are not configured.

The macOS bundle gets an ad-hoc signature (`codesign --force --deep -s -`). That does not satisfy Gatekeeper, but without any signature Apple Silicon reports a downloaded app as damaged. Players still see a warning on first launch, and the release notes and `HOW-TO-PLAY.txt` explain what to do on each system: right-click and Open (or Open Anyway in Privacy & Security) on macOS, with `xattr -dr com.apple.quarantine z2rs.app` as a fallback, More info and Run anyway in Windows SmartScreen, and `chmod +x` on Linux.

## Build dependencies

- Linux needs the X11, Wayland, ALSA and udev development packages for the game, and the OpenGL, X input and GTK packages for the launcher. The apt lists are in the "Install Linux build dependencies" step. The release binaries link these libraries dynamically.
- macOS needs nothing beyond the Xcode command line tools. winit and pixels use Metal, and cpal uses CoreAudio.
- Windows needs the MSVC toolchain. cpal uses WASAPI and gilrs uses XInput.

Installers (dmg, msi, shell scripts) could later come from [`cargo-dist`](https://github.com/axodotdev/cargo-dist) in place of the hand-written packaging steps.

## Data files

The archives ship no ROM, movie or snapshot. On launch the app looks for a ROM you supply (`--rom`, then the `rom_path` config key, then `$Z2_ROM`), checks it with the `z2-assets` hash check and loads it directly. The last ROM loaded is written back to `rom_path`, so a later start with no arguments finds it. `assets.bin` is optional. The extractor can generate it separately, and the app does not need it to start.

The data directory is `$XDG_DATA_HOME/z2rs`, `~/Library/Application Support/z2rs` or `%APPDATA%/z2rs` (see `data_dir` in `src/config.rs`). Only `assets.bin`, `z2-native.json`, `savestate*.z2snap` and `sram.sav` live there.
