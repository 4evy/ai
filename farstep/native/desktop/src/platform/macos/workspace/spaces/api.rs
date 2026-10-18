use std::ffi::CStr;
use std::sync::LazyLock;

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::number::CFNumber;
use core_graphics::window::{copy_window_info, kCGNullWindowID, kCGWindowListOptionAll};
use dlopen2::wrapper::{Container, WrapperApi};
use farstep_protocol::Result;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSJSONSerialization, NSJSONWritingOptions};
use serde::de::DeserializeOwned;

use super::super::prerequisite;
use super::model::{Display, Window};

const ALL_SPACE_TYPES: i32 = 7;
const SPACE_WINDOW_OPTIONS: u32 = 7;

#[derive(WrapperApi)]
struct Api {
    #[dlopen2_name = "SLSMainConnectionID"]
    connection: unsafe extern "C" fn() -> i32,
    #[dlopen2_name = "SLSCopyManagedDisplaySpaces"]
    displays: unsafe extern "C" fn(connection: i32) -> CFArrayRef,
    #[dlopen2_name = "SLSCopySpacesForWindows"]
    window_spaces:
        unsafe extern "C" fn(connection: i32, types: i32, windows: CFArrayRef) -> CFArrayRef,
    #[dlopen2_name = "SLSCopyWindowsWithOptionsAndTags"]
    space_windows: unsafe extern "C" fn(
        connection: i32,
        owner: u32,
        spaces: CFArrayRef,
        options: u32,
        set: *mut u64,
        clear: *mut u64,
    ) -> CFArrayRef,
    #[dlopen2_name = "SLSProcessAssignToSpace"]
    assign: unsafe extern "C" fn(connection: i32, pid: i32, space: u64) -> i32,
}

fn api() -> Result<&'static Container<Api>> {
    static API: LazyLock<Option<Container<Api>>> = LazyLock::new(|| {
        // SAFETY: Load the system framework at its absolute path with
        // signatures matching SkyLight, keeping its symbols in the Container
        unsafe {
            Container::load("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight").ok()
        }
    });
    API.as_ref()
        .ok_or_else(|| prerequisite("Required SkyLight Space APIs are unavailable"))
}

pub(super) fn owned(pointer: CFTypeRef) -> Option<CFType> {
    if pointer.is_null() {
        None
    } else {
        // SAFETY: Callers supply a non-null CF object returned by a Create/Copy
        // function, transferring its +1 ownership to this reference
        Some(unsafe { CFType::wrap_under_create_rule(pointer) })
    }
}

fn decode<T: DeserializeOwned>(value: &CFType) -> Result<T> {
    let array = value
        .downcast::<CFArray>()
        .ok_or_else(|| prerequisite("Native workspace result is not an array"))?;
    // SAFETY: The native APIs return arrays of CF property-list objects, which
    // are toll-free bridged to Foundation; array retains the immutable tree
    let bytes = unsafe {
        let object = &*array.as_CFTypeRef().cast::<AnyObject>();
        NSJSONSerialization::dataWithJSONObject_options_error(object, NSJSONWritingOptions::empty())
    }
    .map_err(prerequisite)?;
    serde_json::from_slice(&bytes.to_vec()).map_err(prerequisite)
}

pub(super) fn topology() -> Result<Vec<Display>> {
    let api = api()?;
    // SAFETY: Resolved signatures match SkyLight; Copy returns an owned array
    let array = owned(unsafe { api.displays(api.connection()).cast() })
        .ok_or_else(|| prerequisite("Cannot read managed display Spaces"))?;
    decode(&array)
}

pub(super) fn window_spaces(id: u64) -> Result<Vec<u64>> {
    let api = api()?;
    let ids = CFArray::from_CFTypes(&[CFNumber::from(id as i64)]);
    // SAFETY: ids is a live array of window numbers; Copy returns an owned
    // array
    let result = owned(unsafe {
        api.window_spaces(api.connection(), ALL_SPACE_TYPES, ids.as_concrete_TypeRef())
            .cast()
    })
    .ok_or_else(|| prerequisite("Cannot read window Spaces"))?;
    decode(&result)
}

pub(super) fn all_windows() -> Result<Vec<Window>> {
    let result = copy_window_info(kCGWindowListOptionAll, kCGNullWindowID)
        .ok_or_else(|| prerequisite("Cannot inspect desktop windows"))?;
    decode(&result.as_CFType())
}

fn system_compositor(pid: i32) -> bool {
    let mut path = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: The process path buffer is writable and its size is supplied
    let length = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if length <= 0 {
        return false;
    }
    let path = CStr::from_bytes_until_nul(&path)
        .ok()
        .and_then(|path| path.to_str().ok());
    let Some(path) = path else {
        return false;
    };
    [
        "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
        "/System/Library/CoreServices/WindowManager.app/Contents/MacOS/WindowManager",
        "/System/Library/CoreServices/WallpaperAgent.app/Contents/MacOS/WallpaperAgent",
    ]
    .iter()
    .any(|system| {
        std::fs::canonicalize(system).is_ok_and(|system| system == std::path::Path::new(path))
    })
}

pub(super) fn empty(id: u64) -> Result<bool> {
    let api = api()?;
    let spaces = CFArray::from_CFTypes(&[CFNumber::from(id as i64)]);
    let mut set = 0;
    let mut clear = 0;
    // SAFETY: spaces and tag outputs are live; Copy returns an owned array
    let windows = owned(unsafe {
        api.space_windows(
            api.connection(),
            0,
            spaces.as_concrete_TypeRef(),
            SPACE_WINDOW_OPTIONS,
            &mut set,
            &mut clear,
        )
        .cast()
    })
    .ok_or_else(|| prerequisite("Cannot inspect owned Space occupancy"))?;
    let windows: Vec<u64> = decode(&windows)?;
    let metadata = all_windows()?;
    for number in windows {
        let Some(window) = metadata.iter().find(|window| window.id == number) else {
            return Ok(false);
        };
        // Wallpaper and the menu bar exist even on empty Spaces; global windows
        // shared with other Spaces are not occupants exclusive to this desktop
        if system_compositor(window.owner_pid) {
            continue;
        }
        let memberships = window_spaces(number)?;
        if memberships.len() > 1 && memberships.contains(&id) {
            continue;
        }
        return Ok(false);
    }
    Ok(true)
}

pub(super) fn assign(pid: u32, space: u64) -> Result<()> {
    let api = api()?;
    // SAFETY: The helper owns pid and space; resolved signature
    // matches the SkyLight process-to-Space
    // assignment function
    let status = unsafe { api.assign(api.connection(), pid as i32, space) };
    if status != 0 {
        return Err(prerequisite(
            "WindowServer refused process-to-Space assignment",
        ));
    }
    Ok(())
}
