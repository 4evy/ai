use std::io::{Cursor, Write};

use bytes::BufMut;
use farstep_protocol::{Failure, MAX_PIXELS, MAX_PNG, Result};

pub fn validate_dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(Failure::new(
            "capture-limit",
            "Invalid or excessive image dimensions",
        ));
    }
    Ok(())
}

/// Read bounded PNG dimensions without decoding the image's pixel allocation
pub fn dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    validate_size(bytes)?;
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits { bytes: MAX_PNG });
    let info = decoder.read_header_info().map_err(failure)?;
    validate_dimensions(info.width, info.height)?;
    Ok((info.width, info.height))
}

pub fn encode(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    validate_dimensions(width, height)?;
    let expected = usize::try_from(u64::from(width) * u64::from(height) * 4).map_err(failure)?;
    if rgba.len() != expected {
        return Err(failure("RGBA buffer does not match image dimensions"));
    }
    let mut bytes = Vec::new().limit(MAX_PNG).writer();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(failure)?;
        // Stream compressed chunks so oversized output fails without buffering
        // the entire compressed image
        {
            let mut stream = writer.stream_writer().map_err(failure)?;
            stream.write_all(rgba).map_err(failure)?;
            stream.finish().map_err(failure)?;
        }
        writer.finish().map_err(failure)?;
    }
    Ok(bytes.into_inner().into_inner())
}

fn validate_size(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_PNG {
        return Err(Failure::new("capture-limit", "PNG exceeds 32 MiB"));
    }
    Ok(())
}

fn failure(error: impl ToString) -> Failure {
    Failure::new("capture-limit", error)
}
