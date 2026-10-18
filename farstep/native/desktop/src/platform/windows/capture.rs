use farstep_protocol::*;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::Owned;

use super::authorization::authorize;
use crate::native::{Bounds, encode, failure};

const WINDOW_TITLE_CAPACITY: usize = 1024;

#[derive(Clone, Copy)]
pub enum Target {
    Window(usize),
    Monitor(usize),
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    data: LPARAM,
) -> windows::core::BOOL {
    // SAFETY: monitors passes an exclusive Vec pointer through LPARAM and
    // EnumDisplayMonitors calls this callback synchronously before returning
    unsafe {
        (&mut *(data.0 as *mut Vec<usize>)).push(monitor.0 as usize);
    }
    windows::core::BOOL(1)
}

fn monitors() -> Vec<usize> {
    let mut monitors = Vec::new();
    // SAFETY: The callback receives the exclusive vector pointer, which remains
    // alive until synchronous enumeration completes; optional filters are null
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(collect_monitor),
            LPARAM((&mut monitors as *mut Vec<usize>) as isize),
        );
    }
    monitors
}

impl Target {
    pub fn select(source: &Source, name: Option<&str>) -> Result<Self> {
        let number = name
            .map(|s| {
                s.parse::<usize>().map_err(|_| {
                    Failure::new(
                        "invalid-request",
                        "outputName must be a native ID from sources",
                    )
                })
            })
            .transpose()?;
        let target = match source {
            Source::Window => Self::Window(number.unwrap_or_else(|| {
                // SAFETY: GetForegroundWindow takes no arguments; its
                // handle is validated before any
                // operation uses it
                unsafe { GetForegroundWindow().0 as usize }
            })),
            Source::Monitor => Self::Monitor(number.unwrap_or_else(|| {
                // SAFETY: The point is passed by value and the fallback
                // flag selects a valid monitor handle
                // without dereferencing pointers
                unsafe {
                    MonitorFromPoint(
                        windows::Win32::Foundation::POINT { x: 0, y: 0 },
                        MONITOR_DEFAULTTOPRIMARY,
                    )
                    .0 as usize
                }
            })),
        };
        target.bounds()?;
        Ok(target)
    }

    pub fn id(&self) -> String {
        let (kind, id) = match self {
            Self::Window(id) => ("window", id),
            Self::Monitor(id) => ("monitor", id),
        };
        format!("win32:{kind}:{id}")
    }

    pub fn bounds(&self) -> Result<Bounds> {
        // SAFETY: Window/monitor handles are checked against live OS objects
        // before querying them; RECT and MONITORINFO outputs are initialized
        // stack values with the required MONITORINFO size
        unsafe {
            let rect = match *self {
                Self::Window(window) => {
                    let hwnd = HWND(window as *mut _);
                    if !IsWindow(Some(hwnd)).as_bool()
                        || !IsWindowVisible(hwnd).as_bool()
                        || IsIconic(hwnd).as_bool()
                    {
                        return Err(failure("Selected window is no longer visible"));
                    }
                    let mut rect = RECT::default();
                    GetWindowRect(hwnd, &mut rect).map_err(failure)?;
                    rect
                }
                Self::Monitor(monitor) => {
                    if !monitors().contains(&monitor) {
                        return Err(failure("Selected monitor was removed"));
                    }
                    let mut info = MONITORINFO {
                        cbSize: size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    GetMonitorInfoW(HMONITOR(monitor as *mut _), &mut info)
                        .ok()
                        .map_err(failure)?;
                    info.rcMonitor
                }
            };
            let width =
                u32::try_from(i64::from(rect.right) - i64::from(rect.left)).map_err(failure)?;
            let height =
                u32::try_from(i64::from(rect.bottom) - i64::from(rect.top)).map_err(failure)?;
            if width > i32::MAX as u32 || height > i32::MAX as u32 {
                return Err(failure("Invalid source dimensions"));
            }
            farstep_desktop_runtime::image::validate_dimensions(width, height)?;
            Ok(Bounds {
                x: f64::from(rect.left),
                y: f64::from(rect.top),
                width: f64::from(width),
                height: f64::from(height),
                pixels_width: width,
                pixels_height: height,
            })
        }
    }

    pub fn capture(&self) -> Result<(Bounds, Vec<u8>)> {
        authorize(false)?;
        let bounds = self.bounds()?;
        // SAFETY: Capture dimensions were validated by bounds; DC/bitmap
        // handles are checked and kept alive throughout capture, the
        // RGBA allocation matches the requested 32-bit image, and the
        // bitmap is deselected before GetDIBits and before cleanup
        // releases the Win32 resources
        unsafe {
            let dc = GetDC(None);
            if dc.is_invalid() {
                return Err(failure("Screen DC is unavailable"));
            }
            let dc = scopeguard::guard(dc, |dc| {
                ReleaseDC(None, dc);
            });
            let memory = CreateCompatibleDC(Some(*dc));
            if memory.is_invalid() {
                return Err(failure("Cannot allocate capture bitmap"));
            }
            let memory = scopeguard::guard(memory, |memory| {
                let _ = DeleteDC(memory);
            });
            let bitmap = CreateCompatibleBitmap(
                *dc,
                bounds.pixels_width as i32,
                bounds.pixels_height as i32,
            );
            if bitmap.is_invalid() {
                return Err(failure("Cannot allocate capture bitmap"));
            }
            let bitmap = Owned::new(bitmap);
            let selected = scopeguard::guard(SelectObject(*memory, (*bitmap).into()), |old| {
                SelectObject(*memory, old);
            });
            if let Self::Window(window) = *self {
                PrintWindow(
                    HWND(window as *mut _),
                    *memory,
                    PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT),
                )
                .ok()
                .map_err(failure)?;
            } else {
                BitBlt(
                    *memory,
                    0,
                    0,
                    bounds.pixels_width as i32,
                    bounds.pixels_height as i32,
                    Some(*dc),
                    bounds.x as i32,
                    bounds.y as i32,
                    SRCCOPY | CAPTUREBLT,
                )
                .map_err(failure)?;
            }
            // GetDIBits requires the bitmap to be deselected from the DC
            drop(selected);
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: bounds.pixels_width as i32,
                    biHeight: -(bounds.pixels_height as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels =
                vec![0_u8; bounds.pixels_width as usize * bounds.pixels_height as usize * 4];
            if GetDIBits(
                *dc,
                *bitmap,
                0,
                bounds.pixels_height,
                Some(pixels.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            ) != bounds.pixels_height as i32
            {
                return Err(failure("Incomplete capture bitmap"));
            }
            for pixel in pixels.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
                pixel[3] = u8::MAX;
            }
            if self.bounds()? != bounds {
                return Err(Failure::new("stale-frame", "Source moved during capture"));
            }
            let png = encode(bounds.pixels_width, bounds.pixels_height, &pixels)?;
            Ok((bounds, png))
        }
    }
}

unsafe extern "system" fn collect_window(hwnd: HWND, data: LPARAM) -> windows::core::BOOL {
    // SAFETY: EnumWindows supplies a window handle and the exclusive vector
    // pointer from sources; title is a live UTF-16 buffer and GetWindowTextW
    // returns a length bounded by that buffer
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return windows::core::BOOL(1);
        }
        let mut title = [0_u16; WINDOW_TITLE_CAPACITY];
        let length = GetWindowTextW(hwnd, &mut title);
        if length <= 0 {
            return windows::core::BOOL(1);
        }
        (&mut *(data.0 as *mut Vec<serde_json::Value>)).push(serde_json::json!({
            "outputName": (hwnd.0 as usize).to_string(),
            "title": String::from_utf16_lossy(&title[..length as usize])
        }));
    }
    windows::core::BOOL(1)
}

pub fn sources() -> Result<()> {
    authorize(false)?;
    let mut windows = Vec::<serde_json::Value>::new();
    // SAFETY: The callback receives an exclusive pointer to windows, which
    // stays alive until EnumWindows finishes its synchronous callbacks
    unsafe {
        EnumWindows(
            Some(collect_window),
            LPARAM((&mut windows as *mut Vec<serde_json::Value>) as isize),
        )
        .map_err(failure)?;
    }
    println!(
        "{}",
        serde_json::json!({
            "monitors": monitors()
                .iter()
                .map(|id| serde_json::json!({"outputName": id.to_string()}))
                .collect::<Vec<_>>(),
            "windows": windows
        })
    );
    Ok(())
}
