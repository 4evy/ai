use std::path::Path;
use std::sync::{Arc, OnceLock};

use base64::Engine;
use serde_json::{Value, json};
use tokio::net::windows::named_pipe::ServerOptions;
use tokio_util::sync::CancellationToken;
use win_custody::{ObjectSecurityDescriptor, OwnedSid};
use windows::Win32::Foundation::HLOCAL;
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    ConvertStringSidToSidW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES};
use windows::core::{HSTRING, Owned, PWSTR};
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{
    self, ServiceControlHandlerResult, ServiceStatusHandle,
};
use windows_service::{define_windows_service, service_dispatcher};

use crate::{MAX_CONNECTIONS, MAX_REQUEST_BYTES, Result};

const MAX_SID_TEXT_BYTES: usize = 184;
const MAX_REPLY_BYTES: usize = 4 * 1024 * 1024;
const START_WAIT_HINT: std::time::Duration = std::time::Duration::from_secs(30);

static OWNER: OnceLock<String> = OnceLock::new();

define_windows_service!(ffi_service_main, service_main);

fn validate(owner: &str) -> Result<()> {
    if owner.len() > MAX_SID_TEXT_BYTES {
        return Err("Owner must be a Windows account SID".into());
    }
    let text = HSTRING::from(owner);
    // SAFETY: text is NUL-terminated; both conversion outputs are LocalFree
    // allocations and the SID remains alive throughout the round trip
    unsafe {
        let mut sid = PSID::default();
        ConvertStringSidToSidW(&text, &mut sid)?;
        let _sid = Owned::new(HLOCAL(sid.0));
        let mut canonical = PWSTR::null();
        ConvertSidToStringSidW(sid, &mut canonical)?;
        let _canonical = Owned::new(HLOCAL(canonical.0.cast()));
        if canonical.to_string()? != owner {
            return Err("Owner must be a canonical Windows account SID".into());
        }
    }
    Ok(())
}

fn powershell(script: &str) -> std::process::Command {
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut command = std::process::Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        &encoded,
    ]);
    command
}

fn setup(owner: &str, action: &str) -> Result<()> {
    validate(owner)?;
    let binary = std::env::current_exe()?;
    let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let script = format!(
        "& {{ {} }} -Binary {} -Owner {} -Action {}",
        include_str!("install.ps1"),
        quote(&binary.to_string_lossy()),
        quote(owner),
        quote(action)
    );
    let status = powershell(&script).status()?;
    if !status.success() {
        return Err("Windows service setup failed".into());
    }
    Ok(())
}

pub fn install(owner: &str) -> Result<()> {
    setup(owner, "install")
}
pub fn uninstall(owner: &str) -> Result<()> {
    setup(owner, "uninstall")
}

pub fn request(owner: String) -> Result<()> {
    validate(&owner)?;
    tokio::runtime::Runtime::new()?.block_on(async {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let name = format!(r"\\.\pipe\farstep-system-{owner}");
        let mut pipe = tokio::net::windows::named_pipe::ClientOptions::new().open(&name)?;
        let security = ObjectSecurityDescriptor::query_kernel_object(&pipe)?;
        if !security
            .owner()?
            .matches(&OwnedSid::from_string("S-1-5-18")?)
        {
            return Err("Pipe owner must be LocalSystem".into());
        }
        let exchange = async {
            let mut input = Vec::new();
            tokio::io::stdin()
                .take(MAX_REQUEST_BYTES as u64 + 1)
                .read_to_end(&mut input)
                .await?;
            if input.len() > MAX_REQUEST_BYTES {
                return Err("System request exceeds 1 MiB".into());
            }
            pipe.write_all(&input).await?;
            let mut reply = Vec::new();
            BufReader::new(pipe)
                .take(MAX_REPLY_BYTES as u64 + 1)
                .read_until(b'\n', &mut reply)
                .await?;
            if reply.len() > MAX_REPLY_BYTES || !reply.ends_with(b"\n") {
                return Err("Invalid system service response".into());
            }
            tokio::io::stdout().write_all(&reply).await?;
            Ok(())
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => Err("System request cancelled".into()),
            result = exchange => result,
        }
    })
}

pub fn command(_: &str, cwd: &str) -> Result<tokio::process::Command> {
    let cwd = if cwd == "/" {
        format!(
            "{}\\",
            std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_owned())
        )
    } else {
        cwd.to_owned()
    };
    if !Path::new(&cwd).is_absolute() {
        return Err("System cwd must be absolute".into());
    }
    let mut command = tokio::process::Command::from(powershell(include_str!("command.ps1")));
    command.current_dir(cwd);
    Ok(command)
}

pub fn status(_: &str) -> Result<Value> {
    Ok(
        json!({"platform": "win32", "uid": null, "enabled": true, "root": true, "executable": std::env::current_exe()?}),
    )
}

fn report(handle: ServiceStatusHandle, state: ServiceState, error: u32) -> Result<()> {
    handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: if state == ServiceState::Running {
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
        } else {
            ServiceControlAccept::empty()
        },
        exit_code: ServiceExitCode::Win32(error),
        wait_hint: if state == ServiceState::StartPending {
            START_WAIT_HINT
        } else {
            std::time::Duration::ZERO
        },
        checkpoint: 0,
        process_id: None,
    })?;
    Ok(())
}

fn service_main(_: Vec<std::ffi::OsString>) {
    let result = (|| -> Result<()> {
        let owner = OWNER.get().ok_or("Missing service owner")?;
        let stop = CancellationToken::new();
        let stopping = stop.clone();
        let status = Arc::new(OnceLock::new());
        let stopping_status = status.clone();
        let handle =
            service_control_handler::register(format!("Farstep-System-{owner}"), move |control| {
                match control {
                    ServiceControl::Stop | ServiceControl::Shutdown => {
                        // SCM must reject further controls before the crate
                        // releases this callback's context on return
                        if let Some(handle) = stopping_status.get() {
                            let _ = report(*handle, ServiceState::StopPending, 0);
                        }
                        stopping.cancel();
                        ServiceControlHandlerResult::NoError
                    }
                    ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                    _ => ServiceControlHandlerResult::NotImplemented,
                }
            })?;
        status
            .set(handle)
            .map_err(|_| "Service status already initialized")?;
        report(handle, ServiceState::StartPending, 0)?;
        let result = tokio::runtime::Runtime::new()
            .map_err(Into::into)
            .and_then(|runtime| runtime.block_on(serve(owner.clone(), handle, stop)));
        report(
            handle,
            ServiceState::Stopped,
            if result.is_ok() { 0 } else { 1 },
        )?;
        result
    })();
    if let Err(error) = result {
        eprintln!("farstep-service: {error}");
    }
}

async fn serve(owner: String, handle: ServiceStatusHandle, stop: CancellationToken) -> Result<()> {
    let name = format!(r"\\.\pipe\farstep-system-{owner}");
    let descriptor = HSTRING::from(format!("O:SYD:P(A;;GA;;;{owner})(A;;GA;;;SY)"));
    let mut security = PSECURITY_DESCRIPTOR::default();
    // SAFETY: Descriptor is NUL-terminated; security receives a LocalFree
    // allocation which remains live until all pipe creations finish
    let security = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &descriptor,
            SDDL_REVISION_1,
            &mut security,
            None,
        )?;
        Owned::new(HLOCAL(security.0))
    };
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: security.0,
        bInheritHandle: windows::core::BOOL(0),
    };
    let mut create = |first| {
        // SAFETY: Attributes points to the live descriptor; Windows copies
        // the security attributes during each synchronous creation
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(&name, (&raw mut attributes).cast())
        }
    };
    let mut listener = create(true)?;
    let mut tasks = tokio::task::JoinSet::new();
    report(handle, ServiceState::Running, 0)?;
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            connected = listener.connect(), if tasks.len() < MAX_CONNECTIONS => {
                connected?;
                let next = create(false)?;
                let stream = std::mem::replace(&mut listener, next);
                tasks.spawn(crate::connection(stream, owner.clone(), stop.child_token()));
            },
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
        }
    }
    while tasks.join_next().await.is_some() {}
    Ok(())
}

pub fn run(owner: String) -> Result<()> {
    validate(&owner)?;
    let name = format!("Farstep-System-{owner}");
    OWNER
        .set(owner)
        .map_err(|_| "Service owner already initialized")?;
    service_dispatcher::start(name, ffi_service_main)?;
    Ok(())
}
