use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;

use super::super::PRIVATE_OUTPUT;
use super::super::capture::{Geometry, Image};
use super::super::protocol::{Failure, MAX_PNG, Result};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DIAGNOSTIC_BYTES: u64 = 64 * 1024;

pub async fn image() -> Result<Image> {
    if std::env::var("FARSTEP_NESTED_DESKTOP").as_deref() != Ok("cosmic") {
        return Err(Failure::new("prerequisite", "Private desktop is required"));
    }
    // A fresh screencopy connection supplies a snapshot even without damage
    // The private compositor fixes output scale and orientation
    let mut child = tokio::process::Command::new(
        std::env::var_os("FARSTEP_NESTED_GRIM").unwrap_or_else(|| "grim".into()),
    )
    .args(["-o", PRIVATE_OUTPUT, "-t", "png", "-"])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true)
    .spawn()
    .map_err(|error| Failure::new("prerequisite", error))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Failure::new("backend-error", "Snapshot stdout is missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Failure::new("backend-error", "Snapshot stderr is missing"))?;
    let result = tokio::time::timeout(SNAPSHOT_TIMEOUT, async {
        let mut png = Vec::new();
        let mut diagnostic = Vec::new();
        let mut output = stdout.take(MAX_PNG as u64 + 1);
        let mut errors = stderr.take(MAX_DIAGNOSTIC_BYTES);
        let (out, err, status) = tokio::join!(
            output.read_to_end(&mut png),
            errors.read_to_end(&mut diagnostic),
            child.wait(),
        );
        out.map_err(|error| Failure::new("disconnected", error))?;
        err.map_err(|error| Failure::new("disconnected", error))?;
        if !status
            .map_err(|error| Failure::new("disconnected", error))?
            .success()
        {
            return Err(Failure::new(
                "disconnected",
                String::from_utf8_lossy(&diagnostic),
            ));
        }
        if png.len() > MAX_PNG {
            return Err(Failure::new(
                "mapping-unavailable",
                "Private snapshot is not a bounded PNG",
            ));
        }
        let (width, height) = farstep_desktop_runtime::image::dimensions(&png)
            .map_err(|error| Failure::new("mapping-unavailable", error.message))?;
        Ok(Image {
            png,
            geometry: Geometry {
                full_width: width,
                full_height: height,
                x: 0,
                y: 0,
                width,
                height,
            },
            generation: 0,
        })
    })
    .await;
    result.map_err(|_| Failure::new("disconnected", "Private snapshot timed out"))?
}
