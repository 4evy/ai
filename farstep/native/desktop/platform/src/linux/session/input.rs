use std::sync::atomic::Ordering;

use ashpd::desktop::remote_desktop::{KeyState, NotifyPointerAxisOptions};

use super::super::portal::{Handle, InputBackend};
use super::super::protocol::*;
use super::super::{direct, keyboard};
use super::Session;

impl Session {
    pub(super) async fn motion(&mut self, point: &Point) -> Result<()> {
        let (x, y) = self.point(point)?;
        self.submitted = true;
        match &mut self.portal.backend {
            InputBackend::Eis(eis) => {
                eis.motion(
                    self.portal.stream.mapping_id().ok_or_else(|| {
                        Failure::new("mapping-unavailable", "Portal omitted EI mapping identity")
                    })?,
                    x,
                    y,
                )
                .await
            }
            InputBackend::Direct(direct) => direct.send(direct::Command::Motion(x, y)).await,
            InputBackend::Notify { proxy, .. } => {
                let Handle::Remote(session, _) = &self.portal.handle else {
                    return Err(Failure::new("closed-session", "No control session"));
                };
                let (w, h) = self.portal.stream.size().ok_or_else(|| {
                    Failure::new("mapping-unavailable", "Portal omitted logical stream size")
                })?;
                proxy
                    .notify_pointer_motion_absolute(
                        session,
                        self.portal.stream.pipe_wire_node_id(),
                        x * f64::from(w),
                        y * f64::from(h),
                        Default::default(),
                    )
                    .await
                    .map_err(|error| Failure::new("backend-error", error))
            }
            InputBackend::None => Err(Failure::new(
                "authorization-required",
                "Capture-only session has no input authorization",
            )),
        }
    }

    pub(super) async fn button(&mut self, code: u32, pressed: bool) -> Result<()> {
        self.ensure_live()?;
        if self.invalidated() {
            return Err(Failure::new(
                "stale-frame",
                "Frame or geometry generation is stale",
            ));
        }
        self.submitted = true;
        match &mut self.portal.backend {
            InputBackend::Eis(eis) => eis.button(code, pressed).await,
            InputBackend::Direct(direct) => {
                direct.send(direct::Command::Button(code, pressed)).await
            }
            InputBackend::Notify { proxy, buttons, .. } => {
                let Handle::Remote(session, _) = &self.portal.handle else {
                    return Err(Failure::new("closed-session", "No control session"));
                };
                if pressed {
                    buttons.insert(code);
                }
                proxy
                    .notify_pointer_button(
                        session,
                        code as i32,
                        if pressed {
                            KeyState::Pressed
                        } else {
                            KeyState::Released
                        },
                        Default::default(),
                    )
                    .await
                    .map_err(|error| Failure::new("backend-error", error))?;
                if !pressed {
                    buttons.remove(&code);
                }
                Ok(())
            }
            InputBackend::None => Err(Failure::new("authorization-required", "No control session")),
        }
    }

    pub(super) async fn key(&mut self, code: u32, pressed: bool) -> Result<()> {
        self.ensure_live()?;
        self.submitted = true;
        match &mut self.portal.backend {
            InputBackend::Eis(eis) => eis.key(code, pressed).await,
            InputBackend::Direct(direct) => direct.send(direct::Command::Key(code, pressed)).await,
            InputBackend::Notify { proxy, keys, .. } => {
                let Handle::Remote(session, _) = &self.portal.handle else {
                    return Err(Failure::new("closed-session", "No control session"));
                };
                if pressed {
                    keys.insert(code);
                }
                proxy
                    .notify_keyboard_keysym(
                        session,
                        code as i32,
                        if pressed {
                            KeyState::Pressed
                        } else {
                            KeyState::Released
                        },
                        Default::default(),
                    )
                    .await
                    .map_err(|error| Failure::new("backend-error", error))?;
                if !pressed {
                    keys.remove(&code);
                }
                Ok(())
            }
            InputBackend::None => Err(Failure::new("authorization-required", "No control session")),
        }
    }

    pub(super) async fn scroll(&mut self, x: f64, y: f64) -> Result<()> {
        self.ensure_live()?;
        if self.invalidated() {
            return Err(Failure::new(
                "stale-frame",
                "Frame or geometry generation is stale",
            ));
        }
        self.submitted = true;
        match &mut self.portal.backend {
            InputBackend::Eis(eis) => eis.scroll(x, y).await,
            InputBackend::Direct(direct) => direct.send(direct::Command::Scroll(x, y)).await,
            InputBackend::Notify { proxy, .. } => {
                let Handle::Remote(session, _) = &self.portal.handle else {
                    return Err(Failure::new("closed-session", "No control session"));
                };
                proxy
                    .notify_pointer_axis(
                        session,
                        x,
                        y,
                        NotifyPointerAxisOptions::default().set_finish(true),
                    )
                    .await?;
                Ok(())
            }
            InputBackend::None => Err(Failure::new("authorization-required", "No control session")),
        }
    }

    pub(super) async fn keys(&self, chord: Option<&str>) -> Result<Vec<u32>> {
        let symbols = keyboard::chord_symbols(chord)?;
        if symbols.is_empty() {
            return Ok(symbols);
        }
        match &self.portal.backend {
            InputBackend::Eis(eis) => eis.resolve(&symbols).await,
            InputBackend::Direct(direct) => direct.resolve(&symbols),
            _ => Ok(symbols),
        }
    }

    pub async fn release_input(&mut self) {
        self.drag = None;
        match &mut self.portal.backend {
            InputBackend::Eis(eis) => eis.release().await,
            InputBackend::Direct(direct) => {
                let _ = direct.send(direct::Command::Release).await;
            }
            InputBackend::Notify {
                proxy,
                keys,
                buttons,
            } => {
                let Handle::Remote(session, closed) = &self.portal.handle else {
                    return;
                };
                if closed.load(Ordering::Acquire) {
                    keys.clear();
                    buttons.clear();
                    return;
                }
                for code in keys.drain() {
                    let _ = proxy
                        .notify_keyboard_keysym(
                            session,
                            code as i32,
                            KeyState::Released,
                            Default::default(),
                        )
                        .await;
                }
                for code in buttons.drain() {
                    let _ = proxy
                        .notify_pointer_button(
                            session,
                            code as i32,
                            KeyState::Released,
                            Default::default(),
                        )
                        .await;
                }
            }
            InputBackend::None => {}
        }
    }
}
