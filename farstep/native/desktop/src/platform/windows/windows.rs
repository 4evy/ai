mod authorization;
mod capture;
mod daemon;
mod input;
mod storage;

pub use authorization::{authorize, capture_granted, input_granted, permissions};
pub use capture::{Target, sources};
pub use daemon::daemon;
use farstep_protocol::Result;
pub use input::move_pointer;
pub use storage::{protect_directory, state};

use crate::native::failure;

pub const PLATFORM: &str = "win32";
pub const BACKEND: &str = "win32-gdi-sendinput";
pub const PERMISSION_PROMPTS: bool = false;

pub fn gateway(_: &[String]) -> Result<()> {
    Err(failure("Use bin/farstep.cmd on Windows"))
}
