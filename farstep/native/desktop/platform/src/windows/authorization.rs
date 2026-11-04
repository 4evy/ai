use farstep_protocol::{Failure, Result};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::StationsAndDesktops::*;
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::HiDpi::*;
use windows::Win32::UI::Shell::IsUserAnAdmin;
use windows::core::Owned;

const DESKTOP_NAME_CAPACITY: usize = 128;

fn interactive() -> bool {
    // SAFETY: Output pointers refer to live stack values; the UTF-16 buffer's
    // byte size is supplied to Win32 and the desktop handle is closed afterward
    unsafe {
        let mut session = 0;
        if ProcessIdToSessionId(GetCurrentProcessId(), &mut session).is_err() || session == 0 {
            return false;
        }
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let desktop = Owned::new(desktop);
        let mut name = [0_u16; DESKTOP_NAME_CAPACITY];
        let mut needed = 0;
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            size_of_val(&name) as u32,
            Some(&mut needed),
        )
        .is_ok()
            && String::from_utf16_lossy(
                &name[..name.iter().position(|c| *c == 0).unwrap_or(name.len())],
            )
            .eq_ignore_ascii_case("Default")
    }
}

pub fn capture_granted() -> bool {
    interactive()
}

pub fn input_granted() -> bool {
    interactive()
}

pub fn authorize(_: bool) -> Result<()> {
    // SAFETY: The predefined DPI awareness context is a valid Win32 constant
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    if !interactive() {
        return Err(Failure::new(
            "permission-denied",
            "Run the Farstep interactive Administrator task in a logged-in desktop; locked and \
             secure desktops are unavailable",
        ));
    }
    Ok(())
}

pub fn permissions() -> Result<()> {
    // SAFETY: IsUserAnAdmin takes no pointers or owned resources
    let administrator = unsafe { IsUserAnAdmin().as_bool() };
    println!(
        "{}",
        serde_json::json!({
            "interactive": interactive(),
            "administrator": administrator,
            "setup": "Run install.ps1 as Administrator to configure the elevated interactive task \
                      and application firewall rules"
        })
    );
    Ok(())
}
