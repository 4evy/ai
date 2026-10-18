use serde::Deserialize;

use super::{Failure, FrameRef, Point, Result, validate_id};

pub const MILLIS_PER_SECOND: f64 = 1000.0;

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub session_id: String,
    pub frame: Option<FrameRef>,
    pub action: Action,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "method",
    content = "input",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Action {
    Click(Click),
    Move(Move),
    PressKey(PressKey),
    TypeText(TypeText),
    Scroll(Scroll),
    Drag(Drag),
    DragStart(DragPoint),
    DragMove(DragPoint),
    DragEnd(DragEnd),
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Click {
    pub x: f64,
    pub y: f64,
    pub click_count: Option<u32>,
    pub duration: Option<f64>,
    pub key: Option<String>,
    #[cfg_attr(feature = "schema", schemars(with = "Option<String>"))]
    pub mouse_button: Option<MouseButton>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    #[default]
    #[serde(alias = "l")]
    Left,
    #[serde(alias = "r")]
    Right,
    #[serde(alias = "m")]
    Middle,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    #[serde(alias = "u")]
    Up,
    #[serde(alias = "d")]
    Down,
    #[serde(alias = "l")]
    Left,
    #[serde(alias = "r")]
    Right,
}

impl ScrollDirection {
    pub fn horizontal(self) -> bool {
        matches!(self, Self::Left | Self::Right)
    }

    pub fn sign(self) -> i32 {
        match self {
            Self::Up | Self::Left => -1,
            Self::Down | Self::Right => 1,
        }
    }

    pub fn delta(self, pixels: f64) -> (f64, f64) {
        let amount = pixels * f64::from(self.sign());
        if self.horizontal() {
            (amount, 0.0)
        } else {
            (0.0, amount)
        }
    }
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Move {
    pub x: f64,
    pub y: f64,
    pub key: Option<String>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct PressKey {
    pub key: String,
    pub duration: Option<f64>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct TypeText {
    pub text: String,
    pub paste_key: Option<String>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Scroll {
    #[cfg_attr(feature = "schema", schemars(with = "String"))]
    pub direction: ScrollDirection,
    pub pixels: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub key: Option<String>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Drag {
    pub path: Vec<Point>,
    pub key: Option<String>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct DragPoint {
    pub handle_id: String,
    pub point: Point,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct DragEnd {
    pub handle_id: String,
}

impl Action {
    /// Explicit pointer coordinates in submission order
    pub fn points(&self) -> impl Iterator<Item = Point> + '_ {
        let mut path: &[Point] = &[];
        let point = match self {
            Self::Click(a) => Some(Point { x: a.x, y: a.y }),
            Self::Move(a) => Some(Point { x: a.x, y: a.y }),
            Self::Scroll(a) => a.x.zip(a.y).map(|(x, y)| Point { x, y }),
            Self::Drag(a) => {
                path = &a.path;
                None
            }
            Self::DragStart(a) | Self::DragMove(a) => Some(a.point),
            Self::PressKey(_) | Self::TypeText(_) | Self::DragEnd(_) => None,
        };
        path.iter().copied().chain(point)
    }

    pub fn pointer(&self) -> bool {
        !matches!(self, Self::PressKey(_) | Self::TypeText(_))
    }

    pub fn chord(&self) -> Option<&str> {
        match self {
            Self::Click(a) => a.key.as_deref(),
            Self::Move(a) => a.key.as_deref(),
            Self::PressKey(a) => Some(&a.key),
            Self::Scroll(a) => a.key.as_deref(),
            Self::Drag(a) => a.key.as_deref(),
            _ => None,
        }
    }

    pub fn validate(&self) -> Result<()> {
        let valid_duration = |v: Option<f64>| {
            v.is_none_or(|v| {
                v.is_finite()
                    && v >= 0.0
                    && std::time::Duration::try_from_secs_f64(v / MILLIS_PER_SECOND).is_ok()
            })
        };
        let valid = self.points().all(|p| p.x.is_finite() && p.y.is_finite())
            && match self {
                Self::Click(a) => valid_duration(a.duration) && a.click_count != Some(0),
                Self::Move(_) => true,
                Self::PressKey(a) => !a.key.is_empty() && valid_duration(a.duration),
                Self::TypeText(a) => !a.text.contains('\0'),
                Self::Scroll(a) => a.x.is_some() == a.y.is_some() && valid_duration(a.pixels),
                Self::Drag(a) => a.path.len() >= 2,
                Self::DragStart(a) | Self::DragMove(a) => validate_id(&a.handle_id).is_ok(),
                Self::DragEnd(a) => validate_id(&a.handle_id).is_ok(),
            };
        if valid {
            Ok(())
        } else {
            Err(Failure::new("invalid-request", "Invalid action parameters"))
        }
    }
}
