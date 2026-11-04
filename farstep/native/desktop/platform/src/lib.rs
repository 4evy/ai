//! Native desktop backends and platform-owned connection lifetimes

#[cfg(target_os = "linux")]
#[forbid(unsafe_code)]
#[path = "linux/linux.rs"]
mod linux;

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[forbid(unsafe_code)]
#[path = "native/native.rs"]
mod native;

#[cfg(target_os = "macos")]
#[allow(
    unsafe_code,
    reason = "Native CoreGraphics, Accessibility and libc API boundary"
)]
#[path = "macos/macos.rs"]
mod macos;

#[cfg(target_os = "windows")]
#[allow(unsafe_code, reason = "Native Win32 API boundary")]
#[path = "windows/windows.rs"]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::{clipboard_worker, daemon, workspace};
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub use native::run;
