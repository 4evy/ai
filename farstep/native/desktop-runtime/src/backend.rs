use std::path::Path;

use farstep_protocol::{Frame, Input, Inspection, Receipt, Result, Source};
use tokio_util::sync::CancellationToken;

pub struct SessionInfo {
    pub id: String,
    pub control: bool,
    pub clipboard: bool,
}

/// Native operations used by the shared MCP server
///
/// Discovery must not prompt for consent or create a session
/// Unsupported operations must report unavailable or return a protocol failure
#[async_trait::async_trait]
pub trait Backend: Send + Sync + 'static {
    fn platform(&self) -> &'static str;
    /// Return a guard that releases the installer maintenance gate on drop
    fn maintenance_gate(&self, state: &Path) -> Result<Box<dyn Send>>;
    async fn inspect(&self, session: Option<SessionInfo>) -> Result<Inspection>;
    /// Create a capture-only or explicitly authorized control session
    async fn create_session(
        &self,
        source: Source,
        control: bool,
        output_name: Option<&str>,
        state: &Path,
    ) -> Result<Box<dyn DesktopSession>>;
    async fn open(&self, uri: &str) -> Result<Box<dyn WorkspaceLease>>;
    async fn system_status(&self) -> Result<serde_json::Value> {
        Err(farstep_protocol::Failure::new(
            "unsupported-operation",
            "Use the platform system helper",
        ))
    }
    async fn system_exec(&self, _: farstep_protocol::SystemExec) -> Result<serde_json::Value> {
        Err(farstep_protocol::Failure::new(
            "unsupported-operation",
            "Use the platform system helper",
        ))
    }
    fn system_commands(&self) -> usize {
        0
    }
}

/// Backend-owned capture and input state for one client connection
///
/// Implementations must reject stale frame mappings, release held input on
/// failure, and retain text receipts when an input future is cancelled
#[async_trait::async_trait]
pub trait DesktopSession: Send {
    fn id(&self) -> &str;
    fn source(&self) -> &Source;
    fn backend_name(&self) -> &'static str;
    fn info(&self) -> SessionInfo;
    fn live(&self) -> bool;
    fn capture_stopped(&self) -> CancellationToken;
    async fn invalidated(&mut self) -> bool;
    fn receipt(&self) -> Option<Receipt>;
    fn reset_receipt(&mut self);
    async fn invalidate(&mut self);
    async fn close(&mut self);
    async fn capture(&mut self) -> Result<(Frame, Vec<u8>)>;
    async fn input(&mut self, input: Input) -> Result<Option<Receipt>>;
}

#[async_trait::async_trait]
pub trait WorkspaceLease: Send {
    fn id(&self) -> &str;
    async fn release(self: Box<Self>) -> Result<()>;
}
