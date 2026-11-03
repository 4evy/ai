//! Shared desktop MCP routing and connection lifecycle
//!
//! Native APIs, permission prompts, transport authentication and service
//! management belong to the platform backend
#![forbid(unsafe_code)]

#[path = "server/server.rs"]
pub mod server;
pub mod transport;
