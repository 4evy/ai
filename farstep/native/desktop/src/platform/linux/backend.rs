use std::path::Path;
use std::sync::atomic::Ordering;

use farstep_desktop_runtime::backend::{Backend, DesktopSession, SessionInfo, WorkspaceLease};
use farstep_protocol::*;
use tokio_util::sync::CancellationToken;

use super::{portal, session, workspace};

pub struct Linux;
#[async_trait::async_trait]
impl Backend for Linux {
    fn platform(&self) -> &'static str {
        "linux"
    }

    fn maintenance_gate(&self, state: &Path) -> Result<Box<dyn Send>> {
        Ok(Box::new(
            super::maintenance_gate(state).map_err(Failure::from)?,
        ))
    }

    async fn inspect(&self, session: Option<SessionInfo>) -> Result<Inspection> {
        let discovery = portal::discover().await.map_err(Failure::from)?;
        let workspace_backend = match zbus::Connection::session().await {
            Ok(bus) => workspace::backend(&bus).await,
            Err(_) => None,
        };
        let controlled = session.as_ref().is_some_and(|s| s.control);
        let remote_backend = if discovery.remote {
            "portal-remote-desktop"
        } else {
            "compositor-socket"
        };
        Ok(Inspection {
            status: "ok",
            operations: [
                (
                    "capture",
                    discovery.capture,
                    discovery.capture
                        && std::env::var("FARSTEP_NESTED_DESKTOP").as_deref() != Ok("cosmic"),
                    session.is_some(),
                    if std::env::var("FARSTEP_NESTED_DESKTOP").as_deref() == Ok("cosmic") {
                        "private-screencopy"
                    } else {
                        "portal-screencast"
                    },
                    "ScreenCast portal/source unavailable",
                ),
                (
                    "keyboard",
                    discovery.remote || discovery.direct.keyboard,
                    discovery.remote,
                    controlled,
                    remote_backend,
                    "RemoteDesktop and virtual keyboard unavailable",
                ),
                (
                    "pointer",
                    discovery.remote || discovery.direct.pointer,
                    discovery.remote,
                    controlled,
                    remote_backend,
                    "RemoteDesktop and output-bound virtual pointer unavailable",
                ),
                (
                    "clipboard",
                    discovery.clipboard || discovery.direct.clipboard,
                    discovery.clipboard,
                    session.as_ref().is_some_and(|s| s.clipboard),
                    if discovery.clipboard {
                        "portal-clipboard"
                    } else {
                        "data-control"
                    },
                    "Clipboard interfaces unavailable",
                ),
                (
                    "open",
                    discovery.open,
                    false,
                    discovery.open,
                    workspace_backend.unwrap_or("workspace"),
                    "Farstep workspace adapter unavailable",
                ),
            ]
            .into_iter()
            .map(
                |(operation, available, requestable, granted, backend, reason)| {
                    OperationAvailability {
                        operation,
                        available,
                        requestable,
                        granted,
                        backend: available.then(|| backend.to_owned()),
                        reason: (!available).then(|| reason.to_owned()),
                    }
                },
            )
            .collect(),
            sources: discovery.sources,
            session_id: session.map(|s| s.id),
        })
    }

    async fn create_session(
        &self,
        source: Source,
        control: bool,
        output_name: Option<&str>,
        state: &Path,
    ) -> Result<Box<dyn DesktopSession>> {
        let portal = portal::Portal::create(source.clone(), control, output_name, state)
            .await
            .map_err(Failure::from)?;
        Ok(Box::new(session::Session::new(source, portal)))
    }

    async fn open(&self, uri: &str) -> Result<Box<dyn WorkspaceLease>> {
        Ok(Box::new(portal::open(uri).await.map_err(Failure::from)?))
    }
}

#[async_trait::async_trait]
impl DesktopSession for session::Session {
    fn id(&self) -> &str {
        &self.id
    }

    fn source(&self) -> &Source {
        &self.source
    }

    fn backend_name(&self) -> &'static str {
        if matches!(&self.portal.handle, portal::Handle::Private) {
            "private-sway"
        } else {
            self.portal.backend.name()
        }
    }

    fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            control: self.control(),
            clipboard: self.portal.clipboard.is_some()
                || (!self.portal.clipboard_denied && self.portal.data_control),
        }
    }

    fn live(&self) -> bool {
        self.portal.live.load(Ordering::Acquire)
    }

    fn capture_stopped(&self) -> CancellationToken {
        self.portal.capture.stopped.clone()
    }

    async fn invalidated(&mut self) -> bool {
        session::Session::invalidated(self)
    }

    fn receipt(&self) -> Option<Receipt> {
        self.receipt()
    }

    fn reset_receipt(&mut self) {
        self.reset_receipt()
    }

    async fn invalidate(&mut self) {
        self.invalidate().await
    }

    async fn close(&mut self) {
        self.close().await
    }

    async fn capture(&mut self) -> Result<(Frame, Vec<u8>)> {
        self.capture().await.map_err(Into::into)
    }

    async fn input(&mut self, input: Input) -> Result<Option<Receipt>> {
        self.input(input).await.map_err(Into::into)
    }
}

#[async_trait::async_trait]
impl WorkspaceLease for workspace::Lease {
    fn id(&self) -> &str {
        &self.id
    }

    async fn release(self: Box<Self>) -> Result<()> {
        (*self).release().await.map_err(Into::into)
    }
}
