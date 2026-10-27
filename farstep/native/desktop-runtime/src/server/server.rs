mod helper;
mod session;
mod tools;
mod workspace;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use farstep_protocol::*;
use rmcp::handler::server::tool::{IntoCallToolResult, ToolCallContext, ToolRouter};
use rmcp::model::*;
use rmcp::service::RequestContext;
use rmcp::{RoleServer, ServerHandler, ServiceExt};
use serde_json::{Value, json};
use session::SessionOperations;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;
use tools::ToolFailure;

use crate::backend::{Backend, DesktopSession, WorkspaceLease};
use crate::transport;

const SESSION_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

pub struct Shared {
    backend: Arc<dyn Backend>,
    state: PathBuf,
    installation_id: String,
    lease: Arc<Semaphore>,
    sessions: AtomicUsize,
    profiles: Mutex<()>,
    tools: ToolRouter<SessionOperations>,
}

#[derive(Clone)]
pub struct Channel {
    shared: Arc<Shared>,
    control: Arc<Mutex<Option<OwnedSemaphorePermit>>>,
    session: Arc<Mutex<Option<Box<dyn DesktopSession>>>>,
    negotiated: Arc<AtomicBool>,
    closed: CancellationToken,
    workspaces: Arc<Mutex<Vec<Box<dyn WorkspaceLease>>>>,
}

impl Channel {
    async fn finish_tool(
        &self,
        response: &mut CallToolResponse,
        session: &mut Option<Box<dyn DesktopSession>>,
        text: bool,
    ) {
        if let CallToolResponse::Complete(result) = response
            && result.is_error == Some(true)
            && let Some(error) = result.structured_content.as_mut()
        {
            let receipt_added = text && error.get("receipt").is_none();
            if receipt_added {
                error["receipt"] = json!(
                    session
                        .as_ref()
                        .and_then(|s| s.receipt())
                        .unwrap_or_default()
                );
            }
            if matches!(
                error.get("code").and_then(Value::as_str),
                Some("cancelled" | "disconnected" | "closed-session")
            ) {
                self.release(session).await;
            }
            if receipt_added && let Some(error) = result.structured_content.take() {
                *result = CallToolResult::structured_error(error);
            }
        }
    }
}

fn tool_error(error: rmcp::ErrorData) -> CallToolResponse {
    let message = if error.code == ErrorCode::INVALID_PARAMS {
        error.message.into_owned()
    } else {
        "Unknown desktop tool".to_owned()
    };
    CallToolResult::structured_error(Failure::new("invalid-request", message).value()).into()
}

impl ServerHandler for Channel {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("farstep-desktop", env!("CARGO_PKG_VERSION")),
        )
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, rmcp::ErrorData> {
        Ok(ListToolsResult {
            tools: self.shared.tools.list_all(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, rmcp::ErrorData> {
        let text = request.name == "desktop.input"
            && request
                .arguments
                .as_ref()
                .and_then(|args| args.get("action"))
                .and_then(|action| action.get("method"))
                .and_then(Value::as_str)
                == Some("type_text");
        let mut tools = SessionOperations {
            channel: self.clone(),
            session: Mutex::new(None),
        };
        // Health remains responsive while another channel awaits a consent
        // dialog
        if request.name == "helper.health" {
            return Ok(self
                .shared
                .tools
                .call(ToolCallContext::new(&tools, request, context))
                .await
                .unwrap_or_else(tool_error));
        }
        let mut session = self.session.lock().await;
        if text && let Some(session) = session.as_mut() {
            session.reset_receipt();
        }
        // Restore the owned session even when cancellation drops the router
        // future
        *tools.session.get_mut() = session.take();
        let cancelled = context.ct.clone();
        let result = tokio::select! {
            biased;
            _ = self.closed.cancelled() => ToolFailure::from(Failure::new(
                "disconnected",
                "Desktop channel closed",
            )).into_call_tool_result(),
            _ = cancelled.cancelled() => ToolFailure::from(Failure::new(
                "cancelled",
                "Desktop operation cancelled; input is released",
            )).into_call_tool_result(),
            result = async {
                if request.name != "helper.handshake" && !self.negotiated.load(Ordering::Acquire) {
                    return ToolFailure::from(Failure::new(
                        "prerequisite",
                        "Negotiate helper.handshake before desktop operations",
                    )).into_call_tool_result();
                }
                self.shared
                    .tools
                    .call(ToolCallContext::new(&tools, request, context))
                    .await
            } => result,
        };
        *session = tools.session.into_inner();
        let mut result = result.unwrap_or_else(tool_error);
        self.finish_tool(&mut result, &mut session, text).await;
        Ok(result)
    }
}

impl Shared {
    pub fn new(backend: impl Backend, state: PathBuf, installation_id: String) -> Arc<Self> {
        Arc::new(Self {
            backend: Arc::new(backend),
            state,
            installation_id,
            lease: Arc::new(Semaphore::new(1)),
            sessions: AtomicUsize::new(0),
            profiles: Mutex::new(()),
            tools: SessionOperations::router(),
        })
    }
}

impl Channel {
    pub fn new(shared: Arc<Shared>, closed: CancellationToken) -> Self {
        Self {
            shared,
            control: Arc::new(Mutex::new(None)),
            closed,
            session: Arc::new(Mutex::new(None)),
            negotiated: Arc::new(AtomicBool::new(false)),
            workspaces: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Native transports must authenticate the peer before serving a connection
    pub async fn serve_connection<R, W>(self, read: R, write: W)
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let channel = self;
        let watcher = channel.clone();
        let maintenance = AbortOnDropHandle::new(tokio::spawn(async move {
            let mut interval = tokio::time::interval(SESSION_POLL_INTERVAL);
            let mut capture_stopped: Option<CancellationToken> = None;
            loop {
                tokio::select! {
                    _ = watcher.closed.cancelled() => break,
                    _ = interval.tick() => {},
                    Some(()) = async {
                        capture_stopped.as_ref()?.cancelled().await;
                        Some(())
                    } => {
                        capture_stopped = None;
                    },
                }
                let Ok(mut state) = watcher.session.try_lock() else {
                    continue;
                };
                let Some(session) = state.as_mut() else {
                    capture_stopped = None;
                    continue;
                };
                if session.invalidated().await {
                    session.invalidate().await;
                }
                let stopped = session.capture_stopped();
                capture_stopped = (!stopped.is_cancelled()).then_some(stopped);
                if !session.live() {
                    watcher.release(&mut state).await;
                    capture_stopped = None;
                }
            }
        }));
        let transport = (
            transport::BoundedIo::new(read, MAX_REQUEST, channel.closed.clone()),
            transport::BoundedIo::new(write, MAX_RESPONSE, channel.closed.clone()),
        );
        if let Ok(service) = channel.clone().serve(transport).await {
            let cancellation = service.cancellation_token();
            tokio::select! {
                _ = service.waiting() => {},
                _ = channel.closed.cancelled() => {
                    cancellation.cancel();
                },
            }
        }
        channel.closed.cancel();
        drop(maintenance);
        channel.release(&mut *channel.session.lock().await).await;
        for lease in channel.workspaces.lock().await.drain(..) {
            let _ = lease.release().await;
        }
    }
}
