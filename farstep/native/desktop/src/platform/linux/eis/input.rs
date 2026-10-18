use reis::ei;
use reis::event::DeviceCapability;
use xkbcommon::xkb;

use super::super::protocol::{Failure, Result};
use super::super::{XKB_KEYCODE_OFFSET, keyboard};
use super::Eis;

impl Eis {
    pub async fn mapping(&self, mapping: &str) -> Result<()> {
        let state = self.state.lock().await;
        if let Some(code) = state.failure {
            return Err(Failure::new(code, "EI connection ended"));
        }
        let count = state
            .devices
            .iter()
            .filter(|(d, s)| s.resumed && d.has_capability(DeviceCapability::PointerAbsolute))
            .flat_map(|(d, _)| d.regions())
            .filter(|r| r.mapping_id.as_deref() == Some(mapping))
            .count();
        if count != 1 {
            return Err(Failure::new(
                "mapping-unavailable",
                "Stream has no unique resumed EI region",
            ));
        }
        Ok(())
    }

    pub async fn geometry(&self, mapping: &str) -> Result<super::super::protocol::Geometry> {
        self.mapping(mapping).await?;
        let state = self.state.lock().await;
        let region = state
            .devices
            .iter()
            .filter(|(_, s)| s.resumed)
            .flat_map(|(device, _)| device.regions())
            .find(|region| region.mapping_id.as_deref() == Some(mapping))
            .ok_or_else(|| Failure::new("mapping-unavailable", "EI region changed"))?;
        Ok(super::super::protocol::Geometry {
            x: f64::from(region.x),
            y: f64::from(region.y),
            width: f64::from(region.width),
            height: f64::from(region.height),
        })
    }

    pub async fn motion(&self, mapping: &str, x: f64, y: f64) -> Result<()> {
        let mut state = self.state.lock().await;
        if let Some(code) = state.failure {
            return Err(Failure::new(code, "EI connection ended"));
        }
        state.sequence = state.sequence.wrapping_add(1);
        let sequence = state.sequence;
        let (device, d) = state
            .devices
            .iter_mut()
            .find(|(d, s)| {
                s.resumed
                    && d.has_capability(DeviceCapability::PointerAbsolute)
                    && d.regions()
                        .iter()
                        .any(|r| r.mapping_id.as_deref() == Some(mapping))
            })
            .ok_or_else(|| {
                Failure::new(
                    "mapping-unavailable",
                    "Stream EI region is no longer resumed",
                )
            })?;
        let r = device
            .regions()
            .iter()
            .find(|r| r.mapping_id.as_deref() == Some(mapping))
            .ok_or_else(|| Failure::new("mapping-unavailable", "EI region removed"))?;
        if !d.started {
            device
                .device()
                .start_emulating(self.connection.serial(), sequence);
            d.started = true;
        }
        device
            .interface::<ei::PointerAbsolute>()
            .ok_or_else(|| Failure::new("paused-device", "EI pointer removed"))?
            .motion_absolute(
                (f64::from(r.x) + x * f64::from(r.width)) as f32,
                (f64::from(r.y) + y * f64::from(r.height)) as f32,
            );
        device.device().frame(self.connection.serial(), self.time());
        self.connection
            .flush()
            .map_err(|e| Failure::new("partial-input", e))
    }

    pub async fn button(&self, code: u32, pressed: bool) -> Result<()> {
        self.submit(DeviceCapability::Button, |device, d| {
            let button = device
                .interface::<ei::Button>()
                .ok_or_else(|| Failure::new("paused-device", "EI button removed"))?;
            if pressed {
                d.buttons.insert(code);
            }
            button.button(
                code,
                if pressed {
                    ei::button::ButtonState::Press
                } else {
                    ei::button::ButtonState::Released
                },
            );
            Ok(())
        })
        .await?;
        if !pressed {
            for state in self.state.lock().await.devices.values_mut() {
                state.buttons.remove(&code);
            }
        }
        Ok(())
    }

    pub async fn scroll(&self, x: f64, y: f64) -> Result<()> {
        self.submit(DeviceCapability::Scroll, |device, _| {
            let scroll = device
                .interface::<ei::Scroll>()
                .ok_or_else(|| Failure::new("paused-device", "EI scroll removed"))?;
            scroll.scroll(x as f32, y as f32);
            Ok(())
        })
        .await?;
        self.submit(DeviceCapability::Scroll, |device, _| {
            device
                .interface::<ei::Scroll>()
                .ok_or_else(|| Failure::new("paused-device", "EI scroll removed"))?
                .scroll_stop(u32::from(x != 0.0), u32::from(y != 0.0), 0);
            Ok(())
        })
        .await
    }

    pub async fn resolve(&self, symbols: &[u32]) -> Result<Vec<u32>> {
        let state = self.state.lock().await;
        let (device, active) = state
            .devices
            .iter()
            .find(|(d, s)| s.resumed && d.has_capability(DeviceCapability::Keyboard))
            .ok_or_else(|| Failure::new("paused-device", "No resumed EI keyboard"))?;
        let keymap = device
            .keymap()
            .ok_or_else(|| Failure::new("missing-protocol", "EI keyboard supplied no keymap"))?;
        let fd = keymap
            .fd
            .try_clone()
            .map_err(|e| Failure::new("backend-error", e))?;
        let map = keyboard::keymap(fd, keymap.size, "EI")?;
        let mut current = xkb::State::new(&map);
        current.update_mask(
            active.modifiers.depressed,
            active.modifiers.latched,
            active.modifiers.locked,
            0,
            0,
            active.modifiers.group,
        );
        // Enumerate defined keys while preserving lowest-keycode resolution
        let mut keycodes = Vec::new();
        map.key_for_each(|_, key| keycodes.push(key.raw()));
        keycodes.sort_unstable();
        symbols
            .iter()
            .map(|symbol| {
                let code = keycodes
                    .iter()
                    .copied()
                    .find(|raw| {
                        let key = xkb::Keycode::new(*raw);
                        current.key_get_one_sym(key).raw() == *symbol
                            || map
                                .key_get_syms_by_level(key, active.modifiers.group, 0)
                                .iter()
                                .any(|s| s.raw() == *symbol)
                    })
                    .ok_or_else(|| {
                        Failure::new(
                            "invalid-request",
                            format!(
                                "Keysym {symbol:#x} is unavailable in the EI keymap's active chord"
                            ),
                        )
                    })?;
                current.update_key(xkb::Keycode::new(code), xkb::KeyDirection::Down);
                code.checked_sub(XKB_KEYCODE_OFFSET)
                    .ok_or_else(|| Failure::new("backend-error", "Invalid XKB keycode"))
            })
            .collect()
    }

    pub async fn key(&self, code: u32, pressed: bool) -> Result<()> {
        self.submit(DeviceCapability::Keyboard, |device, d| {
            let keyboard = device
                .interface::<ei::Keyboard>()
                .ok_or_else(|| Failure::new("paused-device", "EI keyboard removed"))?;
            if pressed {
                d.keys.insert(code);
            }
            keyboard.key(
                code,
                if pressed {
                    ei::keyboard::KeyState::Press
                } else {
                    ei::keyboard::KeyState::Released
                },
            );
            Ok(())
        })
        .await?;
        if !pressed {
            for state in self.state.lock().await.devices.values_mut() {
                state.keys.remove(&code);
            }
        }
        Ok(())
    }

    pub async fn has_text(&self) -> bool {
        self.state
            .lock()
            .await
            .devices
            .keys()
            .any(|d| d.has_capability(DeviceCapability::Text))
    }

    pub async fn text(&self, text: &str) -> Result<()> {
        self.submit(DeviceCapability::Text, |device, _| {
            device
                .interface::<ei::Text>()
                .ok_or_else(|| Failure::new("paused-device", "EI text removed"))?
                .utf8(text);
            Ok(())
        })
        .await
    }
}
