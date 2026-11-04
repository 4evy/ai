use std::sync::atomic::Ordering;
use std::time::Duration;

use super::super::portal::InputBackend;
use super::super::protocol::*;
use super::Session;

// Linux input-event button codes used by EI, Wayland and the portal
const BTN_LEFT: u32 = 0x110;
const BTN_RIGHT: u32 = 0x111;
const BTN_MIDDLE: u32 = 0x112;
const INPUT_POLL_INTERVAL: Duration = Duration::from_millis(25);
const DEFAULT_SCROLL_PIXELS: f64 = 100.0;

impl Session {
    pub async fn input(&mut self, input: Input) -> Result<Option<Receipt>> {
        let is_text = matches!(&input.action, Action::TypeText(_));
        if !is_text {
            self.last_receipt = None;
        } else if self.last_receipt.is_none() {
            self.reset_receipt();
        }
        self.submitted = false;
        let live = self.portal.live.clone();
        let stopped = self.portal.capture.stopped.clone();
        let capture_generation = self.portal.capture.generation.clone();
        let capture_before = capture_generation.load(Ordering::Acquire);
        let input_generation = match &self.portal.backend {
            InputBackend::Eis(e) => Some(e.generation.clone()),
            InputBackend::Direct(d) => Some(d.generation.clone()),
            _ => None,
        };
        let input_before = input_generation.as_ref().map(|g| g.load(Ordering::Acquire));
        let pointer = input.action.pointer();
        let result = tokio::select! {
            biased;
            _ = stopped.cancelled() => Err(Failure::new("disconnected", "PipeWire stream stopped")),
            result = self.perform(input) => result,
            error = async {
                let mut interval = tokio::time::interval(INPUT_POLL_INTERVAL);
                loop {
                    interval.tick().await;
                    if !live.load(Ordering::Acquire) {
                        break Failure::new("closed-session", "Portal revoked the session");
                    }
                    if input_generation.as_ref().map(|g| g.load(Ordering::Acquire)) != input_before
                        || (pointer && capture_generation.load(Ordering::Acquire) != capture_before)
                    {
                        break Failure::new(
                            "stale-frame",
                            "Input device or capture geometry changed during the action",
                        );
                    }
                }
            } => Err(error),
        };
        let result = result.and_then(|receipt| {
            self.ensure_live()?;
            Ok(receipt)
        });
        match result {
            Err(mut error) => {
                self.release_input().await;
                if is_text && error.receipt.is_none() {
                    error.receipt = self.receipt();
                }
                if self.submitted && !is_text {
                    error.message = format!(
                        "{}: {}. Input may already have been submitted",
                        error.code, error.message
                    );
                    error.code = "partial-input";
                }
                Err(error)
            }
            ok => ok,
        }
    }

    async fn validate_pointer(&self, input: &Input) -> Result<()> {
        if !input.action.pointer() {
            return Ok(());
        }
        let latest = self
            .latest
            .as_ref()
            .ok_or_else(|| Failure::new("stale-frame", "No current actionable frame"))?;
        let reference = input.frame.as_ref().ok_or_else(|| {
            Failure::new(
                "invalid-request",
                "Pointer actions require frame identifiers",
            )
        })?;
        if reference.frame_id != latest.frame.frame_id
            || reference.stream_id != latest.frame.stream_id
            || self.invalidated()
        {
            return Err(Failure::new(
                "stale-frame",
                "Frame or geometry generation is stale",
            ));
        }
        if latest.frame.logical_geometry.is_none() {
            return Err(Failure::new(
                "mapping-unavailable",
                "Captured source has no authoritative input geometry",
            ));
        }
        if let InputBackend::Eis(eis) = &self.portal.backend {
            eis.mapping(self.portal.stream.mapping_id().ok_or_else(|| {
                Failure::new("mapping-unavailable", "Portal omitted EI mapping identity")
            })?)
            .await?;
        }
        input
            .action
            .points()
            .try_for_each(|point| self.point(&point).map(|_| ()))
    }

    fn validate_drag(&self, action: &Action) -> Result<()> {
        match action {
            Action::DragMove(a) if self.drag.as_deref() != Some(&a.handle_id) => {
                return Err(Failure::new("invalid-request", "Drag handle is not active"));
            }
            Action::DragEnd(a) if self.drag.as_deref() != Some(&a.handle_id) => {
                return Err(Failure::new("invalid-request", "Drag handle is not active"));
            }
            Action::DragMove(_) | Action::DragEnd(_) => {}
            _ if self.drag.is_some() => {
                return Err(Failure::new("busy", "A drag is already active"));
            }
            _ => {}
        }
        Ok(())
    }

    async fn perform(&mut self, input: Input) -> Result<Option<Receipt>> {
        input.action.validate()?;
        if input.session_id != self.id {
            return Err(Failure::new(
                "closed-session",
                "Session is not owned by this channel",
            ));
        }
        if !self.control() {
            return Err(Failure::new(
                "authorization-required",
                "Authorize a combined session and capture again",
            ));
        }
        self.ensure_live()?;
        self.validate_pointer(&input).await?;
        self.validate_drag(&input.action)?;
        if let Action::TypeText(text) = input.action {
            return self.text(text).await.map(Some);
        }
        let keys = self.keys(input.action.chord()).await?;
        for code in &keys {
            self.key(*code, true).await?;
        }
        match input.action {
            Action::Click(a) => {
                self.motion(&Point { x: a.x, y: a.y }).await?;
                let code = match a.mouse_button.unwrap_or_default() {
                    MouseButton::Right => BTN_RIGHT,
                    MouseButton::Middle => BTN_MIDDLE,
                    MouseButton::Left => BTN_LEFT,
                };
                for _ in 0..a.click_count.unwrap_or(1) {
                    self.button(code, true).await?;
                    hold(a.duration).await?;
                    self.button(code, false).await?;
                }
            }
            Action::Move(a) => self.motion(&Point { x: a.x, y: a.y }).await?,
            Action::PressKey(a) => hold(a.duration).await?,
            Action::Scroll(a) => {
                if let (Some(x), Some(y)) = (a.x, a.y) {
                    self.motion(&Point { x, y }).await?;
                }
                let (x, y) = a.direction.delta(a.pixels.unwrap_or(DEFAULT_SCROLL_PIXELS));
                self.scroll(x, y).await?;
            }
            Action::Drag(a) => {
                self.motion(&a.path[0]).await?;
                self.button(BTN_LEFT, true).await?;
                for point in &a.path[1..] {
                    self.motion(point).await?;
                }
                self.button(BTN_LEFT, false).await?;
            }
            Action::DragStart(a) => {
                self.motion(&a.point).await?;
                self.button(BTN_LEFT, true).await?;
                self.drag = Some(a.handle_id);
            }
            Action::DragMove(a) => self.motion(&a.point).await?,
            Action::DragEnd(_) => {
                self.button(BTN_LEFT, false).await?;
                self.drag = None;
            }
            Action::TypeText(_) => {
                return Err(Failure::new(
                    "backend-error",
                    "Text action reached pointer and key dispatch",
                ));
            }
        }
        for code in keys.iter().rev() {
            self.key(*code, false).await?;
        }
        Ok(None)
    }
}
async fn hold(duration: Option<f64>) -> Result<()> {
    let duration = Duration::try_from_secs_f64(duration.unwrap_or(0.0) / MILLIS_PER_SECOND)
        .map_err(|e| Failure::new("invalid-request", e))?;
    tokio::time::sleep(duration).await;
    Ok(())
}
