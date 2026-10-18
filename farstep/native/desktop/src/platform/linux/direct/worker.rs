use std::sync::atomic::Ordering;

use enigo::{Direction, Keyboard};
use smithay_client_toolkit::reexports::calloop::{EventLoop, channel};
use smithay_client_toolkit::reexports::calloop_wayland_source::WaylandSource;
use tokio::sync::{mpsc, oneshot};
use wayland_client::globals::registry_queue_init;
use wayland_client::protocol::wl_pointer;
use wayland_client::{Connection, EventQueue};

use super::super::protocol::{Failure, Result};
use super::state::State;
use super::{ABSOLUTE_EXTENT, Command, Direct};

pub(super) type Request = (Command, oneshot::Sender<Result<()>>);
pub(super) type WorkerRequest = (Request, oneshot::Sender<()>);

pub(super) struct InputWorker {
    connection: Connection,
    queue: EventQueue<State>,
    pub(super) state: State,
}

impl InputWorker {
    pub(super) fn connect(output_name: &str) -> Result<Self> {
        let connection =
            Connection::connect_to_env().map_err(|e| Failure::new("prerequisite", e))?;
        let (globals, mut queue) = registry_queue_init::<State>(&connection)
            .map_err(|e| Failure::new("disconnected", e))?;
        let handle = queue.handle();
        let mut state = State::new(&globals, &handle);
        state.validate_seat()?;
        state.initialize_private_keyboard(&globals, &handle)?;
        queue
            .roundtrip(&mut state)
            .map_err(|e| Failure::new("disconnected", e))?;
        queue
            .roundtrip(&mut state)
            .map_err(|e| Failure::new("disconnected", e))?;
        state.ensure_keymap()?;
        state.select_output(&globals, &handle, output_name)?;
        queue
            .roundtrip(&mut state)
            .map_err(|e| Failure::new("disconnected", e))?;
        connection
            .flush()
            .map_err(|e| Failure::new("disconnected", e))?;
        Ok(Self {
            connection,
            queue,
            state,
        })
    }

    pub(super) fn run(
        self,
        source: channel::Channel<WorkerRequest>,
        ready: oneshot::Sender<Result<Direct>>,
        direct: Direct,
    ) {
        let Self {
            connection,
            queue,
            mut state,
        } = self;
        let events = (|| -> Result<EventLoop<State>> {
            let events =
                EventLoop::<State>::try_new().map_err(|e| Failure::new("disconnected", e))?;
            WaylandSource::new(connection.clone(), queue)
                .insert(events.handle())
                .map_err(|e| Failure::new("disconnected", e.error))?;
            let output = connection.clone();
            let stop = events.get_signal();
            events
                .handle()
                .insert_source(source, move |event, _, state| match event {
                    channel::Event::Msg(((command, reply), completed)) => {
                        if !reply.is_closed() {
                            let result = apply(state, command).and_then(|()| {
                                output.flush().map_err(|e| Failure::new("partial-input", e))
                            });
                            let _ = reply.send(result);
                        }
                        let _ = completed.send(());
                    }
                    channel::Event::Closed => stop.stop(),
                })
                .map_err(|e| Failure::new("disconnected", e.error))?;
            Ok(events)
        })();
        match events {
            Ok(mut events) => {
                if ready.send(Ok(direct)).is_ok() {
                    let _ = events.run(None, &mut state, |_| {});
                }
            }
            Err(error) => {
                let _ = ready.send(Err(error));
            }
        }
        state.release();
        let _ = connection.flush();
        state.generation.fetch_add(1, Ordering::AcqRel);
    }
}

pub(super) async fn forward(
    mut receiver: mpsc::Receiver<Request>,
    commands: channel::Sender<WorkerRequest>,
    cancellation: tokio_util::sync::CancellationToken,
) {
    // Forward one request at a time to retain bounded Tokio backpressure
    // Dropping the calloop sender on cancellation wakes the worker to release
    // input
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => {},
        _ = async {
            while let Some(request) = receiver.recv().await {
                if request.1.is_closed() {
                    continue;
                }
                let (completed, result) = oneshot::channel();
                // Pass the caller's reply through so the worker can observe
                // cancellation without admitting another pending request
                if commands.send((request, completed)).is_err() {
                    break;
                }
                if result.await.is_err() {
                    break;
                }
            }
        } => {},
    }
}

fn apply(state: &mut State, command: Command) -> Result<()> {
    if matches!(command, Command::Release) {
        state.release();
        return Ok(());
    }
    if state.removed {
        return Err(Failure::new(
            "mapping-unavailable",
            "Selected output was removed",
        ));
    }
    let time = state.time();
    let pointer = state
        .pointer
        .as_ref()
        .ok_or_else(|| Failure::new("disconnected", "Pointer unavailable"))?;
    match command {
        Command::Motion(x, y) => {
            // Output-bound normalized coordinates avoid global origins and
            // scale guesses
            pointer.motion_absolute(
                time,
                (x * f64::from(ABSOLUTE_EXTENT)) as u32,
                (y * f64::from(ABSOLUTE_EXTENT)) as u32,
                ABSOLUTE_EXTENT,
                ABSOLUTE_EXTENT,
            );
            pointer.frame();
        }
        Command::Button(code, pressed) => {
            if pressed {
                state.buttons.insert(code);
            } else {
                state.buttons.remove(&code);
            }
            pointer.button(
                time,
                code,
                if pressed {
                    wl_pointer::ButtonState::Pressed
                } else {
                    wl_pointer::ButtonState::Released
                },
            );
            pointer.frame();
        }
        Command::Scroll(x, y) => {
            pointer.axis_source(wl_pointer::AxisSource::Continuous);
            let axes = [
                (wl_pointer::Axis::HorizontalScroll, x),
                (wl_pointer::Axis::VerticalScroll, y),
            ];
            for (axis, amount) in axes {
                if amount != 0.0 {
                    pointer.axis(time, axis, amount);
                }
            }
            pointer.frame();
            for (axis, amount) in axes {
                if amount != 0.0 {
                    pointer.axis_stop(time, axis);
                }
            }
            pointer.frame();
        }
        Command::Key(code, pressed) => {
            if pressed {
                state.keys.insert(code);
            } else {
                state.keys.remove(&code);
            }
            if let Some(keyboard) = &mut state.private_keyboard {
                keyboard.raw(code, pressed)?;
            } else {
                state
                    .keyboard
                    .as_mut()
                    .ok_or_else(|| Failure::new("disconnected", "Keyboard unavailable"))?
                    .raw(
                        u16::try_from(code).map_err(|_| {
                            Failure::new("invalid-request", "Invalid keyboard keycode")
                        })?,
                        if pressed {
                            Direction::Press
                        } else {
                            Direction::Release
                        },
                    )
                    .map_err(|e| Failure::new("partial-input", e))?;
            }
        }
        Command::Release => state.release(),
    }
    Ok(())
}
