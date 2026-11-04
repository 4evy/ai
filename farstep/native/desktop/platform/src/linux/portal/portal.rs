mod discovery;
mod handle;
mod setup;
mod tokens;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use ashpd::desktop::clipboard::Clipboard;
use ashpd::desktop::remote_desktop::RemoteDesktop;
use ashpd::desktop::screencast::Stream;
pub use discovery::{discover, missing, open};
pub use handle::Handle;
use setup::CastSetup;
use tokens::token_path;

use super::eis::Eis;
use super::protocol::{Failure, Result, Source};
use super::{PRIVATE_OUTPUT, capture, direct};

pub const APP_ID: &str = "org.farstep.Farstep";

pub enum InputBackend {
    None,
    Eis(Eis),
    Notify {
        proxy: Arc<RemoteDesktop>,
        keys: std::collections::HashSet<u32>,
        buttons: std::collections::HashSet<u32>,
    },
    Direct(Arc<direct::Direct>),
}

impl InputBackend {
    pub fn name(&self) -> &'static str {
        match self {
            Self::None => "portal-screencast",
            Self::Eis(_) => "portal-eis",
            Self::Notify { .. } => "portal-notify",
            Self::Direct(_) => "compositor-socket",
        }
    }
}

pub struct Portal {
    // Abort observers before dropping the session handle and capture resources
    _monitors: tokio::task::JoinSet<()>,
    pub handle: Handle,
    pub stream: Stream,
    pub capture: capture::Capture,
    pub backend: InputBackend,
    pub clipboard: Option<Arc<Clipboard>>,
    pub clipboard_denied: bool,
    pub data_control: bool,
    pub live: Arc<AtomicBool>,
}

impl Portal {
    pub async fn create(
        source: Source,
        control: bool,
        output_name: Option<&str>,
        state: &Path,
    ) -> Result<Self> {
        if std::env::var("FARSTEP_NESTED_DESKTOP").as_deref() == Ok("cosmic") {
            if source != Source::Monitor || output_name.is_some_and(|name| name != PRIVATE_OUTPUT) {
                return Err(Failure::new(
                    "mapping-unavailable",
                    "Private desktop supports only its HEADLESS-1 monitor",
                ));
            }
            let backend = if control {
                InputBackend::Direct(direct::Direct::private().await?)
            } else {
                InputBackend::None
            };
            return Ok(Self {
                handle: Handle::Private,
                stream: serde_json::from_value(serde_json::json!([0, {}]))
                    .map_err(|error| Failure::new("backend-error", error))?,
                capture: capture::Capture::nested(),
                backend,
                clipboard: None,
                clipboard_denied: false,
                data_control: direct::discover()?.clipboard,
                live: Arc::new(AtomicBool::new(true)),
                _monitors: tokio::task::JoinSet::new(),
            });
        }
        let token_path = token_path(state, &source, control)?;
        let token = match std::fs::read_to_string(&token_path) {
            Ok(token) => {
                std::fs::remove_file(&token_path).map_err(|e| Failure::new("prerequisite", e))?;
                Some(token)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(Failure::new("prerequisite", e)),
        };
        match Self::attempt(
            source.clone(),
            control,
            output_name,
            token.as_deref(),
            &token_path,
        )
        .await
        {
            Err(e) if e.code == "invalid-restore-token" && token.is_some() => {
                Self::attempt(source, control, output_name, None, &token_path).await
            }
            result => result,
        }
    }

    async fn attempt(
        source: Source,
        control: bool,
        output_name: Option<&str>,
        token: Option<&str>,
        token_path: &Path,
    ) -> Result<Self> {
        let setup = CastSetup::connect(source).await?;
        setup
            .select(control, output_name, token)
            .await?
            .finish(setup.source_type, token_path, setup.bus)
            .await
    }
}
