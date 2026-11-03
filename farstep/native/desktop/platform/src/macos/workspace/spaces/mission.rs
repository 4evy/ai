use std::collections::HashSet;
use std::time::Duration;

use axuielement::ax_ui_element::AXUIElement;
use backon::BlockingRetryable;
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_foundation::uuid::{CFUUIDCreateString, CFUUIDRef};
use core_graphics::display::CGDisplay;
use farstep_protocol::{Failure, Result};
use objc2_app_kit::NSRunningApplication;
use objc2_foundation::{NSProcessInfo, NSString};

use super::super::prerequisite;
use super::SPACE_WAIT;
use super::api::{empty, owned, topology};
use super::model::{CreatedSpace, Display, OwnedSpace, Removal};

const WINDOW_MANAGER_MAJOR_VERSION: isize = 27;
const MISSION_ROOT_DEPTH: usize = 2;
const SPACE_CONTROL_DEPTH: usize = 3;
const MISSION_CONTROL_ANIMATION: Duration = Duration::from_millis(500);

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> CFUUIDRef;
}

fn children(element: &AXUIElement) -> Vec<AXUIElement> {
    element.children().unwrap_or_default()
}

fn find(element: &AXUIElement, identifier: &str, depth: usize) -> Option<AXUIElement> {
    if element
        .string_attribute("AXIdentifier")
        .ok()
        .flatten()
        .as_deref()
        == Some(identifier)
    {
        return Some(element.clone());
    }
    if depth == 0 {
        return None;
    }
    children(element)
        .iter()
        .find_map(|child| find(child, identifier, depth - 1))
}

fn new_mission_control() -> bool {
    NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        >= WINDOW_MANAGER_MAJOR_VERSION
}

fn application() -> Result<AXUIElement> {
    let bundle = if new_mission_control() {
        "com.apple.WindowManager"
    } else {
        "com.apple.dock"
    };
    let running =
        NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle));
    let application = running
        .firstObject()
        .ok_or_else(|| prerequisite("Mission Control application is not running"))?;
    AXUIElement::from_pid(application.processIdentifier())
        .ok_or_else(|| prerequisite("Cannot inspect Mission Control through Accessibility"))
}

fn mission_root(application: &AXUIElement) -> Option<AXUIElement> {
    if new_mission_control() {
        find(application, "mc.display", MISSION_ROOT_DEPTH).map(|_| application.clone())
    } else {
        find(application, "mc", MISSION_ROOT_DEPTH)
    }
}

pub(super) fn wait_for<T>(mut inspect: impl FnMut() -> Result<Option<T>>) -> Result<Option<T>> {
    enum Readiness {
        Pending,
        Failed(Failure),
    }
    (|| {
        inspect()
            .map_err(Readiness::Failed)?
            .ok_or(Readiness::Pending)
    })
    .retry(SPACE_WAIT)
    .when(|error| matches!(error, Readiness::Pending))
    .call()
    .map(Some)
    .or_else(|error| match error {
        Readiness::Pending => Ok(None),
        Readiness::Failed(error) => Err(error),
    })
}

fn toggle() -> bool {
    std::process::Command::new("/usr/bin/open")
        .args(["-g", "/System/Applications/Mission Control.app"])
        .status()
        .is_ok_and(|status| status.success())
}

struct MissionControl {
    application: AXUIElement,
}

impl MissionControl {
    fn open() -> Result<(Self, AXUIElement)> {
        let application = application()?;
        if mission_root(&application).is_some() {
            return Err(prerequisite(
                "Close Mission Control before launching an isolated workspace",
            ));
        }
        let guard = Self { application };
        if !toggle() {
            return Err(prerequisite(
                "Cannot open Mission Control through Accessibility",
            ));
        }
        let root = wait_for(|| {
            Ok(mission_root(&guard.application)
                .filter(|root| find(root, "mc.spaces", SPACE_CONTROL_DEPTH).is_some()))
        })?
        .ok_or_else(|| prerequisite("Cannot open Mission Control through Accessibility"))?;
        Ok((guard, root))
    }

    fn close(&self) -> bool {
        if mission_root(&self.application).is_none() {
            return true;
        }
        if !toggle() {
            return false;
        }
        wait_for(|| Ok(mission_root(&self.application).is_none().then_some(())))
            .is_ok_and(|ready| ready.is_some())
    }
}

impl Drop for MissionControl {
    fn drop(&mut self) {
        self.close();
    }
}

fn display_element(root: &AXUIElement, identifier: &str) -> Option<AXUIElement> {
    for element in children(root) {
        if element
            .string_attribute("AXIdentifier")
            .ok()
            .flatten()
            .as_deref()
            != Some("mc.display")
        {
            continue;
        }
        let mut display = element
            .i64_attribute("AXDisplayID")
            .ok()
            .flatten()
            .unwrap_or(0) as u32;
        if display == 0 {
            let (Some(origin), Some(dimensions)) = (
                element.point_attribute("AXPosition").ok().flatten(),
                element.size_attribute("AXSize").ok().flatten(),
            ) else {
                continue;
            };
            let Ok(displays) = CGDisplay::active_displays() else {
                continue;
            };
            for candidate in displays {
                let bounds = CGDisplay::new(candidate).bounds();
                if bounds.origin.x == origin.x
                    && bounds.origin.y == origin.y
                    && bounds.size.width == dimensions.width
                    && bounds.size.height == dimensions.height
                {
                    display = candidate;
                    break;
                }
            }
        }
        // SAFETY: Create returns an owned CFUUID for this valid display
        let Some(uuid) = owned(unsafe { CGDisplayCreateUUIDFromDisplayID(display) }.cast()) else {
            continue;
        };
        // SAFETY: uuid is a live CFUUID; the returned string is owned
        let name = owned(unsafe {
            CFUUIDCreateString(std::ptr::null(), uuid.as_CFTypeRef().cast()).cast()
        })?;
        if name
            .downcast::<CFString>()
            .is_some_and(|name| name == identifier)
            || identifier == "Main"
        {
            return Some(element);
        }
    }
    None
}

pub(super) fn create() -> Result<CreatedSpace> {
    let before = topology()?;
    let display = before
        .first()
        .ok_or_else(|| prerequisite("No managed display is available"))?;
    let existing: HashSet<_> = before
        .iter()
        .flat_map(|display| &display.spaces)
        .map(|space| space.id)
        .collect();
    let (mission, root) = MissionControl::open()?;
    let button = display_element(&root, &display.identifier)
        .and_then(|screen| find(&screen, "mc.spaces.add", SPACE_CONTROL_DEPTH))
        .ok_or_else(|| prerequisite("Cannot find the add Space control"))?;
    if button.perform_action("AXPress").is_err() {
        return Err(prerequisite("Cannot create a Space through Accessibility"));
    }
    let space = wait_for(|| {
        let latest = topology()?;
        let mut added = latest.iter().flat_map(|display| {
            display
                .spaces
                .iter()
                .filter(|space| !existing.contains(&space.id))
                .map(|space| OwnedSpace {
                    id: space.id,
                    uuid: space.uuid.clone(),
                    display: display.identifier.clone(),
                })
        });
        let space = added.next();
        if added.next().is_some() {
            return Err(prerequisite("Concurrent Space creation is ambiguous"));
        }
        Ok(space)
    })?
    .ok_or_else(|| prerequisite("Created Space did not appear in the managed topology"))?;
    Ok(CreatedSpace {
        space,
        mission_control_closed: mission.close(),
    })
}

fn locate(owned: &OwnedSpace) -> Result<Option<(Display, usize)>> {
    for display in topology()? {
        if let Some(index) = display.spaces.iter().position(|space| space.id == owned.id) {
            if display.spaces[index].uuid != owned.uuid || display.identifier != owned.display {
                return Err(prerequisite("Owned Space identity changed"));
            }
            return Ok(Some((display, index)));
        }
    }
    Ok(None)
}

pub(super) fn remove(owned: &OwnedSpace) -> Result<Removal> {
    let Some((display, index)) = locate(owned)? else {
        return Ok(Removal::Removed);
    };
    if display.current_space.id == owned.id {
        return Ok(Removal::Active);
    }
    if !empty(owned.id)? {
        return Ok(Removal::Occupied);
    }
    let (mission, root) = match MissionControl::open() {
        Ok(opened) => opened,
        Err(_) => return Ok(Removal::Unavailable),
    };
    let list = display_element(&root, &owned.display)
        .and_then(|screen| find(&screen, "mc.spaces.list", SPACE_CONTROL_DEPTH))
        .ok_or_else(|| prerequisite("Cannot find the owned Space thumbnail"))?;
    // Thumbnail actions become available after the Mission Control animation,
    // even though the AX controls are already present
    std::thread::sleep(MISSION_CONTROL_ANIMATION);
    let buttons = children(&list);
    let Some((latest, latest_index)) = locate(owned)? else {
        return Ok(Removal::Removed);
    };
    if latest.current_space.id == owned.id {
        return Ok(Removal::Active);
    }
    if !empty(owned.id)? {
        return Ok(Removal::Occupied);
    }
    if latest_index != index {
        return Ok(Removal::Unavailable);
    }
    let removed = buttons
        .get(index)
        .is_some_and(|button| button.perform_action("AXRemoveDesktop").is_ok());
    mission.close();
    let removed = removed && wait_for(|| Ok(locate(owned)?.is_none().then_some(())))?.is_some();
    Ok(if removed {
        Removal::Removed
    } else {
        Removal::Unavailable
    })
}
