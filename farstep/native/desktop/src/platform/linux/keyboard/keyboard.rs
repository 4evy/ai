use std::collections::HashSet;
use std::os::fd::OwnedFd;
use std::os::unix::fs::FileExt;

use xkbcommon::xkb;

use super::MAX_KEYMAP_BYTES;
use super::protocol::{Failure, Result};

const MAX_CHORD_BYTES: usize = 1024;

const KEY_ALIASES: &[(&[&str], &str)] = &[
    (&["ctrl", "control"], "Control_L"),
    (&["alt"], "Alt_L"),
    (&["shift"], "Shift_L"),
    (&["super", "win", "cmd", "command"], "Super_L"),
    (&["meta"], "Meta_L"),
    (&["enter"], "Return"),
    (&["esc"], "Escape"),
    (&["space"], "space"),
];

pub fn keymap(fd: OwnedFd, size: u32, backend: &str) -> Result<xkb::Keymap> {
    if size > MAX_KEYMAP_BYTES {
        return Err(Failure::new(
            "backend-error",
            format!("{backend} keymap exceeds limit"),
        ));
    }
    // SCM_RIGHTS FDs share offsets; leave the compositor's offset unchanged
    let mut bytes = vec![0; size as usize];
    std::fs::File::from(fd)
        .read_exact_at(&mut bytes, 0)
        .map_err(|error| Failure::new("backend-error", error))?;
    let mut text =
        String::from_utf8(bytes).map_err(|error| Failure::new("backend-error", error))?;
    text.truncate(text.trim_end_matches('\0').len());
    let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
    xkb::Keymap::new_from_string(
        &context,
        text,
        xkb::KEYMAP_FORMAT_TEXT_V1,
        xkb::KEYMAP_COMPILE_NO_FLAGS,
    )
    .ok_or_else(|| {
        Failure::new(
            "backend-error",
            format!("Invalid {backend} keyboard keymap"),
        )
    })
}

pub fn chord_symbols(chord: Option<&str>) -> Result<Vec<u32>> {
    let Some(chord) = chord else {
        return Ok(Vec::new());
    };
    if chord.len() > MAX_CHORD_BYTES {
        return Err(Failure::new("invalid-request", "Key chord exceeds limit"));
    }
    let mut seen = HashSet::new();
    chord
        .split('+')
        .map(|part| {
            let part = part.trim();
            let name = KEY_ALIASES
                .iter()
                .find(|(aliases, _)| aliases.iter().any(|alias| alias.eq_ignore_ascii_case(part)))
                .map_or(part, |(_, name)| *name);
            let symbol = xkb::keysym_from_name(name, xkb::KEYSYM_NO_FLAGS).raw();
            if symbol == xkb::keysyms::KEY_NoSymbol
                || symbol == xkb::keysyms::KEY_VoidSymbol
                || !seen.insert(symbol)
            {
                return Err(Failure::new(
                    "invalid-request",
                    format!("Unknown or duplicate keysym: {part}"),
                ));
            }
            Ok(symbol)
        })
        .collect()
}
