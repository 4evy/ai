use std::sync::Arc;

use farstep_desktop_runtime::server::Shared;
use farstep_protocol::Result;
use tokio::net::windows::named_pipe::ServerOptions;
use tokio_util::sync::CancellationToken;
use windows::Win32::Foundation::HLOCAL;
use windows::Win32::Security::Authorization::*;
use windows::Win32::Security::*;
use windows::core::{HSTRING, Owned};

use super::storage::sid;
use crate::native::{failure, serve};

pub async fn daemon(shared: Result<Arc<Shared>>) -> Result<()> {
    let shared = shared?;
    let name = format!(r"\\.\pipe\farstep-desktop-{}", sid()?);
    let descriptor = HSTRING::from(format!("D:P(A;;GA;;;{})(A;;GA;;;SY)", sid()?));
    let mut security = PSECURITY_DESCRIPTOR::default();
    // SAFETY: descriptor is NUL-terminated and remains alive for the call;
    // security is writable and receives a LocalFree-owned descriptor
    let security = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &descriptor,
            SDDL_REVISION_1,
            &mut security,
            None,
        )
        .map_err(failure)?;
        Owned::new(HLOCAL(security.0))
    };
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: security.0,
        bInheritHandle: windows::core::BOOL(0),
    };
    let create = |first| {
        // SAFETY: attributes has the correct structure size and points to the
        // live security descriptor; Windows copies the attributes during pipe
        // creation and neither allocation is released until all calls finish
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(&name, (&raw mut attributes).cast())
        }
    };
    let mut create = create;
    let mut listener = create(true).map_err(failure)?;
    // Keep the descriptor alive and apply the same private DACL to every
    // instance
    let shutdown = CancellationToken::new();
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            connected = listener.connect() => {
                connected.map_err(failure)?;
                let next = create(false).map_err(failure)?;
                let stream = std::mem::replace(&mut listener, next);
                tasks.spawn(serve(stream, shared.clone(), shutdown.child_token()));
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
        }
    }
    shutdown.cancel();
    while tasks.join_next().await.is_some() {}
    Ok(())
}
