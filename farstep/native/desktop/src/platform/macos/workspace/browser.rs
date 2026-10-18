use std::time::Duration;

use backon::Retryable;
use farstep_protocol::{Failure, Result};
use serde_json::json;

use super::super::{protect_directory, state};
use super::devtools::DevTools;
use super::spaces::{self, OwnedSpace, Snapshot};
use super::{available, mutate, prerequisite, process};
use crate::native::failure;

const CHROMIUM_HANDLERS: &[&str] = &[
    "net.imput.helium",
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.google.Chrome.dev",
    "com.google.Chrome.canary",
    "org.chromium.Chromium",
    "com.brave.Browser",
    "com.brave.Browser.beta",
    "com.brave.Browser.nightly",
];

const BROWSER_STOP_GRACE: Duration = Duration::from_millis(300);

#[derive(Default)]
pub(super) struct Browser {
    // Do not reap the leader before killing its group: the unreaped PID keeps
    // the process group identity from being reused by an unrelated launch
    child: Option<std::process::Child>,
    profile: Option<tempfile::TempDir>,
    pub(super) space: Option<OwnedSpace>,
    devtools: Option<DevTools>,
}

impl Browser {
    pub(super) fn pid(&self) -> u32 {
        self.child.as_ref().map_or(0, std::process::Child::id)
    }

    fn launch(&mut self, executable: &str) -> Result<(DevTools, Snapshot)> {
        let state = state()?;
        protect_directory(&state)?;
        let mut profile = tempfile::Builder::new()
            .prefix("workspace-")
            .tempdir_in(&state)
            .map_err(failure)?;
        // Retain the directory on an abnormal helper exit; never delete a
        // profile that may still be used by a live GUI process
        profile.disable_cleanup(true);
        let arguments = vec![
            format!("--user-data-dir={}", profile.path().display()),
            "--no-startup-window".into(),
            "--no-first-run".into(),
            "--no-default-browser-check".into(),
            "--remote-debugging-pipe".into(),
        ];
        self.profile = Some(profile);
        let before = spaces::snapshot()?;
        let (child, read, write) = process::spawn(executable, &arguments)?;
        self.child = Some(child);
        Ok((DevTools::new(read, write), before))
    }

    fn assign_space(&mut self) -> Result<u64> {
        let created = mutate(spaces::create)?;
        let space_id = created.space.id;
        self.space = Some(created.space);
        if !created.mission_control_closed {
            return Err(prerequisite("Cannot close Mission Control"));
        }
        spaces::assign(self.pid(), space_id)?;
        Ok(space_id)
    }

    pub(super) fn stop(&mut self) -> Result<()> {
        self.devtools.take();
        if let Some(child) = &mut self.child {
            let group = rustix::process::Pid::from_raw(child.id() as i32)
                .ok_or_else(|| failure("Owned browser has no process group"))?;
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::TERM);
            std::thread::sleep(BROWSER_STOP_GRACE);
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
            child.wait().map_err(failure)?;
            self.child.take();
        }
        if let Some(profile) = self.profile.take() {
            profile.close().map_err(failure)?;
        }
        if let Some(space) = self.space.take()
            && let Some(reason) = mutate(|| spaces::remove(&space))?.retained_reason()
        {
            return Err(Failure::new(
                "workspace-retained",
                format!("The owned browser stopped. Its Space was retained because {reason}"),
            ));
        }
        Ok(())
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub(super) async fn prepare(uri: &str, browser: &mut Browser) -> Result<()> {
    if !available() {
        return Err(prerequisite(
            "Grant Farstep Accessibility access in an unlocked macOS desktop to create Spaces",
        ));
    }
    let handler = spaces::handler(uri)?;
    let bundle = handler.bundle.as_str();
    if !CHROMIUM_HANDLERS.contains(&bundle) {
        return Err(Failure::new(
            "unsupported-operation",
            format!(
                "URI handler {bundle} has no verified isolated launch contract; use a Chromium \
                 browser as the native handler"
            ),
        ));
    }
    let (mut devtools, before) = browser.launch(&handler.executable)?;
    devtools.call("Browser.getVersion", json!({})).await?;
    let space_id = browser.assign_space()?;
    // Start without a window, bind the process before mapping, then ask the
    // browser to create a background window without activating the app
    devtools
        .call(
            "Target.createTarget",
            json!({"url": uri, "newWindow": true, "background": true}),
        )
        .await?;
    let browser_ref = &*browser;
    let before_ref = &before;
    (|| async move { verify_assignment(browser_ref, before_ref, space_id) })
        .retry(spaces::SPACE_WAIT)
        .when(|error| error.code == "workspace-pending")
        .await
        .map_err(|mut error| {
            if error.code == "workspace-pending" {
                error.code = "prerequisite";
            }
            error
        })?;
    browser.devtools = Some(devtools);
    Ok(())
}

fn verify_assignment(browser: &Browser, before: &Snapshot, space_id: u64) -> Result<()> {
    let windows = spaces::window_spaces(browser.pid())?;
    let ready = !windows.is_empty() && windows.iter().all(|spaces| spaces == &[space_id]);
    if !ready {
        return Err(Failure::new(
            "workspace-pending",
            "Browser windows did not enter the owned inactive Space",
        ));
    }
    let after = spaces::snapshot()?;
    if !before.current_spaces().eq(after.current_spaces())
        || before.frontmost_pid != after.frontmost_pid
    {
        return Err(prerequisite(
            "The active desktop or application changed during the isolated launch",
        ));
    }
    Ok(())
}
