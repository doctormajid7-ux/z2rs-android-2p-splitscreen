//! `z2-launcher` binary: opens the launcher window (see the library docs).

// No console window behind the launcher in Windows release builds.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() -> eframe::Result {
    z2_launcher::app::run()
}
