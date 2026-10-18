mod keyboard;
mod state;
mod worker;

use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use keyboard::KeyboardMap;
use smithay_client_toolkit::reexports::calloop::channel;
use state::State;
use tokio::sync::{mpsc, oneshot};
use wayland_client::Connection;
use wayland_client::globals::registry_queue_init;
use worker::{InputWorker, Request, WorkerRequest, forward};

use super::PRIVATE_OUTPUT;
use super::protocol::{Failure, Result};

const POINTER_VERSION: u32 = 2;
const KEYBOARD_SEAT_VERSION: u32 = 5;
const INPUT_QUEUE_CAPACITY: usize = 16;
const ABSOLUTE_EXTENT: u32 = 1_000_000;

#[derive(Clone, Default)]
pub struct Capabilities {
    pub keyboard: bool,
    pub pointer: bool,
    pub clipboard: bool,
}

pub fn discover() -> Result<Capabilities> {
    let connection = Connection::connect_to_env().map_err(|e| Failure::new("prerequisite", e))?;
    let (globals, _) =
        registry_queue_init::<State>(&connection).map_err(|e| Failure::new("disconnected", e))?;
    Ok(globals.contents().with_list(|list| Capabilities {
        keyboard: list
            .iter()
            .any(|g| g.interface == "zwp_virtual_keyboard_manager_v1"),
        pointer: list.iter().any(|g| {
            g.interface == "zwlr_virtual_pointer_manager_v1" && g.version >= POINTER_VERSION
        }),
        clipboard: list.iter().any(|g| {
            matches!(
                g.interface.as_str(),
                "ext_data_control_manager_v1" | "zwlr_data_control_manager_v1"
            )
        }),
    }))
}

pub enum Command {
    Motion(f64, f64),
    Button(u32, bool),
    Key(u32, bool),
    Scroll(f64, f64),
    Release,
}

pub struct Direct {
    sender: mpsc::Sender<Request>,
    _events: tokio_util::sync::DropGuard,
    pub generation: Arc<AtomicU64>,
    geometry: Arc<std::sync::Mutex<Option<super::protocol::Geometry>>>,
    keymap: Arc<std::sync::Mutex<KeyboardMap>>,
    pub output_name: String,
}

static PRIVATE_INPUT: tokio::sync::OnceCell<Arc<Direct>> = tokio::sync::OnceCell::const_new();

impl Direct {
    pub async fn private() -> Result<Arc<Self>> {
        // Keep the headless seat's keyboard and keymap alive between sessions
        PRIVATE_INPUT
            .get_or_try_init(|| async { Self::connect(PRIVATE_OUTPUT).await.map(Arc::new) })
            .await
            .cloned()
    }

    pub async fn connect(output_name: &str) -> Result<Self> {
        let (sender, receiver) = mpsc::channel::<Request>(INPUT_QUEUE_CAPACITY);
        let (commands, source) = channel::channel::<WorkerRequest>();
        let (ready, started) = oneshot::channel();
        let output_name = output_name.to_owned();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let events = cancellation.clone().drop_guard();
        // Construct non-Send native keyboard state on the thread that owns it
        std::thread::Builder::new()
            .name("omp-wayland-input".into())
            .spawn(move || match InputWorker::connect(&output_name) {
                Ok(worker) => {
                    let direct = Self {
                        sender,
                        _events: events,
                        generation: worker.state.generation.clone(),
                        geometry: worker.state.geometry.clone(),
                        keymap: worker.state.keymap.clone(),
                        output_name,
                    };
                    worker.run(source, ready, direct);
                }
                Err(error) => {
                    let _ = ready.send(Err(error));
                }
            })
            .map_err(|e| Failure::new("disconnected", e))?;
        tokio::spawn(forward(receiver, commands, cancellation));
        started
            .await
            .map_err(|_| Failure::new("disconnected", "Wayland worker failed to start"))?
    }

    pub fn geometry(&self) -> Result<super::protocol::Geometry> {
        self.geometry
            .lock()
            .map_err(|_| Failure::new("backend-error", "Output geometry lock poisoned"))?
            .clone()
            .ok_or_else(|| {
                Failure::new(
                    "mapping-unavailable",
                    "Selected output geometry is unavailable",
                )
            })
    }

    // Resolve against the compositor keymap before pressing modifiers so Enigo
    // does not replace its virtual keymap midway through a shortcut
    pub fn resolve(&self, symbols: &[u32]) -> Result<Vec<u32>> {
        let map = self
            .keymap
            .lock()
            .map_err(|_| Failure::new("backend-error", "Keyboard map lock poisoned"))?;
        if let Some(error) = &map.failure {
            return Err(error.clone());
        }
        let layout = map.layouts.get(map.group).ok_or_else(|| {
            Failure::new("paused-device", "Wayland keyboard layout is unavailable")
        })?;
        symbols
            .iter()
            .map(|symbol| {
                layout
                    .get(symbol)
                    .map(|code| u32::from(*code))
                    .ok_or_else(|| {
                        Failure::new(
                            "invalid-request",
                            format!("Keysym {symbol:#x} is unavailable in the Wayland keymap"),
                        )
                    })
            })
            .collect()
    }

    pub async fn send(&self, command: Command) -> Result<()> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send((command, sender))
            .await
            .map_err(|_| Failure::new("disconnected", "Wayland input disconnected"))?;
        receiver
            .await
            .map_err(|_| Failure::new("disconnected", "Wayland input disconnected"))?
    }
}
