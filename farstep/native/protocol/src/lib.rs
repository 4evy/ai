//! Native desktop wire types and validation shared across platform backends
#![forbid(unsafe_code)]

mod input;

pub use input::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MAX_REQUEST: usize = 1024 * 1024;

pub const MAX_RESPONSE: usize = 46 * 1024 * 1024;

pub const MAX_PNG: usize = 32 * 1024 * 1024;

pub const MAX_PIXELS: u64 = 100_000_000;

pub const PROTOCOL_MAJOR: u32 = 1;
pub const MAX_ID_BYTES: usize = 1024;
pub const MAX_URI_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename = "error")]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Receipt>,
}

pub type Result<T, E = Failure> = std::result::Result<T, E>;

impl Failure {
    pub fn new(code: &'static str, message: impl ToString) -> Self {
        Self {
            code,
            message: message.to_string(),
            receipt: None,
        }
    }

    pub fn value(self) -> Value {
        json!(self)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    Monitor,
    Window,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameRef {
    pub stream_id: String,
    pub frame_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub mechanism: &'static str,
    pub clipboard_changed: bool,
    pub submitted_bytes: usize,
    pub partial: bool,
}

impl Default for Receipt {
    fn default() -> Self {
        Self {
            mechanism: "none",
            clipboard_changed: false,
            submitted_bytes: 0,
            partial: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub session_id: String,
    pub stream_id: String,
    pub frame_id: String,
    pub source: Source,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    pub logical_geometry: Option<Geometry>,
    pub transform: u32,
    pub mapping_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub status: &'static str,
    pub operations: Vec<OperationAvailability>,
    pub sources: Vec<Source>,
    pub session_id: Option<String>,
}

#[derive(Serialize)]
pub struct OperationAvailability {
    pub operation: &'static str,
    pub available: bool,
    pub requestable: bool,
    pub granted: bool,
    pub backend: Option<String>,
    pub reason: Option<String>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Empty {}
#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct SystemExec {
    pub command: String,
    pub cwd: String,
    pub timeout: u32,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Open {
    pub uri: String,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRelease {
    pub workspace_id: String,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authorize {
    pub source: Source,
    pub output_name: Option<String>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub session_id: Option<String>,
    pub source: Option<Source>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub session_id: Option<String>,
}

pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > MAX_ID_BYTES {
        Err(Failure::new(
            "invalid-request",
            format!("Identifier must contain 1–{MAX_ID_BYTES} bytes"),
        ))
    } else {
        Ok(())
    }
}
