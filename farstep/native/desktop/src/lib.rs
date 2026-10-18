//! Native desktop backends and optional system helpers

#[cfg(all(feature = "desktop", target_os = "linux"))]
#[forbid(unsafe_code)]
#[path = "platform/linux/linux.rs"]
mod linux;

#[cfg(all(feature = "desktop", any(target_os = "macos", target_os = "windows")))]
#[forbid(unsafe_code)]
#[path = "platform/native/native.rs"]
mod native;

#[cfg(all(feature = "desktop", target_os = "macos"))]
#[allow(
    unsafe_code,
    reason = "Native CoreGraphics, Accessibility and libc API boundary"
)]
#[path = "platform/macos/macos.rs"]
mod macos;

#[cfg(all(feature = "desktop", target_os = "windows"))]
#[allow(unsafe_code, reason = "Native Win32 API boundary")]
#[path = "platform/windows/windows.rs"]
mod windows;

#[cfg(all(feature = "systemd", target_os = "linux"))]
#[forbid(unsafe_code)]
#[path = "platform/linux/systemd/systemd.rs"]
mod systemd;

#[cfg(all(target_os = "linux", any(feature = "desktop", feature = "systemd")))]
#[path = "cli/cli.rs"]
mod cli;

#[cfg(feature = "cli")]
pub async fn run() -> farstep_protocol::Result<i32> {
    #[cfg(all(target_os = "linux", any(feature = "desktop", feature = "systemd")))]
    return cli::run().await;

    #[cfg(all(feature = "desktop", any(target_os = "macos", target_os = "windows")))]
    return native::run().await;

    #[cfg(not(any(
        all(target_os = "linux", any(feature = "desktop", feature = "systemd")),
        all(feature = "desktop", any(target_os = "macos", target_os = "windows"))
    )))]
    Err(farstep_protocol::Failure::new(
        "unsupported-platform",
        format!("No desktop backend enabled for {}", std::env::consts::OS),
    ))
}
