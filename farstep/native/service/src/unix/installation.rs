use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::PathBuf;

use super::manager::{definition, healthy, labels, start, stop, unit};
use super::storage::{directory, marker, owned, pin, store, trusted, write};
#[cfg(target_os = "linux")]
use super::systemd;
use super::{root, socket, uid};
use crate::Result;

struct Snapshot {
    binary: Option<Vec<u8>>,
    unit: Option<Vec<u8>>,
    package: Option<PathBuf>,
    directory: bool,
}

struct Installation<'a> {
    owner: &'a str,
    dir: PathBuf,
    binary: Vec<u8>,
    package: Option<PathBuf>,
    previous: Snapshot,
}

impl<'a> Installation<'a> {
    fn prepare(owner: &'a str) -> Result<Self> {
        root()?;
        uid(owner)?;
        owned(owner)?;
        let dir = directory(owner);
        let parent = dir.parent().ok_or("Service parent missing")?;
        trusted(parent.parent().ok_or("Service ancestor missing")?, true)?;
        if !parent.exists() {
            std::fs::DirBuilder::new().mode(0o755).create(parent)?;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755))?;
        }
        trusted(parent, true)?;
        trusted(
            unit(owner)
                .parent()
                .ok_or("Service definition parent missing")?,
            true,
        )?;
        let old_binary = std::fs::read(dir.join("farstep-service")).ok();
        let old_unit = std::fs::read(unit(owner)).ok();
        let had_directory = dir.exists();
        let source = std::env::current_exe()?;
        let package = source
            .strip_prefix(store())
            .ok()
            .and_then(|relative| relative.components().next())
            .map(|component| store().join(component))
            .ok_or("Install the system service from the Nix Farstep package")?;
        trusted(&source, false)?;
        let old_package = std::fs::read_link(dir.join("package")).ok();
        let binary = std::fs::read(source)?;
        Ok(Self {
            owner,
            dir,
            binary,
            package: Some(package),
            previous: Snapshot {
                binary: old_binary,
                unit: old_unit,
                package: old_package,
                directory: had_directory,
            },
        })
    }

    fn activate(&self) -> Result<()> {
        if !self.dir.exists() {
            std::fs::DirBuilder::new().mode(0o755).create(&self.dir)?;
        }
        // The gateway intentionally uses umask 0077; these root-owned paths
        // must still be traversable for unprivileged identity checks
        std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o755))?;
        write(
            &self.dir.join("owner"),
            marker(self.owner).as_bytes(),
            0o644,
        )?;
        pin(
            &self.dir.join("previous-package"),
            self.previous.package.as_deref(),
        )?;
        pin(&self.dir.join("package"), self.package.as_deref())?;
        write(&self.dir.join("farstep-service"), &self.binary, 0o755)?;
        write(&unit(self.owner), definition(self.owner)?.as_bytes(), 0o644)?;
        labels(self.owner)?;
        start(self.owner)?;
        healthy(self.owner)
    }

    fn restore(&self) -> Result<()> {
        let _ = stop(self.owner);
        #[cfg(target_os = "linux")]
        if self.previous.unit.is_none() {
            systemd::manage(self.owner, systemd::Action::Disable, true)?;
        }
        pin(&self.dir.join("package"), self.previous.package.as_deref())?;
        for (path, bytes, mode) in [
            (
                self.dir.join("farstep-service"),
                self.previous.binary.as_deref(),
                0o755,
            ),
            (unit(self.owner), self.previous.unit.as_deref(), 0o644),
        ] {
            if let Some(bytes) = bytes {
                write(&path, bytes, mode)?;
            } else {
                pin(&path, None)?;
            }
        }
        if self.previous.binary.is_some() && self.previous.unit.is_some() {
            labels(self.owner)?;
            start(self.owner)?;
        }
        if !self.previous.directory {
            pin(&self.dir.join("owner"), None)?;
            pin(&self.dir.join("previous-package"), None)?;
            if self.dir.exists() {
                std::fs::remove_dir(&self.dir)?;
            }
        }
        #[cfg(target_os = "linux")]
        systemd::manage(self.owner, systemd::Action::Reload, false)?;
        Ok(())
    }
}

pub fn install(owner: &str) -> Result<()> {
    let installation = Installation::prepare(owner)?;
    stop(owner)?;
    let result = installation.activate();
    if result.is_err() {
        installation.restore()?;
    }
    pin(&installation.dir.join("previous-package"), None)?;
    result
}

pub fn uninstall(owner: &str) -> Result<()> {
    root()?;
    uid(owner)?;
    owned(owner)?;
    stop(owner)?;
    #[cfg(target_os = "linux")]
    systemd::manage(owner, systemd::Action::Disable, true)?;
    for path in [
        unit(owner),
        socket(owner),
        directory(owner).join("farstep-service"),
        directory(owner).join("owner"),
        directory(owner).join("package"),
        directory(owner).join("previous-package"),
    ] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    match std::fs::remove_dir(directory(owner)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    #[cfg(target_os = "linux")]
    systemd::manage(owner, systemd::Action::Reload, false)?;
    Ok(())
}
