use std::sync::atomic::Ordering;

use farstep_protocol::*;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::Channel;
use crate::backend::DesktopSession;

// The router borrows this state while Channel retains cancellation ownership
pub(super) struct SessionOperations {
    pub(super) channel: Channel,
    pub(super) session: Mutex<Option<Box<dyn DesktopSession>>>,
}

fn validate_owned_session(
    session: Option<&dyn DesktopSession>,
    id: Option<&str>,
    message: &'static str,
) -> Result<()> {
    if let Some(id) = id {
        validate_id(id)?;
        if session.is_none_or(|session| session.id() != id) {
            return Err(Failure::new("closed-session", message));
        }
    }
    Ok(())
}

impl Channel {
    pub(super) async fn release(&self, session: &mut Option<Box<dyn DesktopSession>>) {
        if let Some(mut previous) = session.take() {
            previous.close().await;
            self.shared.sessions.fetch_sub(1, Ordering::AcqRel);
        }
        self.control.lock().await.take();
    }
}

impl SessionOperations {
    pub(super) async fn inspect_session(&self) -> Result<Inspection> {
        let session = self.session.lock().await;
        let info = session.as_ref().map(|session| session.info());
        self.channel.shared.backend.inspect(info).await
    }

    pub(super) async fn authorize_session(&self, request: Authorize) -> Result<Value> {
        let mut session = self.session.lock().await;
        if request
            .output_name
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > MAX_ID_BYTES)
        {
            return Err(Failure::new("invalid-request", "Invalid outputName"));
        }
        let _gate = self
            .channel
            .shared
            .backend
            .maintenance_gate(&self.channel.shared.state)?;
        let mut control = self.channel.control.lock().await;
        if control.is_none() {
            *control = Some(
                self.channel
                    .shared
                    .lease
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| {
                        Failure::new("busy", "Another channel owns the desktop control lease")
                    })?,
            );
        }
        if let Some(mut previous) = session.take() {
            previous.close().await;
            self.channel.shared.sessions.fetch_sub(1, Ordering::AcqRel);
        }
        let _profile = self.channel.shared.profiles.lock().await;
        let next = match self
            .channel
            .shared
            .backend
            .create_session(
                request.source.clone(),
                true,
                request.output_name.as_deref(),
                &self.channel.shared.state,
            )
            .await
        {
            Ok(session) => session,
            Err(error) => {
                control.take();
                return Err(error);
            }
        };
        let result = json!({
            "status": "ok",
            "sessionId": next.id(),
            "source": request.source,
            "backend": next.backend_name(),
        });
        *session = Some(next);
        self.channel.shared.sessions.fetch_add(1, Ordering::AcqRel);
        Ok(result)
    }

    pub(super) async fn capture_frame(&self, request: Capture) -> Result<(Frame, Vec<u8>)> {
        let mut session = self.session.lock().await;
        validate_owned_session(
            session.as_deref(),
            request.session_id.as_deref(),
            "Capture session is not owned by this channel",
        )?;
        if session.is_none() {
            let _gate = self
                .channel
                .shared
                .backend
                .maintenance_gate(&self.channel.shared.state)?;
            let source = request.source.unwrap_or_default();
            let _profile = self.channel.shared.profiles.lock().await;
            let next = self
                .channel
                .shared
                .backend
                .create_session(source, false, None, &self.channel.shared.state)
                .await?;
            *session = Some(next);
            self.channel.shared.sessions.fetch_add(1, Ordering::AcqRel);
        } else if request
            .source
            .as_ref()
            .is_some_and(|source| session.as_ref().is_some_and(|s| s.source() != source))
        {
            return Err(Failure::new(
                "invalid-request",
                "Requested source differs from the owned session",
            ));
        }
        let active = session
            .as_mut()
            .ok_or_else(|| Failure::new("closed-session", "No capture session"))?;
        active.capture().await
    }

    pub(super) async fn submit_input(&self, request: Input) -> Result<Option<Receipt>> {
        let mut session = self.session.lock().await;
        validate_id(&request.session_id)?;
        if let Some(frame) = &request.frame {
            validate_id(&frame.stream_id)?;
            validate_id(&frame.frame_id)?;
        }
        let active = session.as_mut().ok_or_else(|| {
            Failure::new(
                "authorization-required",
                "Explicit desktop.authorize is required",
            )
        })?;
        active.input(request).await
    }

    pub(super) async fn release_owned_session(&self, request: Release) -> Result<()> {
        let mut session = self.session.lock().await;
        validate_owned_session(
            session.as_deref(),
            request.session_id.as_deref(),
            "Release session is not owned by this channel",
        )?;
        self.channel.release(&mut session).await;
        Ok(())
    }
}
