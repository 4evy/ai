use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use ashpd::desktop::PersistMode;
use ashpd::desktop::clipboard::Clipboard;
use ashpd::desktop::remote_desktop::{DeviceType, RemoteDesktop, SelectDevicesOptions};
use ashpd::desktop::screencast::{
    CursorMode, Screencast, SelectSourcesOptions, SourceType, Stream,
};
use ashpd::zbus;

use super::super::eis::Eis;
use super::super::protocol::{Failure, Result, Source};
use super::super::{capture, direct};
use super::discovery::require_wayland;
use super::handle::monitor;
use super::tokens::{restore_error, write_token};
use super::{APP_ID, Handle, InputBackend, Portal, missing};

static REGISTERED_OWNER: tokio::sync::Mutex<Option<String>> = tokio::sync::Mutex::const_new(None);

pub(super) struct CastSetup {
    cast: Screencast,
    pub(super) bus: zbus::Connection,
    pub(super) source_type: SourceType,
    cursor: CursorMode,
}

impl CastSetup {
    pub(super) async fn connect(source: Source) -> Result<Self> {
        // Register ashpd's shared sender once per portal owner before making
        // any session calls
        require_wayland()?;
        let mut registered = REGISTERED_OWNER.lock().await;
        let cast = Screencast::new().await?;
        let bus = cast.connection().clone();
        let owner = zbus::fdo::DBusProxy::new(&bus)
            .await
            .map_err(|error| Failure::new("backend-error", error))?
            .get_name_owner(
                "org.freedesktop.portal.Desktop"
                    .try_into()
                    .map_err(|e| Failure::new("prerequisite", e))?,
            )
            .await
            .map_err(|error| Failure::new("backend-error", error))?
            .to_string();
        if registered.as_ref() != Some(&owner) {
            ashpd::register_host_app_with_connection(bus.clone(), APP_ID.parse()?).await?;
            *registered = Some(owner);
        }
        drop(registered);
        let source_type = match source {
            Source::Monitor => SourceType::Monitor,
            Source::Window => SourceType::Window,
        };
        if !cast.available_source_types().await?.contains(source_type) {
            return Err(Failure::new(
                "missing-protocol",
                "Requested portal source type is unavailable",
            ));
        }
        let cursor = if cast
            .available_cursor_modes()
            .await?
            .contains(CursorMode::Embedded)
        {
            CursorMode::Embedded
        } else {
            CursorMode::Hidden
        };
        Ok(Self {
            cast,
            bus,
            source_type,
            cursor,
        })
    }

    fn source_options(&self) -> SelectSourcesOptions {
        SelectSourcesOptions::default()
            .set_sources(enumflags2::BitFlags::from(self.source_type))
            .set_multiple(false)
            .set_cursor_mode(self.cursor)
    }

    pub(super) async fn select(
        &self,
        control: bool,
        output_name: Option<&str>,
        token: Option<&str>,
    ) -> Result<SelectedSession> {
        let remote = if control {
            match RemoteDesktop::with_connection(self.bus.clone()).await {
                Ok(proxy) => Some(Arc::new(proxy)),
                Err(e) if missing(&e) => None,
                Err(e) => return Err(e.into()),
            }
        } else {
            None
        };
        if let Some(remote) = remote {
            self.remote(remote, token).await
        } else {
            self.capture(control, output_name, token).await
        }
    }

    async fn remote(
        &self,
        remote: Arc<RemoteDesktop>,
        token: Option<&str>,
    ) -> Result<SelectedSession> {
        let mut clipboard = None;
        let mut clipboard_denied = false;
        let session = Arc::new(remote.create_session(Default::default()).await?);
        let handle = Handle::Remote(session.clone(), Arc::new(AtomicBool::new(false)));
        let devices = DeviceType::Keyboard | DeviceType::Pointer;
        if !remote.available_device_types().await?.contains(devices) {
            return Err(Failure::new(
                "missing-protocol",
                "Portal lacks requested keyboard/pointer device types",
            ));
        }
        remote
            .select_devices(
                &session,
                SelectDevicesOptions::default()
                    .set_devices(devices)
                    .set_persist_mode(PersistMode::ExplicitlyRevoked)
                    .set_restore_token(token),
            )
            .await
            .map_err(|e| restore_error(e, token))?
            .response()?;
        self.cast
            .select_sources(&session, self.source_options())
            .await?
            .response()?;
        match Clipboard::with_connection(self.bus.clone()).await {
            Ok(proxy) => {
                proxy.request(&session, Default::default()).await?;
                clipboard = Some(Arc::new(proxy));
            }
            Err(e) if missing(&e) => {}
            Err(e) => return Err(e.into()),
        }
        let response = remote
            .start(&session, None, Default::default())
            .await
            .map_err(|e| restore_error(e, token))?
            .response()?;
        if !response.devices().contains(devices) {
            return Err(Failure::new(
                "denied",
                "Portal did not grant requested keyboard and pointer devices",
            ));
        }
        if clipboard.is_some() && !response.is_clipboard_enabled() {
            clipboard_denied = true;
            clipboard = None;
        }
        let fd = self
            .cast
            .open_pipe_wire_remote(&session, Default::default())
            .await?;
        let backend = match remote.connect_to_eis(&session, Default::default()).await {
            Ok(fd) => InputBackend::Eis(Eis::connect(fd).await?),
            Err(e) if missing(&e) => InputBackend::Notify {
                proxy: remote,
                keys: Default::default(),
                buttons: Default::default(),
            },
            Err(e) => return Err(e.into()),
        };
        Ok(SelectedSession {
            handle,
            streams: response.streams().to_vec(),
            restore: response.restore_token().map(str::to_owned),
            fd,
            backend,
            clipboard,
            clipboard_denied,
        })
    }

    async fn capture(
        &self,
        control: bool,
        output_name: Option<&str>,
        token: Option<&str>,
    ) -> Result<SelectedSession> {
        if control && self.source_type == SourceType::Window {
            return Err(Failure::new(
                "mapping-unavailable",
                "Direct input cannot bind a window capture",
            ));
        }
        let output = if control {
            Some(output_name.filter(|s| !s.is_empty()).ok_or_else(|| {
                Failure::new(
                    "mapping-unavailable",
                    "Direct input requires an explicit outputName selected by the user",
                )
            })?)
        } else {
            None
        };
        let session = Arc::new(self.cast.create_session(Default::default()).await?);
        let handle = Handle::Cast(session.clone(), Arc::new(AtomicBool::new(false)));
        self.cast
            .select_sources(
                &session,
                self.source_options()
                    .set_persist_mode(PersistMode::ExplicitlyRevoked)
                    .set_restore_token(token),
            )
            .await
            .map_err(|e| restore_error(e, token))?
            .response()?;
        let response = self
            .cast
            .start(&session, None, Default::default())
            .await
            .map_err(|e| restore_error(e, token))?
            .response()?;
        let fd = self
            .cast
            .open_pipe_wire_remote(&session, Default::default())
            .await?;
        let backend = if let Some(output) = output {
            InputBackend::Direct(Arc::new(direct::Direct::connect(output).await?))
        } else {
            InputBackend::None
        };
        Ok(SelectedSession {
            handle,
            streams: response.streams().to_vec(),
            restore: response.restore_token().map(str::to_owned),
            fd,
            backend,
            clipboard: None,
            clipboard_denied: false,
        })
    }
}

pub(super) struct SelectedSession {
    handle: Handle,
    streams: Vec<Stream>,
    restore: Option<String>,
    fd: std::os::fd::OwnedFd,
    backend: InputBackend,
    clipboard: Option<Arc<Clipboard>>,
    clipboard_denied: bool,
}

impl SelectedSession {
    pub(super) async fn finish(
        self,
        source_type: SourceType,
        token_path: &Path,
        bus: zbus::Connection,
    ) -> Result<Portal> {
        let Self {
            handle,
            streams,
            restore,
            fd,
            backend,
            clipboard,
            clipboard_denied,
        } = self;
        let [stream]: [_; 1] = streams.try_into().map_err(|_| {
            Failure::new(
                "mapping-unavailable",
                "Portal returned an ambiguous stream selection",
            )
        })?;
        if stream.source_type().is_some_and(|kind| kind != source_type) {
            return Err(Failure::new(
                "mapping-unavailable",
                "Portal returned a different source kind",
            ));
        }
        // Preserve the user's grant even if capture or input startup fails
        if let Some(token) = restore {
            write_token(token_path, &token)?;
        }
        let capture = capture::Capture::new(fd, stream.pipe_wire_node_id())?;
        // Restored streams may not expose EI regions until PipeWire starts
        // consuming
        if let InputBackend::Eis(eis) = &backend {
            eis.wait_ready().await?;
        }
        let live = Arc::new(AtomicBool::new(true));
        let monitors = monitor(&handle, bus, live.clone());
        Ok(Portal {
            handle,
            stream,
            capture,
            backend,
            clipboard,
            clipboard_denied,
            data_control: direct::discover()?.clipboard,
            live,
            _monitors: monitors,
        })
    }
}
