mod actions;

use enigo::{Button, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use farstep_desktop_runtime::backend::{DesktopSession, SessionInfo};
use farstep_protocol::*;
use tokio_util::sync::CancellationToken;

use super::{Bounds, failure, os};

pub struct Session {
    id: String,
    stream: String,
    source: Source,
    target: os::Target,
    input: Option<Enigo>,
    latest: Option<(String, Bounds)>,
    drag: Option<String>,
    buttons: Vec<Button>,
    keys: Vec<Key>,
    receipt: Option<Receipt>,
    stopped: CancellationToken,
}

impl Session {
    pub fn new(source: Source, target: os::Target, control: bool) -> Result<Self> {
        let input = control
            .then(|| {
                Enigo::new(&Settings {
                    open_prompt_to_get_permissions: false,
                    ..Settings::default()
                })
            })
            .transpose()
            .map_err(failure)?;
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            stream: uuid::Uuid::new_v4().to_string(),
            source,
            target,
            input,
            latest: None,
            drag: None,
            buttons: Vec::new(),
            keys: Vec::new(),
            receipt: None,
            stopped: CancellationToken::new(),
        })
    }

    fn release(&mut self) {
        if let Some(input) = &mut self.input {
            for button in self.buttons.drain(..).rev() {
                let _ = input.button(button, Direction::Release);
            }
            for key in self.keys.drain(..).rev() {
                let _ = input.key(key, Direction::Release);
            }
        }
        self.drag = None;
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.release();
    }
}

#[async_trait::async_trait]
impl DesktopSession for Session {
    fn id(&self) -> &str {
        &self.id
    }

    fn source(&self) -> &Source {
        &self.source
    }

    fn backend_name(&self) -> &'static str {
        os::BACKEND
    }

    fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            control: self.input.is_some(),
            clipboard: false,
        }
    }

    fn live(&self) -> bool {
        !self.stopped.is_cancelled() && os::capture_granted()
    }

    fn capture_stopped(&self) -> CancellationToken {
        self.stopped.clone()
    }

    async fn invalidated(&mut self) -> bool {
        if !self.live() || (self.input.is_some() && !os::input_granted()) {
            return true;
        }
        let Some((_, bounds)) = &self.latest else {
            return false;
        };
        #[cfg(target_os = "macos")]
        let current = self.target.bounds().await;
        #[cfg(target_os = "windows")]
        let current = self.target.bounds();
        current.as_ref().ok() != Some(bounds)
    }

    fn receipt(&self) -> Option<Receipt> {
        self.receipt.clone()
    }

    fn reset_receipt(&mut self) {
        self.receipt = Some(Receipt::default());
    }

    async fn invalidate(&mut self) {
        self.release();
        self.latest = None;
    }

    async fn close(&mut self) {
        self.release();
        self.input = None;
        self.latest = None;
        self.stopped.cancel();
    }

    async fn capture(&mut self) -> Result<(Frame, Vec<u8>)> {
        #[cfg(target_os = "macos")]
        let image = self.target.capture().await;
        #[cfg(target_os = "windows")]
        let image = {
            let target = self.target;
            tokio::task::spawn_blocking(move || target.capture())
                .await
                .map_err(failure)
                .and_then(std::convert::identity)
        };
        let (bounds, png) = match image {
            Ok(image) => image,
            Err(error) => {
                self.invalidate().await;
                return Err(error);
            }
        };
        if self.latest.as_ref().is_some_and(|(_, old)| old != &bounds) {
            self.release();
        }
        let id = uuid::Uuid::new_v4().to_string();
        let frame = Frame {
            session_id: self.id.clone(),
            stream_id: self.stream.clone(),
            frame_id: id.clone(),
            source: self.source.clone(),
            width: bounds.pixels_width,
            height: bounds.pixels_height,
            bytes: png.len(),
            logical_geometry: Some(Geometry {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
            }),
            transform: 0,
            mapping_id: Some(self.target.id()),
        };
        self.latest = Some((id, bounds));
        Ok((frame, png))
    }

    async fn input(&mut self, request: Input) -> Result<Option<Receipt>> {
        request.action.validate()?;
        if self.input.is_none() {
            return Err(Failure::new(
                "permission-denied",
                "Authorize a control session first",
            ));
        }
        if request.session_id != self.id {
            return Err(Failure::new(
                "closed-session",
                "Session identity does not match",
            ));
        }
        if self.invalidated().await {
            self.invalidate().await;
            return Err(Failure::new(
                "stale-frame",
                "Permissions or source geometry changed; capture again",
            ));
        }
        if request.action.pointer()
            && !request.frame.as_ref().is_some_and(|f| {
                f.stream_id == self.stream
                    && self
                        .latest
                        .as_ref()
                        .is_some_and(|(id, _)| f.frame_id == *id)
            })
        {
            self.release();
            return Err(Failure::new(
                "stale-frame",
                "Pointer input requires the latest frame from this session",
            ));
        }
        let result = self.action(request.action).await;
        if result.is_err() {
            self.release();
        }
        result
    }
}
