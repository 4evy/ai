use std::collections::HashMap;

use procfs::process::Process;
use zbus::OwnedFd;

use super::super::MAX_IDENTITY_BYTES;
use super::super::protocol::Result;
use super::prerequisite;

// Keep these signatures aligned with extensions/shared/protocol.ts's
// introspection XML
#[zbus::proxy(
    interface = "org.farstep.Workspaces1",
    default_service = "org.gnome.Shell",
    default_path = "/org/farstep/Workspaces"
)]
pub(super) trait Workspaces {
    fn inspect(&self) -> zbus::Result<String>;
    fn busy(&self) -> zbus::Result<u32>;
    fn open(
        &self,
        id: &str,
        uri: &str,
        profile: &str,
        environment: &HashMap<String, String>,
    ) -> zbus::Result<u32>;
    fn launch(
        &self,
        id: &str,
        arguments: &[String],
        environment: &HashMap<String, String>,
        directory: &str,
        descriptors: &[OwnedFd],
    ) -> zbus::Result<u32>;
    fn status(&self, id: &str) -> zbus::Result<(bool, bool, i32)>;
    fn ready(&self, id: &str) -> zbus::Result<()>;
    fn release(&self, id: &str) -> zbus::Result<bool>;
}

pub(super) async fn launch_bus() -> Result<zbus::Connection> {
    use std::os::unix::fs::MetadataExt;
    let path = dirs::runtime_dir()
        .ok_or_else(|| prerequisite("XDG_RUNTIME_DIR is missing"))?
        .join("farstep/nested.json");
    if !super::super::nested::cosmic() && !path.exists() {
        return zbus::Connection::session().await.map_err(prerequisite);
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(prerequisite)?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > MAX_IDENTITY_BYTES
    {
        return Err(prerequisite(
            "Nested desktop connection is not private and owned",
        ));
    }
    let endpoint: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).map_err(prerequisite)?)
            .map_err(prerequisite)?;
    let pid = endpoint["pid"]
        .as_u64()
        .filter(|pid| *pid <= i32::MAX as u64)
        .ok_or_else(|| prerequisite("Nested desktop process identity is missing"))?;
    let start = Process::new(pid as i32)
        .and_then(|process| process.stat())
        .map_err(prerequisite)?
        .starttime;
    if endpoint["startTime"].as_str() != Some(start.to_string().as_str()) {
        return Err(prerequisite("Nested desktop connection is stale"));
    }
    let address = endpoint["address"]
        .as_str()
        .ok_or_else(|| prerequisite("Nested desktop bus address is missing"))?;
    zbus::connection::Builder::address(address)
        .build()
        .await
        .map_err(prerequisite)
}

pub(super) async fn adapter(bus: &zbus::Connection) -> zbus::Result<WorkspacesProxy<'_>> {
    let requested = std::env::var("FARSTEP_WORKSPACE_SERVICE").unwrap_or_default();
    let external = if requested == "org.farstep.Workspaces" {
        true
    } else if requested == "org.gnome.Shell" {
        false
    } else {
        zbus::fdo::DBusProxy::new(bus)
            .await?
            .name_has_owner("org.farstep.Workspaces".try_into()?)
            .await?
    };
    WorkspacesProxy::builder(bus)
        .destination(if external {
            "org.farstep.Workspaces"
        } else {
            "org.gnome.Shell"
        })
        .build()
        .await
}

pub async fn backend(bus: &zbus::Connection) -> Option<&'static str> {
    let inspect = adapter(bus).await.ok()?.inspect().await.ok()?;
    let inspect: serde_json::Value = serde_json::from_str(&inspect).ok()?;
    let backend = inspect.get("backend")?.as_str()?;
    [
        "kde-kwin-workspace",
        "gnome-mutter-workspace",
        "sway-workspace",
        "niri-workspace",
        "hyprland-workspace",
        "cosmic-nested-sway-workspace",
    ]
    .into_iter()
    .find(|name| *name == backend)
}

pub async fn available(bus: &zbus::Connection) -> bool {
    let Ok(proxy) = adapter(bus).await else {
        return false;
    };
    proxy.inspect().await.is_ok()
}

pub async fn inspect() -> Result<String> {
    let bus = launch_bus().await?;
    adapter(&bus)
        .await
        .map_err(prerequisite)?
        .inspect()
        .await
        .map_err(prerequisite)
}

pub async fn busy() -> Result<u32> {
    let bus = launch_bus().await?;
    adapter(&bus)
        .await
        .map_err(prerequisite)?
        .busy()
        .await
        .map_err(prerequisite)
}
