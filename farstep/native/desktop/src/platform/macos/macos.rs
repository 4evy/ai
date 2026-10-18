mod authorization;
mod capture;
mod daemon;
mod storage;

#[path = "workspace/workspace.rs"]
pub mod workspace;

pub use authorization::{authorize, capture_granted, input_granted, permissions};
pub use capture::{Target, sources};
pub use daemon::{daemon, gateway};
pub use storage::{protect_directory, state};

pub const PLATFORM: &str = "darwin";
pub const BACKEND: &str = "screencapturekit-quartz";
pub const PERMISSION_PROMPTS: bool = true;
