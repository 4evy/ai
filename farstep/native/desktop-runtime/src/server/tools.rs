use std::sync::atomic::Ordering;

use base64::Engine;
use farstep_protocol::*;
use rmcp::handler::server::tool::{IntoCallToolResult, ToolRouter};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::*;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::Channel;
use crate::backend::DesktopSession;

pub(super) struct ToolSession {
    pub(super) channel: Channel,
    pub(super) session: Mutex<Option<Box<dyn DesktopSession>>>,
}

// Keep MCP adaptation outside the wire crate
pub(super) struct ToolFailure(Failure);

impl From<Failure> for ToolFailure {
    fn from(failure: Failure) -> Self {
        Self(failure)
    }
}

impl IntoCallToolResult for ToolFailure {
    fn into_call_tool_result(self) -> Result<CallToolResponse, rmcp::ErrorData> {
        Ok(CallToolResult::structured_error(self.0.value()).into())
    }
}

impl ToolSession {
    pub(super) fn router() -> ToolRouter<Self> {
        Self::tool_router()
    }
}

#[rmcp::tool_router]
impl ToolSession {
    #[rmcp::tool(
        name = "system.inspect",
        description = "Inspect the native desktop daemon's system authority"
    )]
    async fn system_inspect(
        &self,
        Parameters(_): Parameters<Empty>,
    ) -> Result<CallToolResult, ToolFailure> {
        Ok(CallToolResult::structured(
            self.channel.shared.backend.system_status().await?,
        ))
    }

    #[rmcp::tool(
        name = "system.exec",
        description = "Run a bounded command through the elevated native desktop daemon"
    )]
    async fn system_exec(
        &self,
        Parameters(request): Parameters<SystemExec>,
    ) -> Result<CallToolResult, ToolFailure> {
        let result = self.channel.shared.backend.system_exec(request).await?;
        Ok(
            if result.get("exitCode").and_then(Value::as_i64) == Some(0) {
                CallToolResult::structured(result)
            } else {
                CallToolResult::structured_error(result)
            },
        )
    }

    #[rmcp::tool(
        name = "helper.handshake",
        description = "Negotiate helper protocol and immutable installation identity"
    )]
    async fn handshake(
        &self,
        Parameters(_): Parameters<Empty>,
    ) -> Result<CallToolResult, ToolFailure> {
        self.channel.negotiated.store(true, Ordering::Release);
        Ok(CallToolResult::structured(json!({
            "protocolMajor": PROTOCOL_MAJOR,
            "version": env!("CARGO_PKG_VERSION"),
            "installationId": self.channel.shared.installation_id,
            "platform": self.channel.shared.backend.platform(),
            "capabilities": ["desktop", "bounded-png", "frame-bound-input", "text-receipts"],
        })))
    }

    #[rmcp::tool(
        name = "helper.health",
        description = "Inspect active lease, desktop sessions and system commands without effects"
    )]
    async fn health(
        &self,
        Parameters(_): Parameters<Empty>,
    ) -> Result<CallToolResult, ToolFailure> {
        Ok(CallToolResult::structured(json!({
            "controlLeaseActive": self.channel.shared.lease.available_permits() == 0,
            "sessions": self.channel.shared.sessions.load(Ordering::Acquire),
            "systemCommands": self.channel.shared.backend.system_commands(),
        })))
    }

    #[rmcp::tool(
        name = "desktop.inspect",
        description = "Discover available, requestable and granted operations without consent"
    )]
    async fn inspect(
        &self,
        Parameters(_): Parameters<Empty>,
    ) -> Result<CallToolResult, ToolFailure> {
        let session = self.session.lock().await;
        let info = session.as_ref().map(|session| session.info());
        Ok(CallToolResult::structured(json!(
            self.channel.shared.backend.inspect(info).await?
        )))
    }

    #[rmcp::tool(
        name = "desktop.open",
        description = "Open a native URI handler in an owned workspace without activating it; \
                       releases on connection close"
    )]
    async fn open(
        &self,
        Parameters(request): Parameters<Open>,
    ) -> Result<CallToolResult, ToolFailure> {
        let lease = self.channel.shared.backend.open(&request.uri).await?;
        let id = lease.id().to_owned();
        self.channel.workspaces.lock().await.push(lease);
        Ok(CallToolResult::structured(
            json!({"status": "ok", "workspaceId": id}),
        ))
    }

    #[rmcp::tool(
        name = "desktop.workspace.release",
        description = "Stop an owned GUI launch and remove its workspace only when empty and \
                       inactive"
    )]
    async fn workspace_release(
        &self,
        Parameters(request): Parameters<WorkspaceRelease>,
    ) -> Result<CallToolResult, ToolFailure> {
        let mut leases = self.channel.workspaces.lock().await;
        let index = leases
            .iter()
            .position(|lease| lease.id() == request.workspace_id)
            .ok_or_else(|| Failure::new("invalid-request", "Unknown owned workspace lease"))?;
        leases.swap_remove(index).release().await?;
        Ok(CallToolResult::structured(json!({"status": "ok"})))
    }

    #[rmcp::tool(
        name = "desktop.authorize",
        description = "Request combined control/capture authorization through the native backend"
    )]
    async fn authorize(
        &self,
        Parameters(request): Parameters<Authorize>,
    ) -> Result<CallToolResult, ToolFailure> {
        let mut session = self.session.lock().await;
        if request
            .output_name
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > MAX_ID_BYTES)
        {
            return Err(Failure::new("invalid-request", "Invalid outputName").into());
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
                return Err(error.into());
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
        Ok(CallToolResult::structured(result))
    }

    #[rmcp::tool(
        name = "desktop.capture",
        description = "Capture the selected source, returning one PNG and frame metadata"
    )]
    async fn capture(
        &self,
        Parameters(request): Parameters<Capture>,
    ) -> Result<CallToolResult, ToolFailure> {
        let mut session = self.session.lock().await;
        if let Some(id) = &request.session_id {
            validate_id(id)?;
        }
        if let Some(id) = &request.session_id
            && session.as_ref().is_none_or(|s| s.id() != id)
        {
            return Err(Failure::new(
                "closed-session",
                "Capture session is not owned by this channel",
            )
            .into());
        }
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
                .create_session(source.clone(), false, None, &self.channel.shared.state)
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
            )
            .into());
        }
        let active = session
            .as_mut()
            .ok_or_else(|| Failure::new("closed-session", "No capture session"))?;
        let (frame, png) = active.capture().await?;
        let mut result = CallToolResult::structured(json!({
            "status": "ok",
            "frame": frame,
        }));
        result.content.push(ContentBlock::image(
            base64::engine::general_purpose::STANDARD.encode(png),
            "image/png",
        ));
        Ok(result)
    }

    #[rmcp::tool(
        name = "desktop.input",
        description = "Submit serialized frame-bound input; clipboard paste may remain in \
                       clipboard history"
    )]
    async fn input(
        &self,
        Parameters(request): Parameters<Input>,
    ) -> Result<CallToolResult, ToolFailure> {
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
        let receipt = active.input(request).await?;
        let mut result = json!({"status": "ok"});
        if let Some(receipt) = receipt {
            result["receipt"] = json!(receipt);
        }
        Ok(CallToolResult::structured(result))
    }

    #[rmcp::tool(
        name = "desktop.release",
        description = "Release owned input and close this channel's desktop session"
    )]
    async fn release_session(
        &self,
        Parameters(request): Parameters<Release>,
    ) -> Result<CallToolResult, ToolFailure> {
        let mut session = self.session.lock().await;
        if let Some(id) = &request.session_id {
            validate_id(id)?;
        }
        if request
            .session_id
            .as_ref()
            .is_some_and(|id| session.as_ref().is_none_or(|s| s.id() != id))
        {
            return Err(Failure::new(
                "closed-session",
                "Release session is not owned by this channel",
            )
            .into());
        }
        self.channel.release(&mut session).await;
        Ok(CallToolResult::structured(json!({"status": "ok"})))
    }
}
