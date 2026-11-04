use std::io;
use std::os::fd::AsFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

use command_fds::{CommandFdExt, FdMapping};
use farstep_protocol::Result;
use tokio::net::unix::pipe::{Receiver, Sender};

use super::failure;

const DEVTOOLS_READ_FD: i32 = 3;
const DEVTOOLS_WRITE_FD: i32 = 4;

// The owner provides a pipe rather than a terminal; poll it directly so a
// blocked stdin thread cannot prevent helper shutdown after a signal
pub fn owner_input() -> Result<Receiver> {
    let fd = io::stdin().as_fd().try_clone_to_owned().map_err(failure)?;
    Receiver::from_owned_fd(fd).map_err(failure)
}

pub fn spawn(executable: &str, arguments: &[String]) -> Result<(Child, Receiver, Sender)> {
    let (child_read, write) = io::pipe().map_err(failure)?;
    let (read, child_write) = io::pipe().map_err(failure)?;
    // Register parent ends before spawning, so registration failures cannot
    // leave a child running without an owner
    let read = Receiver::from_owned_fd(read.into()).map_err(failure)?;
    let write = Sender::from_owned_fd(write.into()).map_err(failure)?;
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .process_group(0);
    command
        .fd_mappings(vec![
            FdMapping {
                parent_fd: child_read.into(),
                child_fd: DEVTOOLS_READ_FD,
            },
            FdMapping {
                parent_fd: child_write.into(),
                child_fd: DEVTOOLS_WRITE_FD,
            },
        ])
        .map_err(failure)?;
    let child = command.spawn().map_err(failure)?;
    // Browser owns this unreaped child and its process group until shutdown
    Ok((child, read, write))
}
