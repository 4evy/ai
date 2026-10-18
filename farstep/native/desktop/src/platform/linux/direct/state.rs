use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use enigo::{Direction, Enigo, Keyboard, Settings};
use smithay_client_toolkit::output::{OutputHandler, OutputState};
use smithay_client_toolkit::registry::{ProvidesRegistryState, RegistryState};
use smithay_client_toolkit::seat::{Capability, SeatHandler, SeatState};
use smithay_client_toolkit::{delegate_dispatch2, delegate_registry, registry_handlers};
use wayland_client::globals::GlobalList;
use wayland_client::protocol::{wl_keyboard, wl_output, wl_pointer, wl_seat};
use wayland_client::{Connection, Proxy, QueueHandle};
use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1;
use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1;
use wayland_protocols_wlr::virtual_pointer::v1::client::zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1;
use wayland_protocols_wlr::virtual_pointer::v1::client::zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1;

use super::super::protocol::{Failure, Result};
use super::keyboard::{KeyboardMap, PrivateKeyboard};
use super::{KEYBOARD_SEAT_VERSION, POINTER_VERSION};

pub(super) struct State {
    pub(super) registry: RegistryState,
    pub(super) outputs: OutputState,
    pub(super) seats: SeatState,
    pub(super) selected: Option<wl_output::WlOutput>,
    pub(super) pointer: Option<ZwlrVirtualPointerV1>,
    pub(super) keyboard: Option<Enigo>,
    pub(super) private_keyboard: Option<PrivateKeyboard>,
    pub(super) physical_keyboard: Option<wl_keyboard::WlKeyboard>,
    pub(super) keymap: Arc<std::sync::Mutex<KeyboardMap>>,
    pub(super) keys: HashSet<u32>,
    pub(super) buttons: HashSet<u32>,
    pub(super) generation: Arc<AtomicU64>,
    pub(super) geometry: Arc<std::sync::Mutex<Option<super::super::protocol::Geometry>>>,
    pub(super) epoch: Instant,
    pub(super) removed: bool,
}

impl State {
    pub(super) fn new(globals: &GlobalList, handle: &QueueHandle<Self>) -> Self {
        let generation = Arc::new(AtomicU64::new(0));
        let geometry = Arc::new(std::sync::Mutex::new(None));
        let keymap = Arc::new(std::sync::Mutex::new(KeyboardMap::default()));
        Self {
            registry: RegistryState::new(globals),
            outputs: OutputState::new(globals, handle),
            seats: SeatState::new(globals, handle),
            selected: None,
            pointer: None,
            keyboard: None,
            private_keyboard: None,
            physical_keyboard: None,
            keymap,
            keys: HashSet::new(),
            buttons: HashSet::new(),
            generation,
            geometry,
            epoch: Instant::now(),
            removed: false,
        }
    }

    pub(super) fn validate_seat(&self) -> Result<()> {
        if self.seats.seats().count() != 1 {
            return Err(Failure::new(
                "mapping-unavailable",
                "Direct keyboard requires one unambiguous Wayland seat",
            ));
        }
        if self
            .seats
            .seats()
            .any(|seat| seat.version() < KEYBOARD_SEAT_VERSION)
        {
            return Err(Failure::new(
                "missing-protocol",
                "Direct keyboard requires Wayland seat version 5 or newer",
            ));
        }
        Ok(())
    }

    pub(super) fn initialize_private_keyboard(
        &mut self,
        globals: &GlobalList,
        handle: &QueueHandle<Self>,
    ) -> Result<()> {
        // A headless seat acquires its first keymap from the virtual keyboard
        // Create it before subscribing to the seat's keyboard capabilities
        if std::env::var("FARSTEP_NESTED_DESKTOP").as_deref() == Ok("cosmic") {
            let manager: ZwpVirtualKeyboardManagerV1 = globals
                .bind(handle, 1..=1, ())
                .map_err(|error| Failure::new("missing-protocol", error))?;
            let seat = self
                .seats
                .seats()
                .next()
                .ok_or_else(|| Failure::new("missing-protocol", "Private seat is missing"))?;
            self.private_keyboard = Some(PrivateKeyboard::new(manager.create_virtual_keyboard(
                &seat,
                handle,
                (),
            ))?);
        }
        Ok(())
    }

    pub(super) fn ensure_keymap(&self) -> Result<()> {
        let map = self
            .keymap
            .lock()
            .map_err(|_| Failure::new("backend-error", "Keyboard map lock poisoned"))?;
        if let Some(error) = &map.failure {
            return Err(error.clone());
        }
        if map.layouts.is_empty() {
            return Err(Failure::new(
                "missing-protocol",
                "Wayland keyboard keymap is unavailable",
            ));
        }
        Ok(())
    }

    pub(super) fn select_output(
        &mut self,
        globals: &GlobalList,
        handle: &QueueHandle<Self>,
        output_name: &str,
    ) -> Result<()> {
        let outputs: Vec<_> = self
            .outputs
            .outputs()
            .filter(|o| self.outputs.info(o).and_then(|i| i.name).as_deref() == Some(output_name))
            .collect();
        let [output]: [_; 1] = outputs.try_into().map_err(|_| {
            Failure::new(
                "mapping-unavailable",
                "outputName does not identify exactly one Wayland output",
            )
        })?;
        let initial = output_geometry(&self.outputs, &output).ok_or_else(|| {
            Failure::new(
                "mapping-unavailable",
                "Selected output has no authoritative logical geometry",
            )
        })?;
        *self
            .geometry
            .lock()
            .map_err(|_| Failure::new("backend-error", "Output geometry lock poisoned"))? =
            Some(initial);
        let manager: ZwlrVirtualPointerManagerV1 = globals
            .bind(handle, POINTER_VERSION..=POINTER_VERSION, ())
            .map_err(|e| Failure::new("missing-protocol", e))?;
        self.pointer =
            Some(manager.create_virtual_pointer_with_output(None, Some(&output), handle, ()));
        self.selected = Some(output);
        if self.keyboard.is_none() && self.private_keyboard.is_none() {
            self.keyboard = Some(
                Enigo::new(&Settings::default())
                    .map_err(|e| Failure::new("missing-protocol", e))?,
            );
        }
        Ok(())
    }

    pub(super) fn time(&self) -> u32 {
        self.epoch.elapsed().as_millis() as u32
    }

    pub(super) fn release(&mut self) {
        let time = self.time();
        if let Some(pointer) = &self.pointer {
            for button in self.buttons.drain() {
                pointer.button(time, button, wl_pointer::ButtonState::Released);
            }
            pointer.frame();
        }
        for key in self.keys.drain() {
            if let Some(keyboard) = &mut self.private_keyboard {
                let _ = keyboard.raw(key, false);
            } else if let Some(keyboard) = &mut self.keyboard
                && let Ok(key) = u16::try_from(key)
            {
                let _ = keyboard.raw(key, Direction::Release);
            }
        }
    }

    pub(super) fn remove_keyboard(&mut self) {
        self.release();
        if let Some(keyboard) = self.physical_keyboard.take() {
            keyboard.release();
        }
        if let Ok(mut map) = self.keymap.lock() {
            *map = KeyboardMap::default();
        }
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    fn changed(&mut self, output: &wl_output::WlOutput, removed: bool) {
        if self.selected.as_ref() != Some(output) {
            return;
        }
        self.release();
        self.removed |= removed;
        if let Ok(mut geometry) = self.geometry.lock() {
            *geometry = if removed {
                None
            } else {
                output_geometry(&self.outputs, output)
            };
        }
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
}

impl OutputHandler for State {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.outputs
    }

    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}

    fn update_output(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        output: wl_output::WlOutput,
    ) {
        self.changed(&output, false);
    }

    fn output_destroyed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        output: wl_output::WlOutput,
    ) {
        self.changed(&output, true);
    }
}

impl ProvidesRegistryState for State {
    registry_handlers!(OutputState, SeatState);

    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry
    }
}
delegate_dispatch2!(State);
delegate_registry!(State);
wayland_client::delegate_noop!(State: ignore ZwpVirtualKeyboardManagerV1);
wayland_client::delegate_noop!(State: ignore ZwpVirtualKeyboardV1);
wayland_client::delegate_noop!(State: ignore ZwlrVirtualPointerManagerV1);
wayland_client::delegate_noop!(State: ignore ZwlrVirtualPointerV1);

impl SeatHandler for State {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seats
    }

    fn new_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {
        if self.seats.seats().count() != 1 {
            self.remove_keyboard();
        }
    }

    fn new_capability(
        &mut self,
        _: &Connection,
        handle: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Keyboard
            && self.seats.seats().count() == 1
            && seat.version() >= KEYBOARD_SEAT_VERSION
            && self.physical_keyboard.is_none()
        {
            // Keep raw keymap dispatch: SCTK logs parse failures without
            // notifying callers and does not bound keymap size
            self.physical_keyboard = Some(seat.get_keyboard(handle, ()));
        }
    }

    fn remove_capability(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Keyboard {
            self.remove_keyboard();
        }
    }

    fn remove_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {
        self.remove_keyboard();
    }
}

fn output_geometry(
    outputs: &OutputState,
    output: &wl_output::WlOutput,
) -> Option<super::super::protocol::Geometry> {
    let info = outputs.info(output)?;
    let (x, y) = info.logical_position?;
    let (width, height) = info.logical_size?;
    if width <= 0 || height <= 0 {
        return None;
    }
    Some(super::super::protocol::Geometry {
        x: f64::from(x),
        y: f64::from(y),
        width: f64::from(width),
        height: f64::from(height),
    })
}
