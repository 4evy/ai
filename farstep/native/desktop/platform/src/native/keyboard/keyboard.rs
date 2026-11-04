use enigo::Key;
use farstep_protocol::{Failure, Result};

// Named shortcuts use Enigo's key values; Unicode fallback retains platform
// behavior for characters that do not name a physical key
const NAMED_KEYS: &[(&[&str], Key)] = &[
    (&["ctrl", "control"], Key::Control),
    (&["alt", "option"], Key::Alt),
    (&["shift"], Key::Shift),
    (&["cmd", "command", "meta", "super", "win"], Key::Meta),
    (&["enter", "return"], Key::Return),
    (&["escape", "esc"], Key::Escape),
    (&["tab"], Key::Tab),
    (&["space"], Key::Space),
    (&["backspace"], Key::Backspace),
    (&["delete"], Key::Delete),
    (&["up", "arrowup"], Key::UpArrow),
    (&["down", "arrowdown"], Key::DownArrow),
    (&["left", "arrowleft"], Key::LeftArrow),
    (&["right", "arrowright"], Key::RightArrow),
    (&["home"], Key::Home),
    (&["end"], Key::End),
    (&["pageup"], Key::PageUp),
    (&["pagedown"], Key::PageDown),
    (&["f1"], Key::F1),
    (&["f2"], Key::F2),
    (&["f3"], Key::F3),
    (&["f4"], Key::F4),
    (&["f5"], Key::F5),
    (&["f6"], Key::F6),
    (&["f7"], Key::F7),
    (&["f8"], Key::F8),
    (&["f9"], Key::F9),
    (&["f10"], Key::F10),
    (&["f11"], Key::F11),
    (&["f12"], Key::F12),
];

pub(super) fn chord(text: &str) -> Result<Vec<Key>> {
    text.split('+')
        .map(|name| {
            if let Some((_, key)) = NAMED_KEYS
                .iter()
                .find(|(aliases, _)| aliases.iter().any(|alias| alias.eq_ignore_ascii_case(name)))
            {
                return Ok(*key);
            }
            let character = name
                .parse::<char>()
                .map_err(|_| Failure::new("invalid-request", format!("Unknown key: {name}")))?;
            #[cfg(target_os = "windows")]
            if character.is_ascii_alphanumeric() {
                return Ok(Key::Other(u32::from(character.to_ascii_uppercase())));
            }
            Ok(Key::Unicode(character))
        })
        .collect()
}
