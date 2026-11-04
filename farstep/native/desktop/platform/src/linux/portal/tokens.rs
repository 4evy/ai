use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};

use super::super::protocol::{Failure, Result, Source};

pub(super) fn restore_error(error: ashpd::Error, token: Option<&str>) -> Failure {
    if token.is_some()
        && matches!(
            &error,
            ashpd::Error::Portal(ashpd::PortalError::InvalidArgument(_))
        )
    {
        Failure::new("invalid-restore-token", "Portal rejected restore token")
    } else {
        error.into()
    }
}

pub(super) fn token_path(state: &Path, source: &Source, control: bool) -> Result<PathBuf> {
    let directory = state.join("tokens");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .map_err(|e| Failure::new("prerequisite", e))?;
    use std::os::unix::fs::MetadataExt;
    let metadata =
        std::fs::symlink_metadata(&directory).map_err(|e| Failure::new("prerequisite", e))?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(Failure::new(
            "prerequisite",
            "Restore token directory must be private and owned by this UID",
        ));
    }
    Ok(directory.join(format!(
        "{}-{}",
        if control { "control" } else { "capture" },
        if *source == Source::Monitor {
            "monitor"
        } else {
            "window"
        }
    )))
}

pub(super) fn write_token(path: &Path, token: &str) -> Result<()> {
    use std::io::Write;
    // Persist beside the target so replacement stays atomic on one filesystem
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap_or(Path::new(".")))
        .map_err(|e| Failure::new("prerequisite", e))?;
    file.write_all(token.as_bytes())
        .and_then(|()| file.as_file().sync_all())
        .map_err(|e| Failure::new("prerequisite", e))?;
    file.persist(path)
        .map(|_| ())
        .map_err(|e| Failure::new("prerequisite", e))
}
