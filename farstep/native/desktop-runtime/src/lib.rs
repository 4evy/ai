//! Shared desktop MCP routing and connection lifecycle
//!
//! Native APIs, permission prompts, transport authentication and service
//! management belong to the platform backend
#![forbid(unsafe_code)]

#[cfg(feature = "backend")]
pub mod backend;
#[cfg(feature = "image")]
#[path = "image/image.rs"]
pub mod image;
#[cfg(feature = "server")]
#[path = "server/server.rs"]
pub mod server;
#[cfg(feature = "server")]
pub mod transport;
