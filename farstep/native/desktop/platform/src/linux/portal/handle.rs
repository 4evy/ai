use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ashpd::desktop::remote_desktop::RemoteDesktop;
use ashpd::desktop::screencast::Screencast;
use ashpd::desktop::{Session, SessionPortal};
use ashpd::zbus;
use futures_util::StreamExt;

pub enum Handle {
    Private,
    Cast(Arc<Session<Screencast>>, Arc<AtomicBool>),
    Remote(Arc<Session<RemoteDesktop>>, Arc<AtomicBool>),
}

impl Handle {
    pub async fn close(&self) {
        match self {
            Self::Private => {}
            Self::Cast(s, closed) => {
                if !closed.swap(true, Ordering::AcqRel) {
                    let _ = s.close().await;
                }
            }
            Self::Remote(s, closed) => {
                if !closed.swap(true, Ordering::AcqRel) {
                    let _ = s.close().await;
                }
            }
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        match self {
            Self::Private => {}
            Self::Cast(s, closed) => {
                if !closed.swap(true, Ordering::AcqRel) {
                    let s = s.clone();
                    tokio::spawn(async move {
                        let _ = s.close().await;
                    });
                }
            }
            Self::Remote(s, closed) => {
                if !closed.swap(true, Ordering::AcqRel) {
                    let s = s.clone();
                    tokio::spawn(async move {
                        let _ = s.close().await;
                    });
                }
            }
        }
    }
}

async fn monitor_session<T: SessionPortal>(
    session: Arc<Session<T>>,
    ended: Arc<AtomicBool>,
    live: Arc<AtomicBool>,
) {
    if let Ok(mut closed) = session.receive_closed().await {
        let _ = closed.next().await;
    }
    ended.store(true, Ordering::Release);
    live.store(false, Ordering::Release);
}

pub(super) fn monitor(
    handle: &Handle,
    bus: zbus::Connection,
    live: Arc<AtomicBool>,
) -> tokio::task::JoinSet<()> {
    let mut monitors = tokio::task::JoinSet::new();
    match handle {
        Handle::Private => {}
        Handle::Remote(session, closed) => {
            monitors.spawn(monitor_session(
                session.clone(),
                closed.clone(),
                live.clone(),
            ));
        }
        Handle::Cast(session, closed) => {
            monitors.spawn(monitor_session(
                session.clone(),
                closed.clone(),
                live.clone(),
            ));
        }
    }
    let owner_live = live.clone();
    let owner_closed = match handle {
        Handle::Private => Arc::new(AtomicBool::new(false)),
        Handle::Cast(_, closed) | Handle::Remote(_, closed) => closed.clone(),
    };
    monitors.spawn(async move {
        if let Ok(proxy) = zbus::Proxy::new(
            &bus,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Desktop",
        )
        .await
            && let Ok(mut changes) = proxy.receive_owner_changed().await
        {
            let _ = changes.next().await;
        }
        owner_closed.store(true, Ordering::Release);
        owner_live.store(false, Ordering::Release);
    });
    monitors
}
