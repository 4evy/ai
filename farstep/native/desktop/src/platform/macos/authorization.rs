use axuielement::process_trust;
use core_graphics::access::ScreenCaptureAccess;
use farstep_protocol::{Failure, Result};
use objc2_core_graphics::{
    CGPreflightListenEventAccess, CGPreflightPostEventAccess, CGRequestListenEventAccess,
    CGRequestPostEventAccess,
};

use crate::native::failure;

pub fn capture_granted() -> bool {
    ScreenCaptureAccess.preflight()
}

pub fn input_granted() -> bool {
    process_trust::is_process_trusted()
}

fn request_input() -> bool {
    process_trust::is_process_trusted_with_prompt()
}

fn request_capture() -> bool {
    ScreenCaptureAccess.request()
}

pub fn authorize(control: bool) -> Result<()> {
    let capture = capture_granted() || request_capture();
    let input = !control || input_granted() || request_input();
    if !capture || !input {
        return Err(Failure::new(
            "permission-denied",
            "Grant Farstep screen recording and Accessibility in System Settings, then retry",
        ));
    }
    Ok(())
}

pub fn permissions() -> Result<()> {
    let capture = capture_granted() || request_capture();
    let input = input_granted() || request_input();
    let monitoring = CGPreflightListenEventAccess() || CGRequestListenEventAccess();
    let posting = CGPreflightPostEventAccess() || CGRequestPostEventAccess();
    let status = std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .status()
        .map_err(failure)?;
    if !status.success() {
        return Err(failure("Cannot open Full Disk Access settings"));
    }
    println!(
        "{}",
        serde_json::json!({
            "screenRecording": capture,
            "accessibility": input,
            "inputMonitoring": monitoring,
            "eventPosting": posting,
            "fullDiskAccess": "Grant Farstep.app in System Settings; no public API can grant this \
                               permission",
            "automation": "macOS requests Automation for each app when an Apple event job first \
                           addresses it",
            "restartRequired": true
        })
    );
    Ok(())
}
