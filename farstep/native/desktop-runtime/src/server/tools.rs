use base64::Engine;
use farstep_protocol::*;
use rmcp::handler::server::tool::IntoCallToolResult;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::*;
use serde_json::{Value, json};

use super::session::SessionOperations;

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

#[rmcp::tool_router(router = router, vis = "pub(super)")]
impl SessionOperations {
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
        Ok(CallToolResult::structured(self.channel.handshake()))
    }

    #[rmcp::tool(
        name = "helper.health",
        description = "Inspect active lease, desktop sessions and system commands without effects"
    )]
    async fn health(
        &self,
        Parameters(_): Parameters<Empty>,
    ) -> Result<CallToolResult, ToolFailure> {
        Ok(CallToolResult::structured(self.channel.health()))
    }

    #[rmcp::tool(
        name = "desktop.inspect",
        description = "Discover available, requestable and granted operations without consent"
    )]
    async fn inspect(
        &self,
        Parameters(_): Parameters<Empty>,
    ) -> Result<CallToolResult, ToolFailure> {
        Ok(CallToolResult::structured(json!(
            self.inspect_session().await?
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
        let id = self.channel.open_workspace(request).await?;
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
        self.channel.release_workspace(request).await?;
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
        Ok(CallToolResult::structured(
            self.authorize_session(request).await?,
        ))
    }

    #[rmcp::tool(
        name = "desktop.capture",
        description = "Capture the selected source, returning one PNG and frame metadata"
    )]
    async fn capture(
        &self,
        Parameters(request): Parameters<Capture>,
    ) -> Result<CallToolResult, ToolFailure> {
        let (frame, png) = self.capture_frame(request).await?;
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
        let receipt = self.submit_input(request).await?;
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
        self.release_owned_session(request).await?;
        Ok(CallToolResult::structured(json!({"status": "ok"})))
    }
}
