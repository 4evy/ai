use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Instant;

use wayland_client::protocol::wl_keyboard;
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1;
use xkbcommon::xkb;

use super::super::protocol::{Failure, Result};
use super::super::{XKB_KEYCODE_OFFSET, keyboard};
use super::state::State;

#[derive(Default)]
pub(super) struct KeyboardMap {
    pub(super) layouts: Vec<HashMap<u32, u16>>,
    pub(super) identity: String,
    pub(super) group: usize,
    pub(super) failure: Option<Failure>,
}

pub(super) struct PrivateKeyboard {
    keyboard: ZwpVirtualKeyboardV1,
    state: xkb::State,
    epoch: Instant,
}

impl PrivateKeyboard {
    pub(super) fn new(keyboard: ZwpVirtualKeyboardV1) -> Result<Self> {
        use std::io::Write;
        use std::os::fd::AsFd;
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let map = xkb::Keymap::new_from_names(
            &context,
            "evdev",
            "pc105",
            "us",
            "",
            None,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )
        .ok_or_else(|| {
            Failure::new(
                "missing-protocol",
                "Private keyboard keymap cannot be compiled",
            )
        })?;
        let keymap = map.get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1);
        let mut file = tempfile::tempfile().map_err(|error| Failure::new("prerequisite", error))?;
        file.write_all(keymap.as_bytes())
            .and_then(|()| file.write_all(b"\0"))
            .map_err(|error| Failure::new("prerequisite", error))?;
        keyboard.keymap(
            xkb::KEYMAP_FORMAT_TEXT_V1,
            file.as_fd(),
            keymap.len() as u32 + 1,
        );
        Ok(Self {
            keyboard,
            state: xkb::State::new(&map),
            epoch: Instant::now(),
        })
    }

    pub(super) fn raw(&mut self, code: u32, pressed: bool) -> Result<()> {
        let evdev = code
            .checked_sub(XKB_KEYCODE_OFFSET)
            .ok_or_else(|| Failure::new("invalid-request", "Private keycode is invalid"))?;
        self.state.update_key(
            xkb::Keycode::new(code),
            if pressed {
                xkb::KeyDirection::Down
            } else {
                xkb::KeyDirection::Up
            },
        );
        self.keyboard.modifiers(
            self.state.serialize_mods(xkb::STATE_MODS_DEPRESSED),
            self.state.serialize_mods(xkb::STATE_MODS_LATCHED),
            self.state.serialize_mods(xkb::STATE_MODS_LOCKED),
            self.state.serialize_layout(xkb::STATE_LAYOUT_EFFECTIVE),
        );
        self.keyboard.key(
            self.epoch.elapsed().as_millis() as u32,
            evdev,
            u32::from(pressed),
        );
        Ok(())
    }
}

impl Dispatch<wl_keyboard::WlKeyboard, ()> for State {
    fn event(
        state: &mut Self,
        keyboard: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if state.physical_keyboard.as_ref() != Some(keyboard) {
            return;
        }
        match event {
            wl_keyboard::Event::Keymap { format, fd, size } => {
                let layouts = if matches!(
                    format,
                    wayland_client::WEnum::Value(wl_keyboard::KeymapFormat::XkbV1)
                ) {
                    keyboard_layouts(fd, size)
                } else {
                    Err(Failure::new(
                        "missing-protocol",
                        "Unsupported Wayland keyboard keymap format",
                    ))
                };
                if layouts.as_ref().is_ok_and(|next| {
                    state
                        .keymap
                        .lock()
                        .is_ok_and(|map| map.failure.is_none() && map.identity == next.identity)
                }) {
                    return;
                }
                state.release();
                if let Ok(mut map) = state.keymap.lock() {
                    match layouts {
                        Ok(next) => {
                            map.layouts = next.layouts;
                            map.identity = next.identity;
                            map.failure = None;
                        }
                        Err(error) => {
                            map.layouts.clear();
                            map.failure = Some(error);
                        }
                    }
                }
                state.generation.fetch_add(1, Ordering::AcqRel);
            }
            wl_keyboard::Event::Modifiers { group, .. } => {
                let changed = state
                    .keymap
                    .lock()
                    .is_ok_and(|map| map.group != group as usize);
                if changed {
                    state.release();
                    if let Ok(mut map) = state.keymap.lock() {
                        map.group = group as usize;
                    }
                    state.generation.fetch_add(1, Ordering::AcqRel);
                }
            }
            _ => {}
        }
    }
}

fn keyboard_layouts(fd: std::os::fd::OwnedFd, size: u32) -> Result<KeyboardMap> {
    let map = keyboard::keymap(fd, size, "Wayland")?;
    let layouts = (0..map.num_layouts())
        .map(|layout| {
            let mut symbols = HashMap::<u32, u16>::new();
            map.key_for_each(|map, key| {
                let Ok(code) = u16::try_from(key.raw()) else {
                    return;
                };
                for symbol in (0..map.num_levels_for_key(key, layout))
                    .flat_map(|level| map.key_get_syms_by_level(key, layout, level))
                {
                    symbols
                        .entry(symbol.raw())
                        .and_modify(|current| *current = (*current).min(code))
                        .or_insert(code);
                }
            });
            symbols
        })
        .collect();
    Ok(KeyboardMap {
        layouts,
        identity: map.get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1),
        ..Default::default()
    })
}
