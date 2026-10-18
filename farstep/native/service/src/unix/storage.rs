use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use super::manager::unit;
use super::system_path;
use crate::Result;

pub(super) fn store() -> &'static Path {
    Path::new(option_env!("FARSTEP_STORE_DIR").unwrap_or("/nix/store"))
}

pub(super) fn directory(owner: &str) -> PathBuf {
    #[cfg(target_os = "linux")]
    return PathBuf::from(format!("/var/lib/farstep/service-{owner}"));
    #[cfg(target_os = "macos")]
    return PathBuf::from(format!(
        "/Library/PrivilegedHelperTools/org.farstep.service-{owner}"
    ));
}

pub(super) fn trusted(path: &Path, directory: bool) -> Result<()> {
    let info = std::fs::symlink_metadata(path)?;
    if info.uid() != 0
        || info.mode() & 0o022 != 0
        || if directory {
            !info.is_dir()
        } else {
            !info.is_file()
        }
    {
        return Err(format!("Refusing untrusted service path: {}", path.display()).into());
    }
    Ok(())
}

pub(super) fn marker(owner: &str) -> String {
    format!("Farstep system service v1 owner={owner}")
}

pub(super) fn owned(owner: &str) -> Result<()> {
    let dir = directory(owner);
    if std::fs::symlink_metadata(&dir).is_ok() {
        trusted(&dir, true)?;
        trusted(&dir.join("owner"), false)?;
        if std::fs::read_to_string(dir.join("owner"))? != marker(owner) {
            return Err("Refusing an unrelated service installation".into());
        }
        let binary = dir.join("farstep-service");
        trusted(&binary, false)?;
        for path in [dir.join("package"), dir.join("previous-package")] {
            if let Ok(info) = std::fs::symlink_metadata(&path)
                && (!info.file_type().is_symlink()
                    || info.uid() != 0
                    || !std::fs::read_link(path)?.starts_with(store()))
            {
                return Err("Refusing an unrelated Nix service root".into());
            }
        }
    }
    let path = unit(owner);
    if std::fs::symlink_metadata(&path).is_ok() {
        trusted(&path, false)?;
        if !std::fs::read_to_string(path)?.contains(&marker(owner)) {
            return Err("Refusing an unrelated service definition".into());
        }
    }
    Ok(())
}

pub(super) fn pin(path: &Path, package: Option<&Path>) -> Result<()> {
    if let Some(package) = package {
        // The copied executable still uses its Nix runtime closure; an
        // indirect root keeps that closure alive across profile changes
        let output = Command::new(option_env!("FARSTEP_NIX_STORE").unwrap_or("nix-store"))
            .env("PATH", system_path()?)
            .arg("--add-root")
            .arg(path)
            .arg("--indirect")
            .arg("--realise")
            .arg(package)
            .output()?;
        if !output.status.success() {
            return Err(format!(
                "Cannot retain the Nix service closure: {}",
                String::from_utf8_lossy(&output.stderr)
            )
            .into());
        }
    } else {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

pub(super) fn write(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    use std::io::Write;
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Service file parent missing")?)?;
    file.write_all(bytes)?;
    file.as_file()
        .set_permissions(std::fs::Permissions::from_mode(mode))?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    Ok(())
}
