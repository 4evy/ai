use farstep_protocol::Result;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::native::failure;

const ABSOLUTE_COORDINATE_MAX: i64 = u16::MAX as i64;

pub fn move_pointer(x: i32, y: i32) -> Result<()> {
    // SAFETY: Metrics are queried without pointers; the input slice contains
    // one initialized mouse event and its structure size matches the API
    unsafe {
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width <= 1 || height <= 1 {
            return Err(failure("Virtual desktop dimensions are unavailable"));
        }
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: ((i64::from(x) - i64::from(left)) * ABSOLUTE_COORDINATE_MAX
                        / i64::from(width - 1)) as i32,
                    dy: ((i64::from(y) - i64::from(top)) * ABSOLUTE_COORDINATE_MAX
                        / i64::from(height - 1)) as i32,
                    dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    ..Default::default()
                },
            },
        };
        if SendInput(&[input], size_of::<INPUT>() as i32) != 1 {
            return Err(failure("Windows did not accept the pointer event"));
        }
        Ok(())
    }
}
