use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use farstep_protocol::Result;

use crate::native::failure;

pub(super) fn effective_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

pub fn state() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| failure("HOME is missing"))?;
    Ok(PathBuf::from(
        std::env::var_os("XDG_STATE_HOME")
            .unwrap_or_else(|| PathBuf::from(home).join(".local/state").into_os_string()),
    )
    .join("farstep"))
}

pub fn runtime() -> Result<PathBuf> {
    Ok(std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or(state()?.join("runtime"))
        .join("farstep"))
}

pub fn protect_directory(path: &Path) -> Result<()> {
    if !path.exists() {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(failure)?;
    }
    let info = std::fs::symlink_metadata(path).map_err(failure)?;
    if !info.is_dir() || info.uid() != effective_uid() || info.mode() & 0o077 != 0 {
        return Err(failure(
            "Farstep directories must be private and owned by the current user",
        ));
    }
    Ok(())
}
