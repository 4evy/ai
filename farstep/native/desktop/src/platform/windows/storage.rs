use std::path::{Path, PathBuf};

use farstep_protocol::Result;
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

use crate::native::failure;

pub fn sid() -> Result<String> {
    win_custody::current_user_sid_string().map_err(failure)
}

pub fn state() -> Result<PathBuf> {
    Ok(PathBuf::from(
        std::env::var_os("LOCALAPPDATA").ok_or_else(|| failure("LOCALAPPDATA is missing"))?,
    )
    .join("Farstep/state"))
}

pub fn protect_directory(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(failure)?;
    let info = std::fs::symlink_metadata(path).map_err(failure)?;
    use std::os::windows::fs::MetadataExt;
    if !info.is_dir() || info.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(failure("Private directory must not be a reparse point"));
    }
    let status = std::process::Command::new("icacls.exe")
        .arg(path)
        .args([
            "/inheritance:r",
            "/grant:r",
            &format!("*{}:(OI)(CI)F", sid()?),
            "*S-1-5-18:(OI)(CI)F",
        ])
        .output()
        .map_err(failure)?;
    if !status.status.success() {
        return Err(failure(String::from_utf8_lossy(&status.stderr)));
    }
    Ok(())
}
