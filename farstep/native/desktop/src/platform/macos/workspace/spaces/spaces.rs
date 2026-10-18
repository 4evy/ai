mod api;
mod mission;
mod model;

use std::time::Duration;

use axuielement::{process_trust, system_wide};
use backon::ConstantBuilder;
use farstep_protocol::Result;
pub(super) use model::{CreatedSpace, Handler, OwnedSpace, Removal, Snapshot};
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSBundle, NSString, NSURL};

use super::prerequisite;

fn focused_pid() -> Option<i32> {
    system_wide::system_wide()?
        .focused_application()
        .ok()??
        .pid()
        .ok()
}

pub(super) const SPACE_WAIT: ConstantBuilder = ConstantBuilder::new()
    .with_delay(Duration::from_millis(25))
    .with_max_times(120 - 1);

pub(super) fn snapshot() -> Result<Snapshot> {
    autoreleasepool(|_| {
        Ok(Snapshot {
            displays: api::topology()?,
            frontmost_pid: focused_pid(),
        })
    })
}

pub(super) fn available() -> Result<bool> {
    autoreleasepool(|_| Ok(process_trust::is_process_trusted() && !api::topology()?.is_empty()))
}

pub(super) fn handler(uri: &str) -> Result<Handler> {
    autoreleasepool(|_| {
        let url = NSURL::URLWithString(&NSString::from_str(uri))
            .ok_or_else(|| prerequisite("Invalid URI"))?;
        let application = NSWorkspace::sharedWorkspace()
            .URLForApplicationToOpenURL(&url)
            .ok_or_else(|| prerequisite("No native application handles this URI"))?;
        let bundle = NSBundle::bundleWithURL(&application)
            .ok_or_else(|| prerequisite("URI handler is not an application bundle"))?;
        Ok(Handler {
            executable: bundle
                .executablePath()
                .ok_or_else(|| prerequisite("URI handler has no executable"))?
                .to_string(),
            bundle: bundle
                .bundleIdentifier()
                .ok_or_else(|| prerequisite("URI handler has no bundle identifier"))?
                .to_string(),
        })
    })
}

pub(super) fn create() -> Result<CreatedSpace> {
    autoreleasepool(|_| mission::create())
}

pub(super) fn remove(owned: &OwnedSpace) -> Result<Removal> {
    // WindowServer may retain a terminated browser's windows briefly
    autoreleasepool(|_| {
        mission::wait_for(|| match mission::remove(owned)? {
            Removal::Occupied => Ok(None),
            removal => Ok(Some(removal)),
        })
        .map(|removal| removal.unwrap_or(Removal::Occupied))
    })
}

pub(super) fn assign(pid: u32, space: u64) -> Result<()> {
    autoreleasepool(|_| api::assign(pid, space))
}

pub(super) fn window_spaces(pid: u32) -> Result<Vec<Vec<u64>>> {
    autoreleasepool(|_| {
        api::all_windows()?
            .into_iter()
            .filter(|window| i64::from(window.owner_pid) == i64::from(pid) && window.layer == 0)
            .map(|window| api::window_spaces(window.id))
            .collect()
    })
}
