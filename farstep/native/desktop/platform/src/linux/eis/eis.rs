mod input;
mod state;
mod transport;

use std::os::fd::OwnedFd;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use reis::event::{Device, DeviceCapability};
use state::{DeviceState, EventWorker, State, release_device};
use tokio::sync::{Mutex, Notify};
use tokio_util::task::LocalPoolHandle;

use super::protocol::{Failure, Result};

const DEVICE_TIMEOUT: Duration = Duration::from_secs(10);
static EVENT_WORKERS: LazyLock<LocalPoolHandle> = LazyLock::new(|| LocalPoolHandle::new(1));

pub struct Eis {
    connection: reis::event::Connection,
    state: Arc<Mutex<State>>,
    _events: tokio_util::sync::DropGuard,
    pub generation: Arc<AtomicU64>,
    epoch: Instant,
    ready: Arc<Notify>,
}

impl Eis {
    pub async fn connect(fd: OwnedFd) -> Result<Self> {
        let state = Arc::new(Mutex::new(State::default()));
        let ready = Arc::new(Notify::new());
        let generation = Arc::new(AtomicU64::new(0));
        let epoch = Instant::now();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let events = cancellation.clone().drop_guard();
        let (initialized, connection) = tokio::sync::oneshot::channel();
        // The EI converter owns non-Send callbacks, so construct and poll each
        // connection on the local worker while sharing its thread-safe handle
        let worker = EventWorker {
            state: state.clone(),
            ready: ready.clone(),
            generation: generation.clone(),
            epoch,
        };
        EVENT_WORKERS.spawn_pinned(move || worker.run(fd, cancellation, initialized));
        let connection = connection.await.map_err(|_| {
            Failure::new("disconnected", "EI event worker ended during handshake")
        })??;
        let result = Self {
            connection,
            state,
            _events: events,
            generation,
            epoch,
            ready,
        };
        Ok(result)
    }

    pub async fn wait_ready(&self) -> Result<()> {
        let readiness = tokio::time::timeout(DEVICE_TIMEOUT, async {
            loop {
                let notified = self.ready.notified();
                {
                    let state = self.state.lock().await;
                    if let Some(code) = state.failure {
                        return Err(Failure::new(code, "EI session disconnected"));
                    }
                    if state
                        .devices
                        .iter()
                        .any(|(d, s)| s.resumed && d.has_capability(DeviceCapability::Keyboard))
                        && state.devices.iter().any(|(d, s)| {
                            s.resumed && d.has_capability(DeviceCapability::PointerAbsolute)
                        })
                    {
                        return Ok(());
                    }
                }
                notified.await;
            }
        })
        .await;
        match readiness {
            Ok(result) => result?,
            Err(_) => {
                let state = self.state.lock().await;
                let keyboards = state
                    .devices
                    .iter()
                    .filter(|(d, _)| d.has_capability(DeviceCapability::Keyboard))
                    .count();
                let pointers = state
                    .devices
                    .iter()
                    .filter(|(d, _)| d.has_capability(DeviceCapability::PointerAbsolute))
                    .count();
                let resumed = state.devices.values().filter(|d| d.resumed).count();
                return Err(Failure::new(
                    "paused-device",
                    format!(
                        "No resumed EI keyboard and pointer devices ({} bound seats, {} devices, \
                         {resumed} resumed, {keyboards} keyboards, {pointers} absolute pointers)",
                        state.seat_bindings,
                        state.devices.len()
                    ),
                ));
            }
        }
        Ok(())
    }

    fn time(&self) -> u64 {
        self.epoch.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
    }

    async fn submit(
        &self,
        capability: DeviceCapability,
        operation: impl FnOnce(&Device, &mut DeviceState) -> Result<()>,
    ) -> Result<()> {
        let mut state = self.state.lock().await;
        if let Some(code) = state.failure {
            return Err(Failure::new(code, "EI connection ended"));
        }
        state.sequence = state.sequence.wrapping_add(1);
        let sequence = state.sequence;
        let (device, d) = state
            .devices
            .iter_mut()
            .find(|(device, d)| d.resumed && device.has_capability(capability))
            .ok_or_else(|| Failure::new("paused-device", "No resumed compatible EI device"))?;
        if !d.started {
            device
                .device()
                .start_emulating(self.connection.serial(), sequence);
            d.started = true;
        }
        operation(device, d)?;
        device.device().frame(self.connection.serial(), self.time());
        self.connection
            .flush()
            .map_err(|e| Failure::new("partial-input", e))
    }

    pub async fn release(&self) {
        let mut state = self.state.lock().await;
        for (device, d) in &mut state.devices {
            release_device(device, d, self.connection.serial(), self.time());
        }
        let _ = self.connection.flush();
    }
}
