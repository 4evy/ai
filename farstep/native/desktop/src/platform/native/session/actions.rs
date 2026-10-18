#[cfg(target_os = "macos")]
use enigo::Coordinate;
use enigo::{Axis, Button, Direction, Enigo, Keyboard, Mouse};
use farstep_protocol::*;

use super::super::failure;
use super::super::keyboard::chord;
#[cfg(target_os = "windows")]
use super::super::os;
use super::Session;

const DEFAULT_HOLD_MILLIS: f64 = 20.0;
const MAX_HOLD_MILLIS: f64 = 60_000.0;
const MAX_CLICK_COUNT: u32 = 10;
const CLICK_INTERVAL_MILLIS: f64 = 30.0;
const DRAG_INTERVAL_MILLIS: f64 = 16.0;
const DEFAULT_SCROLL_PIXELS: f64 = 120.0;
const PIXELS_PER_SCROLL_STEP: f64 = 40.0;

impl Session {
    fn controller(&mut self) -> Result<&mut Enigo> {
        self.input
            .as_mut()
            .ok_or_else(|| Failure::new("permission-denied", "Authorize a control session first"))
    }

    fn position(&mut self, x: f64, y: f64) -> Result<()> {
        let (_, bounds) = self
            .latest
            .as_ref()
            .ok_or_else(|| Failure::new("stale-frame", "Capture a frame before pointer input"))?;
        if !(0.0..f64::from(bounds.pixels_width)).contains(&x)
            || !(0.0..f64::from(bounds.pixels_height)).contains(&y)
        {
            return Err(Failure::new(
                "invalid-request",
                "Pointer is outside the captured image",
            ));
        }
        let x = bounds.x + x * bounds.width / f64::from(bounds.pixels_width);
        let y = bounds.y + y * bounds.height / f64::from(bounds.pixels_height);
        #[cfg(target_os = "windows")]
        {
            os::move_pointer(x.round() as i32, y.round() as i32)
        }
        #[cfg(target_os = "macos")]
        self.controller()?
            .move_mouse(x.round() as i32, y.round() as i32, Coordinate::Abs)
            .map_err(failure)
    }

    fn button(&mut self, button: Button, direction: Direction) -> Result<()> {
        if direction == Direction::Press {
            self.buttons.push(button);
        }
        self.controller()?
            .button(button, direction)
            .map_err(failure)?;
        if direction == Direction::Release {
            self.buttons.retain(|b| *b != button);
        }
        Ok(())
    }

    pub(super) async fn action(&mut self, action: Action) -> Result<Option<Receipt>> {
        let chord = action.chord().map(chord).transpose()?.unwrap_or_default();
        for key in &chord {
            self.keys.push(*key);
            self.controller()?
                .key(*key, Direction::Press)
                .map_err(failure)?;
        }
        match action {
            Action::Move(a) => self.position(a.x, a.y)?,
            Action::Click(a) => self.click(a).await?,
            Action::PressKey(a) => hold(a.duration).await,
            Action::TypeText(a) => self.text(a)?,
            Action::Scroll(a) => self.scroll(a)?,
            Action::Drag(a) => self.drag(a).await?,
            Action::DragStart(a) => {
                if self.drag.is_some() {
                    return Err(Failure::new("busy", "A drag is already active"));
                }
                self.position(a.point.x, a.point.y)?;
                self.button(Button::Left, Direction::Press)?;
                self.drag = Some(a.handle_id);
            }
            Action::DragMove(a) => {
                if self.drag.as_deref() != Some(&a.handle_id) {
                    return Err(Failure::new("invalid-request", "Unknown drag handle"));
                }
                self.position(a.point.x, a.point.y)?;
            }
            Action::DragEnd(a) => {
                if self.drag.as_deref() != Some(&a.handle_id) {
                    return Err(Failure::new("invalid-request", "Unknown drag handle"));
                }
                self.button(Button::Left, Direction::Release)?;
                self.drag = None;
            }
        }
        for key in chord.into_iter().rev() {
            self.controller()?
                .key(key, Direction::Release)
                .map_err(failure)?;
            self.keys.retain(|k| *k != key);
        }
        Ok(self.receipt.clone())
    }

    async fn click(&mut self, action: Click) -> Result<()> {
        self.position(action.x, action.y)?;
        let button = match action.mouse_button.unwrap_or_default() {
            MouseButton::Right => Button::Right,
            MouseButton::Middle => Button::Middle,
            MouseButton::Left => Button::Left,
        };
        for _ in 0..action.click_count.unwrap_or(1).min(MAX_CLICK_COUNT) {
            self.button(button, Direction::Press)?;
            hold(action.duration).await;
            self.button(button, Direction::Release)?;
            hold(Some(CLICK_INTERVAL_MILLIS)).await;
        }
        Ok(())
    }

    fn text(&mut self, action: TypeText) -> Result<()> {
        if action.paste_key.is_some() {
            return Err(Failure::new(
                "unsupported-operation",
                "paste_key requires a clipboard backend; omit it for Unicode text input",
            ));
        }
        let input = self.input.as_mut().ok_or_else(|| {
            Failure::new("permission-denied", "Authorize a control session first")
        })?;
        let receipt = self.receipt.insert(Receipt {
            mechanism: "native-unicode",
            partial: true,
            ..Receipt::default()
        });
        let mut utf8 = [0; 4];
        for character in action.text.chars() {
            input
                .text(character.encode_utf8(&mut utf8))
                .map_err(failure)?;
            receipt.submitted_bytes += character.len_utf8();
        }
        receipt.partial = false;
        Ok(())
    }

    fn scroll(&mut self, action: Scroll) -> Result<()> {
        if let (Some(x), Some(y)) = (action.x, action.y) {
            self.position(x, y)?;
        }
        let amount = (action.pixels.unwrap_or(DEFAULT_SCROLL_PIXELS) / PIXELS_PER_SCROLL_STEP)
            .ceil()
            .min(f64::from(i32::MAX)) as i32
            * action.direction.sign();
        self.controller()?
            .scroll(
                amount,
                if action.direction.horizontal() {
                    Axis::Horizontal
                } else {
                    Axis::Vertical
                },
            )
            .map_err(failure)?;
        Ok(())
    }

    async fn drag(&mut self, action: Drag) -> Result<()> {
        self.position(action.path[0].x, action.path[0].y)?;
        self.button(Button::Left, Direction::Press)?;
        for point in &action.path[1..] {
            self.position(point.x, point.y)?;
            hold(Some(DRAG_INTERVAL_MILLIS)).await;
        }
        self.button(Button::Left, Direction::Release)?;
        Ok(())
    }
}
async fn hold(ms: Option<f64>) {
    tokio::time::sleep(std::time::Duration::from_secs_f64(
        ms.unwrap_or(DEFAULT_HOLD_MILLIS).min(MAX_HOLD_MILLIS) / MILLIS_PER_SECOND,
    ))
    .await;
}
