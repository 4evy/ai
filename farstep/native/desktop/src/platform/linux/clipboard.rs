use std::io::{Read, Write};
use std::process::Stdio;
use std::sync::Arc;

use ashpd::desktop::clipboard::SetSelectionOptions;
use ashpd::desktop::remote_desktop::RemoteDesktop;
use backon::{BlockingRetryable, ConstantBuilder};
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::task::AbortOnDropHandle;

use super::portal::{Handle, Portal};
use super::protocol::{Failure, MAX_REQUEST, Result};

const TRANSFER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const OWNERSHIP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
// Leave time for the worker to report readiness before its parent times out
const OWNERSHIP_OBSERVATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(9);
const OWNERSHIP_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);
const OWNERSHIP_READY: u8 = 1;

const TEXT_MIME_TYPES: &[&str] = &["text/plain;charset=utf-8", "text/plain", "UTF8_STRING"];

pub enum Owner {
    Portal { _task: AbortOnDropHandle<()> },
    DataControl { _child: tokio::process::Child },
}

/// Owns the payload for sequential, borrowed portal transfers
struct PortalPublication {
    clipboard: Arc<ashpd::desktop::clipboard::Clipboard>,
    session: Arc<ashpd::desktop::Session<RemoteDesktop>>,
    expected: serde_json::Value,
    bytes: Vec<u8>,
    effects: Arc<std::sync::Mutex<super::protocol::Receipt>>,
}

impl PortalPublication {
    fn new(
        clipboard: &Arc<ashpd::desktop::clipboard::Clipboard>,
        session: &Arc<ashpd::desktop::Session<RemoteDesktop>>,
        text: &str,
        effects: Arc<std::sync::Mutex<super::protocol::Receipt>>,
    ) -> Result<Self> {
        let clipboard = clipboard.clone();
        let session = session.clone();
        let expected =
            serde_json::to_value(session.as_ref()).map_err(|e| Failure::new("backend-error", e))?;
        let bytes = text.as_bytes().to_vec();
        Ok(Self {
            clipboard,
            session,
            expected,
            bytes,
            effects,
        })
    }

    async fn publish(self) -> Result<Owner> {
        let (ready, initialized) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(self.run(ready));
        let owner = Owner::Portal {
            _task: AbortOnDropHandle::new(task),
        };
        initialized
            .await
            .map_err(|_| Failure::new("disconnected", "Clipboard transfer service ended"))??;
        Ok(owner)
    }

    async fn run(self, ready: tokio::sync::oneshot::Sender<Result<()>>) {
        let subscriptions = async {
            let transfers = self
                .clipboard
                .receive_selection_transfer::<RemoteDesktop>()
                .await?;
            let ownership = self
                .clipboard
                .receive_selection_owner_changed::<RemoteDesktop>()
                .await?;
            if let Ok(mut receipt) = self.effects.lock() {
                receipt.mechanism = "portal-clipboard";
                receipt.partial = true;
            }
            // Subscribe before publication, including clipboard-manager
            // reads
            self.clipboard
                .set_selection(
                    &self.session,
                    SetSelectionOptions::default().set_mime_types(TEXT_MIME_TYPES),
                )
                .await?;
            if let Ok(mut receipt) = self.effects.lock() {
                receipt.clipboard_changed = true;
            }
            Ok::<_, ashpd::Error>((transfers, ownership))
        }
        .await;
        let (transfers, ownership) = match subscriptions {
            Ok(streams) => {
                let _ = ready.send(Ok(()));
                streams
            }
            Err(error) => {
                let _ = ready.send(Err(Failure::from(error)));
                return;
            }
        };
        futures_util::pin_mut!(transfers, ownership);
        loop {
            tokio::select! {
                request = transfers.next() => {
                    let Some((target, mime, serial)) = request else {
                        break;
                    };
                    if serde_json::to_value(&target).ok().as_ref() != Some(&self.expected) {
                        continue;
                    }
                    if self.send_selection(&mime, serial)
                        .await
                        .is_err()
                    {
                        break;
                    }
                },
                changed = ownership.next() => {
                    let Some((target, changed)) = changed else {
                        break;
                    };
                    if serde_json::to_value(&target).ok().as_ref() == Some(&self.expected)
                        && changed.session_is_owner() == Some(false)
                    {
                        break;
                    }
                },
            }
        }
    }

    async fn send_selection(
        &self,
        mime: &str,
        serial: u32,
    ) -> std::result::Result<(), ashpd::Error> {
        let supported = TEXT_MIME_TYPES.contains(&mime);
        let success = if supported {
            match self.clipboard.selection_write(&self.session, serial).await {
                Ok(fd) => tokio::time::timeout(TRANSFER_TIMEOUT, transfer(fd.into(), &self.bytes))
                    .await
                    .is_ok_and(|r| r.is_ok()),
                Err(_) => false,
            }
        } else {
            false
        };

        self.clipboard
            .selection_write_done(&self.session, serial, success)
            .await
    }
}

pub async fn publish(
    portal: &Portal,
    text: &str,
    effects: Arc<std::sync::Mutex<super::protocol::Receipt>>,
) -> Result<(Owner, &'static str)> {
    if let (Some(clipboard), Handle::Remote(session, _)) = (&portal.clipboard, &portal.handle) {
        let publication = PortalPublication::new(clipboard, session, text, effects)?;
        return Ok((publication.publish().await?, "portal-clipboard"));
    }
    if portal.clipboard_denied {
        return Err(Failure::new(
            "denied",
            "Clipboard access was explicitly denied; data-control fallback is prohibited",
        ));
    }
    if !portal.data_control {
        return Err(Failure::new(
            "unsupported-text",
            "No EI text or granted portal/data-control clipboard is available",
        ));
    }
    Ok((publish_data_control(text, &effects).await?, "data-control"))
}

async fn publish_data_control(
    text: &str,
    effects: &Arc<std::sync::Mutex<super::protocol::Receipt>>,
) -> Result<Owner> {
    if let Ok(mut receipt) = effects.lock() {
        receipt.mechanism = "data-control";
        receipt.partial = true;
    }
    let executable = std::env::current_exe().map_err(|e| Failure::new("prerequisite", e))?;
    let mut child = tokio::process::Command::new(executable)
        .args(["clipboard", "worker"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Failure::new("backend-error", e))?;
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| Failure::new("backend-error", "Clipboard worker stdin unavailable"))?;
    input
        .write_all(text.as_bytes())
        .await
        .map_err(|e| Failure::new("backend-error", e))?;
    drop(input);
    let mut output = child
        .stdout
        .take()
        .ok_or_else(|| Failure::new("backend-error", "Clipboard worker readiness unavailable"))?;
    let mut ready = [0_u8; 1];
    tokio::time::timeout(OWNERSHIP_TIMEOUT, output.read_exact(&mut ready))
        .await
        .map_err(|_| Failure::new("backend-error", "Clipboard ownership timed out"))?
        .map_err(|e| Failure::new("backend-error", e))?;
    if ready[0] != OWNERSHIP_READY {
        return Err(Failure::new(
            "backend-error",
            "Clipboard worker could not publish",
        ));
    }
    if let Ok(mut receipt) = effects.lock() {
        receipt.clipboard_changed = true;
    }
    Ok(Owner::DataControl { _child: child })
}

// Portal transfers can use any pollable Unix FD, not just pipes
async fn transfer(fd: std::os::fd::OwnedFd, bytes: &[u8]) -> std::io::Result<()> {
    let mut descriptor = async_io::Async::new(std::fs::File::from(fd))?;
    futures_util::AsyncWriteExt::write_all(&mut descriptor, bytes).await
}

pub fn worker() -> Result<()> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take((MAX_REQUEST + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| Failure::new("backend-error", e))?;
    if bytes.len() > MAX_REQUEST || bytes.contains(&0) {
        return Err(Failure::new("invalid-request", "Invalid clipboard payload"));
    }
    use wl_clipboard_rs::{copy, paste};
    let marker = format!("application/x-farstep-{}", uuid::Uuid::new_v4());
    let offered_marker = marker.clone();
    let worker = std::thread::spawn(move || {
        let mut options = copy::Options::new();
        options.foreground(true);
        let prepared = options
            .prepare_copy_multi(vec![
                copy::MimeSource {
                    source: copy::Source::Bytes(bytes.into_boxed_slice()),
                    mime_type: copy::MimeType::Text,
                },
                copy::MimeSource {
                    source: copy::Source::Bytes(Box::new([])),
                    mime_type: copy::MimeType::Specific(offered_marker),
                },
            ])
            .map_err(|e| Failure::new("backend-error", e))?;
        prepared
            .serve()
            .map_err(|e| Failure::new("backend-error", e))
    });
    // Observe our unique MIME offer, never read the user's prior clipboard
    // contents
    let deadline = std::time::Instant::now() + OWNERSHIP_OBSERVATION_TIMEOUT;
    (|| {
        if paste::get_mime_types(paste::ClipboardType::Regular, paste::Seat::default())
            .is_ok_and(|types| types.contains(&marker))
        {
            Ok(())
        } else {
            Err(Failure::new(
                "backend-error",
                "Data-control ownership was not established",
            ))
        }
    })
    .retry(
        ConstantBuilder::default()
            .with_delay(OWNERSHIP_POLL_INTERVAL)
            .without_max_times(),
    )
    .when(|_| !worker.is_finished() && std::time::Instant::now() < deadline)
    .call()?;
    std::io::stdout()
        .write_all(&[OWNERSHIP_READY])
        .and_then(|()| std::io::stdout().flush())
        .map_err(|e| Failure::new("backend-error", e))?;
    worker
        .join()
        .map_err(|_| Failure::new("backend-error", "Clipboard serving worker failed"))?
}
