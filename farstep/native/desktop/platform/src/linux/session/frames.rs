use std::sync::atomic::Ordering;

use super::super::capture;
use super::super::portal::{Handle, InputBackend};
use super::super::protocol::*;
use super::{Latest, Session};

impl Session {
    pub async fn capture(&mut self) -> Result<(Frame, Vec<u8>)> {
        let (image, input_generation) = self.capture_image().await?;
        let base = self.base_geometry(image.generation).await?;
        if let Err(error) = self.ensure_live() {
            self.invalidate().await;
            return Err(error);
        }
        if image.generation != self.portal.capture.generation.load(Ordering::Acquire)
            || input_generation != self.input_generation()
        {
            self.invalidate().await;
            return Err(Failure::new(
                "stale-frame",
                "Capture or input geometry changed while capturing",
            ));
        }
        // videoflip normalizes orientation; crop offsets remain stream-relative
        let logical = base.map(|base| Geometry {
            x: base.x
                + f64::from(image.geometry.x) / f64::from(image.geometry.full_width) * base.width,
            y: base.y
                + f64::from(image.geometry.y) / f64::from(image.geometry.full_height) * base.height,
            width: f64::from(image.geometry.width) / f64::from(image.geometry.full_width)
                * base.width,
            height: f64::from(image.geometry.height) / f64::from(image.geometry.full_height)
                * base.height,
        });
        let mapping_id = match &self.portal.backend {
            InputBackend::Direct(d) => Some(format!("wayland-output:{}", d.output_name)),
            _ => self.portal.stream.mapping_id().map(str::to_owned),
        };
        let frame = Frame {
            session_id: self.id.clone(),
            stream_id: if matches!(&self.portal.handle, Handle::Private) {
                "private:HEADLESS-1".into()
            } else {
                self.portal.stream.pipe_wire_node_id().to_string()
            },
            frame_id: uuid::Uuid::new_v4().to_string(),
            source: self.source.clone(),
            width: image.geometry.width,
            height: image.geometry.height,
            bytes: image.png.len(),
            logical_geometry: logical,
            transform: 0,
            mapping_id,
        };
        self.latest = Some(Latest {
            frame: frame.clone(),
            geometry: image.geometry,
            capture_generation: image.generation,
            input_generation: self.input_generation(),
        });
        Ok((frame, image.png))
    }

    async fn capture_image(&mut self) -> Result<(capture::Image, u64)> {
        if let Err(error) = self.ensure_live() {
            self.invalidate().await;
            return Err(error);
        }
        let input_generation = self.input_generation();
        if self.capture_input_generation != input_generation {
            self.invalidate().await;
            self.portal.capture.discard_sample()?;
            self.capture_input_generation = input_generation;
        }
        let image = match self.portal.capture.image().await {
            Ok(image) => image,
            Err(error) => {
                self.invalidate().await;
                return Err(error);
            }
        };
        if self.latest.as_ref().is_some_and(|f| {
            f.capture_generation != image.generation
                || f.input_generation != self.input_generation()
        }) {
            self.release_input().await;
        }
        Ok((image, input_generation))
    }

    async fn base_geometry(&self, generation: u64) -> Result<Option<Geometry>> {
        Ok(match &self.portal.backend {
            InputBackend::Direct(direct) => Some(direct.geometry()?),
            InputBackend::Eis(eis) => match self.portal.stream.mapping_id() {
                Some(mapping) => match eis.geometry(mapping).await {
                    Ok(geometry) => Some(geometry),
                    Err(error) if error.code == "mapping-unavailable" => None,
                    Err(error) => return Err(error),
                },
                None => None,
            },
            InputBackend::Notify { .. } if generation > 1 => None,
            _ => self
                .portal
                .stream
                .size()
                .filter(|(w, h)| *w > 0 && *h > 0)
                .map(|(width, height)| {
                    let (x, y) = self.portal.stream.position().unwrap_or((0, 0));
                    Geometry {
                        x: f64::from(x),
                        y: f64::from(y),
                        width: f64::from(width),
                        height: f64::from(height),
                    }
                }),
        })
    }

    pub(super) fn point(&self, point: &Point) -> Result<(f64, f64)> {
        self.ensure_live()?;
        if self.invalidated() {
            return Err(Failure::new(
                "stale-frame",
                "Frame or geometry generation is stale",
            ));
        }
        let latest = self
            .latest
            .as_ref()
            .ok_or_else(|| Failure::new("stale-frame", "Capture a fresh frame before input"))?;
        if latest.frame.logical_geometry.is_none() {
            return Err(Failure::new(
                "mapping-unavailable",
                "Captured source has no authoritative input geometry",
            ));
        }
        if !(0.0..f64::from(latest.frame.width)).contains(&point.x)
            || !(0.0..f64::from(latest.frame.height)).contains(&point.y)
        {
            return Err(Failure::new(
                "invalid-request",
                "Pointer point is outside the captured frame",
            ));
        }
        Ok((
            (point.x + f64::from(latest.geometry.x)) / f64::from(latest.geometry.full_width),
            (point.y + f64::from(latest.geometry.y)) / f64::from(latest.geometry.full_height),
        ))
    }
}
