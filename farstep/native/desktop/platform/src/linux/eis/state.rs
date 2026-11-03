use std::collections::{HashMap, HashSet};
use std::os::fd::OwnedFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use futures_util::StreamExt;
use reis::ei;
use reis::event::{Device, DeviceCapability, EiEvent};
use tokio::sync::{Mutex, Notify};

use super::super::protocol::Result;
use super::transport::initialize;

#[derive(Default)]
pub(super) struct Modifiers {
    pub(super) depressed: u32,
    pub(super) latched: u32,
    pub(super) locked: u32,
    pub(super) group: u32,
}

#[derive(Default)]
pub(super) struct DeviceState {
    pub(super) resumed: bool,
    pub(super) keys: HashSet<u32>,
    pub(super) buttons: HashSet<u32>,
    pub(super) started: bool,
    pub(super) modifiers: Modifiers,
}

#[derive(Default)]
pub(super) struct State {
    pub(super) devices: HashMap<Device, DeviceState>,
    pub(super) seat_bindings: usize,
    pub(super) failure: Option<&'static str>,
    pub(super) sequence: u32,
}

impl State {
    fn pause(&mut self, paused: &Device, connection: &reis::event::Connection, epoch: Instant) {
        for (device, d) in &mut self.devices {
            if device == paused {
                // Pause ends this device's emulation on the server
                d.keys.clear();
                d.buttons.clear();
                d.started = false;
                d.resumed = false;
            } else {
                release_device(
                    device,
                    d,
                    connection.serial(),
                    epoch.elapsed().as_micros() as u64,
                );
            }
        }
    }

    fn release(&mut self, connection: &reis::event::Connection, epoch: Instant) {
        for (device, d) in &mut self.devices {
            release_device(
                device,
                d,
                connection.serial(),
                epoch.elapsed().as_micros() as u64,
            );
        }
    }
}

pub(super) struct EventWorker {
    pub(super) state: Arc<Mutex<State>>,
    pub(super) ready: Arc<Notify>,
    pub(super) generation: Arc<AtomicU64>,
    pub(super) epoch: Instant,
}

impl EventWorker {
    pub(super) async fn run(
        self,
        fd: OwnedFd,
        cancellation: tokio_util::sync::CancellationToken,
        initialized: tokio::sync::oneshot::Sender<Result<reis::event::Connection>>,
    ) {
        let Some(established) = cancellation.run_until_cancelled(initialize(fd)).await else {
            return;
        };
        let (event_connection, mut stream) = match established {
            Ok(established) => established,
            Err(error) => {
                let _ = initialized.send(Err(error));
                return;
            }
        };
        if initialized.send(Ok(event_connection.clone())).is_err() {
            return;
        }
        loop {
            let Some(Some(event)) = cancellation.run_until_cancelled(stream.next()).await else {
                break;
            };
            let mut state = self.state.lock().await;
            if !self.handle(&mut state, event, &event_connection) {
                break;
            }
            if event_connection.flush().is_err() {
                state.failure = Some("disconnected");
                break;
            }
        }
        let mut state = self.state.lock().await;
        state.release(&event_connection, self.epoch);
        let _ = event_connection.flush();
        state.failure = Some("disconnected");
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.ready.notify_waiters();
    }

    fn handle(
        &self,
        state: &mut State,
        event: std::result::Result<EiEvent, reis::Error>,
        event_connection: &reis::event::Connection,
    ) -> bool {
        match event {
            Ok(EiEvent::SeatAdded(e)) => {
                state.seat_bindings += 1;
                // reis emits only advertised capability bits
                e.seat.bind_capabilities(
                    DeviceCapability::PointerAbsolute
                        | DeviceCapability::Keyboard
                        | DeviceCapability::Button
                        | DeviceCapability::Scroll
                        | DeviceCapability::Text,
                );
                if event_connection.flush().is_err() {
                    state.failure = Some("disconnected");
                    self.generation.fetch_add(1, Ordering::AcqRel);
                    self.ready.notify_waiters();
                    return false;
                }
            }
            Ok(EiEvent::DeviceAdded(e)) => {
                state.devices.insert(e.device, DeviceState::default());
            }
            Ok(EiEvent::DeviceResumed(e)) => {
                if let Some(d) = state.devices.get_mut(&e.device) {
                    d.resumed = true;
                }
                self.generation.fetch_add(1, Ordering::AcqRel);
                self.ready.notify_waiters();
            }
            Ok(EiEvent::DevicePaused(e)) => {
                state.pause(&e.device, event_connection, self.epoch);
                self.generation.fetch_add(1, Ordering::AcqRel);
            }
            Ok(EiEvent::DeviceRemoved(e)) => {
                state.devices.remove(&e.device);
                state.release(event_connection, self.epoch);
                self.generation.fetch_add(1, Ordering::AcqRel);
            }
            Ok(EiEvent::SeatRemoved(e)) => {
                state.seat_bindings = state.seat_bindings.saturating_sub(1);
                state.devices.retain(|d, _| d.seat() != &e.seat);
                state.release(event_connection, self.epoch);
                self.generation.fetch_add(1, Ordering::AcqRel);
            }
            Ok(EiEvent::KeyboardModifiers(e)) => {
                if let Some(d) = state.devices.get_mut(&e.device) {
                    d.modifiers = Modifiers {
                        depressed: e.depressed,
                        latched: e.latched,
                        locked: e.locked,
                        group: e.group,
                    };
                }
            }
            Ok(EiEvent::Disconnected(_)) | Err(_) => {
                state.failure = Some("disconnected");
                return false;
            }
            _ => {}
        }
        true
    }
}

pub(super) fn release_device(device: &Device, d: &mut DeviceState, serial: u32, time: u64) {
    if !d.resumed || !device.device().is_alive() {
        d.keys.clear();
        d.buttons.clear();
        d.started = false;
        return;
    }
    if !d.started {
        return;
    }
    if let Some(keyboard) = device.interface::<ei::Keyboard>() {
        for code in d.keys.drain() {
            keyboard.key(code, ei::keyboard::KeyState::Released);
        }
    }
    if let Some(button) = device.interface::<ei::Button>() {
        for code in d.buttons.drain() {
            button.button(code, ei::button::ButtonState::Released);
        }
    }
    device.device().frame(serial, time);
    device.device().stop_emulating(serial);
    d.started = false;
}
