use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize, Serialize)]
pub(crate) struct ManagedSpace {
    #[serde(rename = "ManagedSpaceID")]
    pub(crate) id: u64,
    pub(crate) uuid: String,
    // Preserve native diagnostic fields when printing workspace snapshots
    #[serde(flatten)]
    metadata: Map<String, Value>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Display {
    #[serde(rename = "Display Identifier")]
    pub(crate) identifier: String,
    #[serde(rename = "Spaces")]
    pub(crate) spaces: Vec<ManagedSpace>,
    #[serde(rename = "Current Space")]
    pub(crate) current_space: ManagedSpace,
    #[serde(flatten)]
    metadata: Map<String, Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub(crate) displays: Vec<Display>,
    pub(crate) frontmost_pid: Option<i32>,
}

impl Snapshot {
    pub(crate) fn current_spaces(&self) -> impl Iterator<Item = (&str, u64)> {
        self.displays
            .iter()
            .map(|display| (display.identifier.as_str(), display.current_space.id))
    }
}

#[derive(Serialize)]
pub(crate) struct OwnedSpace {
    pub(crate) id: u64,
    pub(crate) uuid: String,
    pub(crate) display: String,
}

pub(crate) struct CreatedSpace {
    pub(crate) space: OwnedSpace,
    // The caller must retain ownership even if closing Mission Control fails
    pub(crate) mission_control_closed: bool,
}

pub(crate) enum Removal {
    Removed,
    Active,
    Occupied,
    Unavailable,
}

impl Removal {
    pub(crate) fn retained_reason(self) -> Option<&'static str> {
        match self {
            Self::Removed => None,
            Self::Active => Some("it is active"),
            Self::Occupied => Some("it still contains windows"),
            Self::Unavailable => Some("Mission Control could not remove it"),
        }
    }
}

pub(crate) struct Handler {
    pub(crate) executable: String,
    pub(crate) bundle: String,
}

#[derive(Deserialize)]
pub(crate) struct Window {
    #[serde(rename = "kCGWindowNumber")]
    pub(crate) id: u64,
    #[serde(rename = "kCGWindowOwnerPID")]
    pub(crate) owner_pid: i32,
    #[serde(rename = "kCGWindowLayer")]
    pub(crate) layer: i32,
}
