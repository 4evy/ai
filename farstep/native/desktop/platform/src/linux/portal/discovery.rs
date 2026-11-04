use ashpd::desktop::clipboard::Clipboard;
use ashpd::desktop::remote_desktop::RemoteDesktop;
use ashpd::desktop::screencast::{Screencast, SourceType};
use ashpd::zbus;

use super::super::direct;
use super::super::protocol::{Failure, MAX_URI_BYTES, Result, Source};
use super::APP_ID;

pub async fn connection() -> Result<zbus::Connection> {
    require_wayland()?;
    let connection = zbus::Connection::session()
        .await
        .map_err(|e| Failure::new("prerequisite", e))?;
    ashpd::register_host_app_with_connection(connection.clone(), APP_ID.parse()?).await?;
    Ok(connection)
}

pub(super) fn require_wayland() -> Result<()> {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Err(Failure::new(
            "unsupported-platform",
            "Wayland graphical-session environment is required; X11 is unsupported",
        ));
    }
    Ok(())
}

pub fn missing(error: &ashpd::Error) -> bool {
    matches!(
        error,
        ashpd::Error::PortalNotFound(_) | ashpd::Error::RequiresVersion(_, _)
    ) || matches!(
        error,
        ashpd::Error::Zbus(zbus::Error::MethodError(name, _, _))
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.UnknownMethod"
                    | "org.freedesktop.DBus.Error.UnknownInterface"
            )
    )
}

pub struct Discovery {
    pub sources: Vec<Source>,
    pub capture: bool,
    pub remote: bool,
    pub clipboard: bool,
    pub open: bool,
    pub direct: direct::Capabilities,
}

pub async fn discover() -> Result<Discovery> {
    if std::env::var("FARSTEP_NESTED_DESKTOP").as_deref() == Ok("cosmic") {
        let bus = ::zbus::Connection::session()
            .await
            .map_err(|error| Failure::new("prerequisite", error))?;
        return Ok(Discovery {
            sources: vec![Source::Monitor],
            capture: true,
            remote: false,
            clipboard: false,
            open: super::super::workspace::available(&bus).await,
            direct: direct::discover()?,
        });
    }
    let bus = connection().await?;
    let cast = Screencast::with_connection(bus.clone()).await;
    let sources = match &cast {
        Ok(cast) => {
            let mask = cast.available_source_types().await?;
            [
                (SourceType::Monitor, Source::Monitor),
                (SourceType::Window, Source::Window),
            ]
            .into_iter()
            .filter_map(|(flag, source)| mask.contains(flag).then_some(source))
            .collect()
        }
        Err(e) if missing(e) => Vec::new(),
        Err(e) => return Err(Failure::new("backend-error", e)),
    };
    let remote = match RemoteDesktop::with_connection(bus.clone()).await {
        Ok(_) => true,
        Err(e) if missing(&e) => false,
        Err(e) => return Err(e.into()),
    };
    let clipboard = match Clipboard::with_connection(bus.clone()).await {
        Ok(_) => true,
        Err(e) if missing(&e) => false,
        Err(e) => return Err(e.into()),
    };
    let workspace_bus = ::zbus::Connection::session()
        .await
        .map_err(|error| Failure::new("prerequisite", error))?;
    let open = super::super::workspace::available(&workspace_bus).await;
    Ok(Discovery {
        capture: !sources.is_empty(),
        sources,
        remote,
        clipboard,
        open,
        direct: direct::discover()?,
    })
}

pub async fn open(uri: &str) -> Result<super::super::workspace::Lease> {
    if uri.len() > MAX_URI_BYTES {
        return Err(Failure::new("invalid-request", "URI exceeds limit"));
    }
    let parsed: ashpd::Uri = uri
        .parse()
        .map_err(|e| Failure::new("invalid-request", e))?;
    require_wayland()?;
    let bus = ::zbus::Connection::session()
        .await
        .map_err(|error| Failure::new("prerequisite", error))?;
    super::super::workspace::Lease::open(bus, parsed.as_str()).await
}
