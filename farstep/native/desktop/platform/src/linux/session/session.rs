mod actions;
mod frames;
mod input;
mod text;

use std::sync::atomic::Ordering;

use super::portal::{InputBackend, Portal};
use super::protocol::*;
use super::{capture, clipboard};

struct Latest {
    frame: Frame,
    geometry: capture::Geometry,
    capture_generation: u64,
    input_generation: u64,
}

pub struct Session {
    pub id: String,
    pub source: Source,
    pub portal: Portal,
    last_receipt: Option<std::sync::Arc<std::sync::Mutex<Receipt>>>,
    submitted: bool,
    latest: Option<Latest>,
    capture_input_generation: u64,
    drag: Option<String>,
    clipboard: Option<clipboard::Owner>,
}

impl Session {
    pub fn new(source: Source, portal: Portal) -> Self {
        let mut session = Self {
            id: uuid::Uuid::new_v4().to_string(),
            source,
            portal,
            latest: None,
            capture_input_generation: 0,
            drag: None,
            clipboard: None,
            last_receipt: None,
            submitted: false,
        };
        session.capture_input_generation = session.input_generation();
        session
    }

    pub fn receipt(&self) -> Option<Receipt> {
        self.last_receipt
            .as_ref()
            .and_then(|r| r.lock().ok().map(|r| r.clone()))
    }

    pub fn reset_receipt(&mut self) {
        self.last_receipt = Some(std::sync::Arc::new(std::sync::Mutex::new(
            Receipt::default(),
        )));
    }

    fn set_receipt(&self, receipt: &Receipt) {
        if let Some(shared) = &self.last_receipt
            && let Ok(mut value) = shared.lock()
        {
            *value = receipt.clone();
        }
    }

    pub fn control(&self) -> bool {
        !matches!(self.portal.backend, InputBackend::None)
    }

    fn input_generation(&self) -> u64 {
        match &self.portal.backend {
            InputBackend::Eis(e) => e.generation.load(Ordering::Acquire),
            InputBackend::Direct(d) => d.generation.load(Ordering::Acquire),
            _ => 0,
        }
    }

    fn ensure_live(&self) -> Result<()> {
        if !self.portal.live.load(Ordering::Acquire) {
            return Err(Failure::new(
                "closed-session",
                "Portal session was closed or its owner changed",
            ));
        }
        self.portal.capture.ensure_live()
    }

    pub fn invalidated(&self) -> bool {
        !self.portal.live.load(Ordering::Acquire)
            || self.latest.as_ref().is_some_and(|f| {
                self.portal.capture.stopped.is_cancelled()
                    || f.capture_generation
                        != self.portal.capture.generation.load(Ordering::Acquire)
                    || f.input_generation != self.input_generation()
            })
    }

    pub async fn invalidate(&mut self) {
        self.release_input().await;
        self.latest = None;
    }

    pub async fn close(&mut self) {
        self.release_input().await;
        self.clipboard = None;
        self.portal.handle.close().await;
    }
}
