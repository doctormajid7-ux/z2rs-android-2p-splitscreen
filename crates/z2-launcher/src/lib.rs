//! `z2-launcher`: a small window for configuring and starting the game.
//!
//! The game (`z2-native`, shipped as `z2rs`) is driven by command-line flags,
//! which is a hurdle for players who just want to pick their ROM and press
//! Play. The launcher is a separate program that shows those choices as
//! plain controls (ROM file, window size, widescreen, HD pack, local or
//! online co-op), remembers them in `<data-dir>/launcher.json`, and starts
//! the game with the matching flags. It does not link the game itself, so it
//! stays small and the game stays the single source of truth for what the
//! flags mean.
//!
//! Layout:
//!
//! * [`settings`]: the saved choices, [`build_args`] (choices to flags) and
//!   [`validate`] (plain-language problems). No window needed; unit tested.
//! * [`game`]: finding the game program and running it.
//! * [`ui`]: [`launcher_ui`], a pure `egui::Ui` view that returns an
//!   [`Action`], so it can be embedded somewhere else later.
//! * [`app`]: the eframe (OpenGL) window and native file pickers.
//!
//! The ROM is the player's own dump. The launcher only stores its path and
//! reads its first four bytes to check the header; it never copies it.

pub mod app;
pub mod game;
pub mod settings;
pub mod ui;

pub use settings::{build_args, validate, Settings};
pub use ui::{launcher_ui, Action, LauncherState};
