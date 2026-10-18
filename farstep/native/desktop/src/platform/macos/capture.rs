use core_graphics::display::CGDisplay;
use farstep_protocol::*;
use screencapturekit::async_api::{AsyncSCScreenshotManager, AsyncSCShareableContent};
use screencapturekit::prelude::*;
use screencapturekit::screenshot_manager::CGImageExt;

use super::authorization::authorize;
use crate::native::{Bounds, encode, failure};

pub struct Target {
    source: Source,
    identifier: u32,
}

impl Target {
    pub async fn select(source: &Source, name: Option<&str>) -> Result<Self> {
        let content = AsyncSCShareableContent::get().await.map_err(failure)?;
        let windows = content.windows();
        let identifier = match name {
            Some(name) => name.parse::<u32>().map_err(|_| {
                Failure::new(
                    "invalid-request",
                    "outputName must be a display or window ID from farstep-desktop sources",
                )
            })?,
            None if *source == Source::Monitor => CGDisplay::main().id,
            None => windows
                .iter()
                .find(|w| w.is_on_screen() && w.window_layer() == 0 && w.is_active())
                .or_else(|| {
                    windows
                        .iter()
                        .find(|w| w.is_on_screen() && w.window_layer() == 0)
                })
                .map(SCWindow::window_id)
                .ok_or_else(|| failure("No on-screen window is available"))?,
        };
        let target = Self {
            source: source.clone(),
            identifier,
        };
        target.bounds().await?;
        Ok(target)
    }

    pub fn id(&self) -> String {
        format!("macos:{:?}:{}", self.source, self.identifier)
    }

    async fn filter(&self) -> Result<SCContentFilter> {
        let content = AsyncSCShareableContent::get().await.map_err(failure)?;
        match self.source {
            Source::Monitor => {
                let displays = content.displays();
                let display = displays
                    .iter()
                    .find(|d| d.display_id() == self.identifier)
                    .ok_or_else(|| failure("Selected display was removed"))?;
                SCContentFilter::create()
                    .with_display(display)
                    .with_excluding_windows(&[])
                    .build()
                    .map_err(failure)
            }
            Source::Window => {
                let windows = content.windows();
                let window = windows
                    .iter()
                    .find(|w| w.window_id() == self.identifier && w.is_on_screen())
                    .ok_or_else(|| failure("Selected window is no longer on screen"))?;
                SCContentFilter::create()
                    .with_window(window)
                    .build()
                    .map_err(failure)
            }
        }
    }

    pub async fn bounds(&self) -> Result<Bounds> {
        let (x, y, width, height, scale) = match self.source {
            Source::Monitor => {
                let display = CGDisplay::new(self.identifier);
                if !display.is_active() {
                    return Err(failure("Selected display is inactive"));
                }
                let rect = display.bounds();
                (
                    rect.origin.x,
                    rect.origin.y,
                    rect.size.width,
                    rect.size.height,
                    display.pixels_wide() as f64 / rect.size.width,
                )
            }
            Source::Window => {
                let content = AsyncSCShareableContent::get().await.map_err(failure)?;
                let windows = content.windows();
                let window = windows
                    .iter()
                    .find(|w| w.window_id() == self.identifier && w.is_on_screen())
                    .ok_or_else(|| failure("Selected window is no longer on screen"))?;
                let rect = window.frame();
                let scale = self.filter().await?.point_pixel_scale();
                (
                    rect.origin.x,
                    rect.origin.y,
                    rect.size.width,
                    rect.size.height,
                    f64::from(scale),
                )
            }
        };
        Ok(Bounds {
            x,
            y,
            width,
            height,
            pixels_width: (width * scale).round() as u32,
            pixels_height: (height * scale).round() as u32,
        })
    }

    pub async fn capture(&self) -> Result<(Bounds, Vec<u8>)> {
        let bounds = self.bounds().await?;
        farstep_desktop_runtime::image::validate_dimensions(
            bounds.pixels_width,
            bounds.pixels_height,
        )?;
        let config = SCStreamConfiguration::new()
            .with_width(bounds.pixels_width)
            .with_height(bounds.pixels_height)
            .with_shows_cursor(true)
            .with_ignores_shadows_single_window(true)
            .map_err(failure)?;
        let image = AsyncSCScreenshotManager::capture_image(&self.filter().await?, &config)
            .await
            .map_err(failure)?;
        if self.bounds().await? != bounds {
            return Err(Failure::new("stale-frame", "Source moved during capture"));
        }
        let width = u32::try_from(image.width()).map_err(failure)?;
        let height = u32::try_from(image.height()).map_err(failure)?;
        farstep_desktop_runtime::image::validate_dimensions(width, height)?;
        let bytes = tokio::task::spawn_blocking(move || {
            encode(width, height, &image.rgba_data().map_err(failure)?)
        })
        .await
        .map_err(failure)??;
        Ok((
            Bounds {
                pixels_width: width,
                pixels_height: height,
                ..bounds
            },
            bytes,
        ))
    }
}

pub async fn sources() -> Result<()> {
    authorize(false)?;
    let content = AsyncSCShareableContent::get().await.map_err(failure)?;
    println!(
        "{}",
        serde_json::json!({
            "monitors": content
                .displays()
                .iter()
                .map(|d| serde_json::json!({
                    "outputName": d.display_id().to_string(),
                    "width": d.width(),
                    "height": d.height()
                }))
                .collect::<Vec<_>>(),
            "windows": content
                .windows()
                .iter()
                .filter(|w| w.is_on_screen() && w.window_layer() == 0)
                .map(|w| serde_json::json!({
                    "outputName": w.window_id().to_string(),
                    "title": w.title()
                }))
                .collect::<Vec<_>>()
        })
    );
    Ok(())
}
