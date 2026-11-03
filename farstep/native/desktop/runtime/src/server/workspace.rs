use farstep_protocol::{Failure, Open, Result, WorkspaceRelease};

use super::Channel;

impl Channel {
    pub(super) async fn open_workspace(&self, request: Open) -> Result<String> {
        let lease = self.shared.backend.open(&request.uri).await?;
        let id = lease.id().to_owned();
        self.workspaces.lock().await.push(lease);
        Ok(id)
    }

    pub(super) async fn release_workspace(&self, request: WorkspaceRelease) -> Result<()> {
        let mut leases = self.workspaces.lock().await;
        let index = leases
            .iter()
            .position(|lease| lease.id() == request.workspace_id)
            .ok_or_else(|| Failure::new("invalid-request", "Unknown owned workspace lease"))?;
        leases.swap_remove(index).release().await
    }
}
