use std::io;
use std::os::fd::OwnedFd;

use futures_util::{Stream, StreamExt};
use reis::ei;
use reis::event::EiEvent;

use super::super::portal::APP_ID;
use super::super::protocol::{Failure, Result};
use super::DEVICE_TIMEOUT;

async fn handshake(
    raw: &mut (impl Stream<Item = io::Result<reis::PendingRequestResult<ei::Event>>> + Unpin),
) -> Result<reis::handshake::HandshakeResp> {
    tokio::time::timeout(DEVICE_TIMEOUT, async {
        let mut handshake =
            reis::handshake::EiHandshaker::new(APP_ID, ei::handshake::ContextType::Sender);
        while let Some(event) = raw.next().await {
            let event = match event.map_err(|e| Failure::new("disconnected", e))? {
                reis::PendingRequestResult::Request(event) => event,
                reis::PendingRequestResult::ParseError(error) => {
                    return Err(Failure::new("disconnected", error));
                }
                reis::PendingRequestResult::InvalidObject(id) => {
                    return Err(Failure::new(
                        "disconnected",
                        format!("Invalid EI handshake object {id}"),
                    ));
                }
            };
            if let Some(response) = handshake
                .handle_event(event)
                .map_err(|e| Failure::new("disconnected", e))?
            {
                return Ok(response);
            }
        }
        Err(Failure::new(
            "disconnected",
            "EI socket closed during handshake",
        ))
    })
    .await
    .map_err(|_| Failure::new("disconnected", "EI handshake timed out"))?
}

pub(super) async fn initialize(
    fd: OwnedFd,
) -> Result<(
    reis::event::Connection,
    impl Stream<Item = std::result::Result<EiEvent, reis::Error>> + Unpin,
)> {
    let context = ei::Context::new(std::os::unix::net::UnixStream::from(fd))
        .map_err(|e| Failure::new("disconnected", e))?;
    let reader =
        async_io::Async::new(context.clone()).map_err(|e| Failure::new("disconnected", e))?;
    // reis 0.7.1's streams miss wakeups after partial messages; read_with
    // retries WouldBlock and owns readiness registration for each new read
    let mut raw = Box::pin(futures_util::stream::unfold(reader, |reader| async move {
        let event = reader
            .read_with(|context| {
                if let Some(event) = context.pending_event() {
                    return Ok(event);
                }
                context.read()?;
                context
                    .pending_event()
                    .ok_or_else(|| io::ErrorKind::WouldBlock.into())
            })
            .await;
        match event {
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => None,
            event => Some((event, reader)),
        }
    }));
    let response = handshake(&mut raw).await?;
    let converter = reis::event::EiEventConverter::new(&context, response);
    let connection = converter.connection().clone();
    let stream =
        futures_util::stream::unfold((raw, converter), |(mut raw, mut converter)| async move {
            loop {
                if let Some(event) = converter.next_event() {
                    return Some((Ok(event), (raw, converter)));
                }
                match raw.next().await? {
                    Ok(reis::PendingRequestResult::Request(event)) => {
                        if let Err(error) = converter.handle_event(event) {
                            return Some((Err(reis::Error::from(error)), (raw, converter)));
                        }
                    }
                    Ok(reis::PendingRequestResult::InvalidObject(_)) => {}
                    Ok(reis::PendingRequestResult::ParseError(error)) => {
                        return Some((Err(reis::Error::from(error)), (raw, converter)));
                    }
                    Err(error) => {
                        return Some((Err(reis::Error::from(error)), (raw, converter)));
                    }
                }
            }
        });
    Ok::<_, Failure>((connection, Box::pin(stream)))
}
