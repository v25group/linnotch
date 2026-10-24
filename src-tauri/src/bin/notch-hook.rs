//! `notch-hook`: what Claude Code's hooks run. The same code as `notch hook`, built as a windowed
//! program: Claude Code inside VS Code has no console, so a console program like notch.exe made
//! Windows flash a terminal window open and shut on every prompt. This one never gets a console.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[allow(dead_code)]
#[path = "notch.rs"]
mod notch;

fn main() {
    notch::hook();
}
