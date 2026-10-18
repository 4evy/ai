use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app::{AppSink, AppSinkCallbacks};
use gstreamer_video::{
    VideoConverter, VideoConverterConfig, VideoCropMeta, VideoFormat, VideoFrame, VideoInfo,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::protocol::{Failure, MAX_PIXELS, Result};

const FRAME_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub full_width: u32,
    pub full_height: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Geometry {
    fn from_sample(sample: &gst::Sample) -> std::result::Result<Self, gst::FlowError> {
        let caps = sample.caps().ok_or(gst::FlowError::NotNegotiated)?;
        let info = VideoInfo::from_caps(caps).map_err(|_| gst::FlowError::NotNegotiated)?;
        let mut geometry = Self {
            full_width: info.width(),
            full_height: info.height(),
            x: 0,
            y: 0,
            width: info.width(),
            height: info.height(),
        };
        if let Some(crop) = sample.buffer().and_then(|b| b.meta::<VideoCropMeta>()) {
            let (x, y, width, height) = crop.rect();
            geometry.x = x;
            geometry.y = y;
            geometry.width = width;
            geometry.height = height;
        }
        Ok(geometry)
    }

    fn valid(&self) -> bool {
        self.width > 0
            && self.height > 0
            && u64::from(self.full_width) * u64::from(self.full_height) <= MAX_PIXELS
            && [
                (self.x, self.width, self.full_width),
                (self.y, self.height, self.full_height),
            ]
            .into_iter()
            .all(|(origin, extent, full)| origin.checked_add(extent).is_some_and(|end| end <= full))
    }
}

#[derive(Default)]
struct Latest {
    sample: Option<gst::Sample>,
    geometry: Option<Geometry>,
    minimum_running_time: Option<gst::ClockTime>,
    failure: Option<Failure>,
}

#[derive(Clone)]
struct FrameObserver {
    latest: watch::Sender<Latest>,
    generation: Arc<AtomicU64>,
    stopped: CancellationToken,
}

impl FrameObserver {
    fn message(&self, message: &gst::Message) -> gst::BusSyncReply {
        if matches!(
            message.view(),
            gst::MessageView::Error(_) | gst::MessageView::Eos(_)
        ) {
            self.latest.send_modify(|state| {
                if state.failure.is_none() {
                    state.failure = Some(Failure::new(
                        "disconnected",
                        format!("PipeWire stream stopped: {message:?}"),
                    ));
                    state.sample = None;
                    self.generation.fetch_add(1, Ordering::AcqRel);
                }
                self.stopped.cancel();
            });
        }
        gst::BusSyncReply::Drop
    }

    fn sample(&self, sink: &AppSink) -> std::result::Result<gst::FlowSuccess, gst::FlowError> {
        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
        let geometry = Geometry::from_sample(&sample)?;
        let mut result = Ok(gst::FlowSuccess::Ok);
        self.latest.send_if_modified(|state| {
            if state.failure.is_some() {
                result = Err(gst::FlowError::Eos);
                return false;
            }
            if let Some(minimum) = state.minimum_running_time
                && sample
                    .buffer()
                    .and_then(|buffer| {
                        sample
                            .segment()?
                            .downcast_ref::<gst::ClockTime>()?
                            .to_running_time(buffer.pts()?)
                    })
                    .is_none_or(|time| time < minimum)
            {
                return false;
            }
            if !geometry.valid() {
                state.failure = Some(Failure::new(
                    "mapping-unavailable",
                    "Capture geometry exceeds safety limits",
                ));
                state.sample = None;
                self.stopped.cancel();
                self.generation.fetch_add(1, Ordering::AcqRel);
                result = Err(gst::FlowError::Error);
                return true;
            }
            if state.geometry.as_ref() != Some(&geometry) {
                self.generation.fetch_add(1, Ordering::AcqRel);
                state.geometry = Some(geometry);
            }
            state.sample = Some(sample);
            true
        });
        result
    }
}

enum Backend {
    Nested,
    PipeWire {
        pipeline: gst::Pipeline,
        bus: gst::Bus,
        _fd: OwnedFd,
    },
}

pub struct Capture {
    backend: Backend,
    latest: watch::Sender<Latest>,
    pub generation: Arc<AtomicU64>,
    pub stopped: CancellationToken,
}

pub struct Image {
    pub png: Vec<u8>,
    pub geometry: Geometry,
    pub generation: u64,
}

impl Capture {
    pub fn nested() -> Self {
        Self {
            backend: Backend::Nested,
            latest: watch::Sender::new(Latest::default()),
            generation: Arc::new(AtomicU64::new(0)),
            stopped: CancellationToken::new(),
        }
    }

    pub fn new(fd: OwnedFd, node: u32) -> Result<Self> {
        gst::init().map_err(|e| Failure::new("prerequisite", e))?;
        let pipeline = gst::parse::launch(&format!(
            "pipewiresrc fd={} path={} do-timestamp=true ! videoconvert ! videoflip \
             video-direction=auto ! video/x-raw,format=RGBA ! appsink name=frames max-buffers=1 \
             drop=true sync=false",
            fd.as_raw_fd(),
            node
        ))
        .map_err(|e| Failure::new("prerequisite", e))?
        .downcast::<gst::Pipeline>()
        .map_err(|_| Failure::new("backend-error", "Capture is not a pipeline"))?;
        let sink = pipeline
            .by_name("frames")
            .and_then(|e| e.downcast::<AppSink>().ok())
            .ok_or_else(|| Failure::new("prerequisite", "GStreamer app sink missing"))?;
        let latest = watch::Sender::new(Latest::default());
        let generation = Arc::new(AtomicU64::new(0));
        let stopped = CancellationToken::new();
        let bus = pipeline
            .bus()
            .ok_or_else(|| Failure::new("backend-error", "Capture bus missing"))?;
        let observer = FrameObserver {
            latest: latest.clone(),
            generation: generation.clone(),
            stopped: stopped.clone(),
        };
        let messages = observer.clone();
        // Observe terminal messages synchronously without a worker or queue
        bus.set_sync_handler(move |_, message| messages.message(message));
        sink.set_callbacks(
            AppSinkCallbacks::builder()
                .new_sample(move |sink| observer.sample(sink))
                .build(),
        );
        let capture = Self {
            backend: Backend::PipeWire {
                pipeline: pipeline.clone(),
                bus,
                _fd: fd,
            },
            latest,
            generation,
            stopped,
        };
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| Failure::new("backend-error", e))?;
        Ok(capture)
    }

    pub fn ensure_live(&self) -> Result<()> {
        let state = self.latest.borrow();
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        Ok(())
    }

    pub fn discard_sample(&self) -> Result<()> {
        let pipeline = match &self.backend {
            Backend::Nested => {
                self.generation.fetch_add(1, Ordering::AcqRel);
                return Ok(());
            }
            Backend::PipeWire { pipeline, .. } => pipeline,
        };
        // Fence queued buffers by pipeline time, not callback arrival
        let minimum = pipeline.current_running_time().ok_or_else(|| {
            Failure::new(
                "mapping-unavailable",
                "Capture clock is unavailable after input geometry changed",
            )
        })?;
        self.latest.send_modify(|state| {
            state.sample = None;
            state.minimum_running_time = Some(minimum);
            self.generation.fetch_add(1, Ordering::AcqRel);
        });
        Ok(())
    }

    pub async fn image(&self) -> Result<Image> {
        if matches!(&self.backend, Backend::Nested) {
            self.ensure_live()?;
            let mut image = super::nested::capture::image().await?;
            self.latest.send_modify(|state| {
                if state.geometry.as_ref() != Some(&image.geometry) {
                    state.geometry = Some(image.geometry.clone());
                    self.generation.fetch_add(1, Ordering::AcqRel);
                }
                image.generation = self.generation.load(Ordering::Acquire);
            });
            return Ok(image);
        }
        let mut latest = self.latest.subscribe();
        let (sample, geometry, generation) = tokio::time::timeout(FRAME_TIMEOUT, async {
            let state = latest
                .wait_for(|state| {
                    state.failure.is_some() || (state.sample.is_some() && state.geometry.is_some())
                })
                .await
                .map_err(|error| Failure::new("disconnected", error))?;
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            let sample = state
                .sample
                .clone()
                .ok_or_else(|| Failure::new("backend-error", "Capture sample missing"))?;
            let geometry = state
                .geometry
                .clone()
                .ok_or_else(|| Failure::new("backend-error", "Capture geometry missing"))?;
            Ok((sample, geometry, self.generation.load(Ordering::Acquire)))
        })
        .await
        .map_err(|_| Failure::new("disconnected", "No PipeWire frame arrived"))??;
        let image = tokio::select! {
            biased;
            _ = self.stopped.cancelled() => {
                self.ensure_live()?;
                return Err(Failure::new("disconnected", "PipeWire stream stopped"));
            },
            image = tokio::task::spawn_blocking(move || encode(sample, geometry, generation)) =>
                image.map_err(|e| Failure::new("backend-error", e))??,
        };
        self.ensure_live()?;
        Ok(image)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Backend::PipeWire { pipeline, bus, .. } = &self.backend {
            let _ = pipeline.set_state(gst::State::Null);
            bus.unset_sync_handler();
        }
    }
}

fn encode(sample: gst::Sample, geometry: Geometry, generation: u64) -> Result<Image> {
    let caps = sample
        .caps()
        .ok_or_else(|| Failure::new("backend-error", "Capture caps missing"))?;
    let input_info =
        VideoInfo::from_caps(caps).map_err(|error| Failure::new("backend-error", error))?;
    let buffer = sample
        .buffer()
        .ok_or_else(|| Failure::new("backend-error", "Capture buffer missing"))?;
    let input = VideoFrame::from_buffer_readable(buffer.to_owned(), &input_info)
        .map_err(|_| Failure::new("backend-error", "Cannot map the capture buffer for reading"))?;
    let output_info = VideoInfo::builder(VideoFormat::Rgba, geometry.width, geometry.height)
        .fps(input_info.fps())
        .interlace_mode(input_info.interlace_mode())
        .build()
        .map_err(|error| Failure::new("backend-error", error))?;
    let mut config = VideoConverterConfig::new();
    config.set_src_x(geometry.x as i32);
    config.set_src_y(geometry.y as i32);
    config.set_src_width(Some(geometry.width as i32));
    config.set_src_height(Some(geometry.height as i32));
    let converter = VideoConverter::new(&input_info, &output_info, Some(config))
        .map_err(|error| Failure::new("backend-error", error))?;
    let buffer = gst::Buffer::with_size(output_info.size())
        .map_err(|error| Failure::new("backend-error", error))?;
    let mut output = VideoFrame::from_buffer_writable(buffer, &output_info)
        .map_err(|_| Failure::new("backend-error", "Cannot map the PNG frame for writing"))?;
    converter.frame(&input, &mut output);
    let png = farstep_desktop_runtime::image::encode(
        geometry.width,
        geometry.height,
        output
            .plane_data(0)
            .map_err(|error| Failure::new("backend-error", error))?,
    )
    .map_err(Failure::from)?;
    Ok(Image {
        png,
        geometry,
        generation,
    })
}
