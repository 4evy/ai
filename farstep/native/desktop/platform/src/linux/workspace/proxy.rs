use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::process::Command;
use std::rc::Rc;
use std::sync::Arc;
use std::{fs, thread};

use procfs::process::Process;
use wl_proxy::baseline::Baseline;
use wl_proxy::client::ClientHandler;
use wl_proxy::global_mapper::GlobalMapper;
use wl_proxy::object::{Object, ObjectRcUtils};
use wl_proxy::protocols::ObjectInterface;
use wl_proxy::protocols::wayland::wl_display::{WlDisplay, WlDisplayHandler};
use wl_proxy::protocols::wayland::wl_registry::{WlRegistry, WlRegistryHandler};
use wl_proxy::protocols::xdg_shell::xdg_surface::{XdgSurface, XdgSurfaceHandler};
use wl_proxy::protocols::xdg_shell::xdg_toplevel::{XdgToplevel, XdgToplevelHandler};
use wl_proxy::protocols::xdg_shell::xdg_wm_base::{XdgWmBase, XdgWmBaseHandler};
use wl_proxy::state::{Destructor, State};

use super::super::protocol::{Failure, Result};

// Linux sockaddr_un reserves one byte for the terminating NUL
const MAX_SOCKET_PATH_BYTES: usize = 107;
const MAX_WORKSPACE_SLOTS: u32 = 32;

fn failure(error: impl std::fmt::Display) -> Failure {
    Failure::new("prerequisite", error)
}

pub fn run(arguments: &[String]) -> Result<()> {
    let (executable, arguments) = arguments
        .split_first()
        .ok_or_else(|| failure("A native application is required"))?;
    let id = std::env::var("FARSTEP_WORKSPACE_ID").map_err(failure)?;
    uuid::Uuid::parse_str(&id).map_err(failure)?;
    let unit = format!("omp-gui-{id}.scope");
    if !in_scope(std::process::id(), &unit) {
        return Err(failure(
            "Wayland proxy must belong to its launch process scope",
        ));
    }
    let runtime = dirs::runtime_dir()
        .ok_or_else(|| failure("XDG_RUNTIME_DIR is missing"))?
        .join("farstep");
    super::super::private_directory(&runtime)?;
    let workspaces = runtime.join("workspaces");
    super::super::private_directory(&workspaces)?;
    let directory = workspaces.join(&id);
    super::super::private_directory(&directory)?;
    let socket = directory.join("wayland");
    if socket.as_os_str().as_encoded_bytes().len() > MAX_SOCKET_PATH_BYTES {
        return Err(failure(
            "Workspace runtime directory exceeds the Unix socket path limit",
        ));
    }
    let listener = UnixListener::bind(&socket).map_err(failure)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).map_err(failure)?;
    let label = std::env::var("FARSTEP_WORKSPACE_LABEL").map_err(failure)?;
    let slot = label
        .strip_prefix("farstep-slot-")
        .and_then(|slot| slot.parse::<u32>().ok())
        .filter(|slot| (1..=MAX_WORKSPACE_SLOTS).contains(slot))
        .ok_or_else(|| failure("Workspace routing label is invalid"))?;
    let label: Arc<str> = format!("farstep-slot-{slot}").into();
    let mut child = Command::new(executable)
        .args(arguments)
        .env("WAYLAND_DISPLAY", &socket)
        .env_remove("WAYLAND_SOCKET")
        .spawn()
        .map_err(failure)?;
    let cleanup = socket.clone();
    thread::spawn(move || {
        use std::os::unix::process::ExitStatusExt;
        let status = child.wait();
        let _ = fs::remove_file(cleanup);
        let _ = fs::remove_dir(directory);
        let code = match status {
            Ok(status) => status
                .code()
                .unwrap_or_else(|| super::launch::signal_exit_code(status.signal().unwrap_or(1))),
            Err(_) => 1,
        };
        std::process::exit(code);
    });
    for connection in listener.incoming() {
        let connection = connection.map_err(failure)?;
        let credentials = rustix::net::sockopt::socket_peercred(&connection).map_err(failure)?;
        if credentials.uid != rustix::process::geteuid()
            || !in_scope(credentials.pid.as_raw_nonzero().get() as u32, &unit)
        {
            continue;
        }
        let label = label.clone();
        thread::spawn(move || {
            if let Err(error) = serve(connection.into(), label) {
                eprintln!("Wayland launch connection failed: {}", error.message);
            }
        });
    }
    Err(failure("Wayland launch listener stopped"))
}

fn in_scope(pid: u32, unit: &str) -> bool {
    i32::try_from(pid)
        .ok()
        .and_then(|pid| Process::new(pid).ok())
        .is_some_and(|process| super::scope::in_scope(&process, unit).unwrap_or(false))
}

fn serve(connection: OwnedFd, label: Arc<str>) -> Result<()> {
    let state = State::builder(Baseline::ALL_OF_THEM)
        .with_logging(false)
        .build()
        .map_err(failure)?;
    let client = state.add_client(&Rc::new(connection)).map_err(failure)?;
    client.set_handler(Connection {
        _lifetime: state.create_destructor(),
    });
    client.display().set_handler(Display { label });
    while !state.is_destroyed() {
        state.dispatch_blocking().map_err(failure)?;
    }
    Ok(())
}

struct Connection {
    _lifetime: Destructor,
}

impl ClientHandler for Connection {}

struct Display {
    label: Arc<str>,
}

impl WlDisplayHandler for Display {
    fn handle_get_registry(&mut self, display: &Rc<WlDisplay>, registry: &Rc<WlRegistry>) {
        display.send_get_registry(registry);
        registry.set_handler(Registry {
            globals: GlobalMapper::default(),
            label: self.label.clone(),
        });
    }
}

struct Registry {
    globals: GlobalMapper,
    label: Arc<str>,
}

impl WlRegistryHandler for Registry {
    fn handle_global(
        &mut self,
        registry: &Rc<WlRegistry>,
        name: u32,
        interface: ObjectInterface,
        version: u32,
    ) {
        // A launched app cannot request shell roles or activate an existing
        // session window through this private display
        if matches!(
            interface,
            ObjectInterface::XdgActivationV1 | ObjectInterface::ZwlrLayerShellV1
        ) {
            self.globals.ignore_global(name);
        } else {
            self.globals
                .forward_global(registry, name, interface, version);
        }
    }

    fn handle_global_remove(&mut self, registry: &Rc<WlRegistry>, name: u32) {
        self.globals.forward_global_remove(registry, name);
    }

    fn handle_bind(&mut self, registry: &Rc<WlRegistry>, name: u32, object: Rc<dyn Object>) {
        self.globals.forward_bind(registry, name, &object);
        if let Some(base) = object.try_downcast::<XdgWmBase>() {
            base.set_handler(Shell {
                label: self.label.clone(),
            });
        }
    }
}

struct Shell {
    label: Arc<str>,
}

impl XdgWmBaseHandler for Shell {
    fn handle_get_xdg_surface(
        &mut self,
        base: &Rc<XdgWmBase>,
        surface: &Rc<XdgSurface>,
        wl_surface: &Rc<wl_proxy::protocols::wayland::wl_surface::WlSurface>,
    ) {
        base.send_get_xdg_surface(surface, wl_surface);
        surface.set_handler(Surface {
            label: self.label.clone(),
        });
    }
}

struct Surface {
    label: Arc<str>,
}

impl XdgSurfaceHandler for Surface {
    fn handle_get_toplevel(&mut self, surface: &Rc<XdgSurface>, toplevel: &Rc<XdgToplevel>) {
        surface.send_get_toplevel(toplevel);
        toplevel.send_set_app_id(&self.label);
        toplevel.set_handler(Toplevel {
            label: self.label.clone(),
        });
    }
}

struct Toplevel {
    label: Arc<str>,
}

impl XdgToplevelHandler for Toplevel {
    fn handle_set_app_id(&mut self, toplevel: &Rc<XdgToplevel>, _app_id: &str) {
        toplevel.send_set_app_id(&self.label);
    }

    fn handle_set_fullscreen(
        &mut self,
        _toplevel: &Rc<XdgToplevel>,
        _output: Option<&Rc<wl_proxy::protocols::wayland::wl_output::WlOutput>>,
    ) {
        // Explicit-output fullscreen can override initial workspace placement
    }
}
