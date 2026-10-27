use std::sync::atomic::Ordering;

use farstep_protocol::PROTOCOL_MAJOR;
use serde_json::{Value, json};

use super::Channel;

impl Channel {
    pub(super) fn handshake(&self) -> Value {
        self.negotiated.store(true, Ordering::Release);
        json!({
            "protocolMajor": PROTOCOL_MAJOR,
            "version": env!("CARGO_PKG_VERSION"),
            "installationId": self.shared.installation_id,
            "platform": self.shared.backend.platform(),
            "capabilities": ["desktop", "bounded-png", "frame-bound-input", "text-receipts"],
        })
    }

    pub(super) fn health(&self) -> Value {
        json!({
            "controlLeaseActive": self.shared.lease.available_permits() == 0,
            "sessions": self.shared.sessions.load(Ordering::Acquire),
            "systemCommands": self.shared.backend.system_commands(),
        })
    }
}
