use std::time::Duration;

use farstep_protocol::{MAX_REQUEST, Result};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::pipe::{Receiver, Sender};

use super::prerequisite;
use crate::native::failure;

const DEVTOOLS_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) struct DevTools {
    read: BufReader<Receiver>,
    write: Sender,
    sequence: u64,
}

impl DevTools {
    pub(super) fn new(read: Receiver, write: Sender) -> Self {
        Self {
            read: BufReader::new(read),
            write,
            sequence: 0,
        }
    }

    pub(super) async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        let request = json!({"id": self.sequence, "method": method, "params": params});
        let id = self.sequence;
        tokio::time::timeout(DEVTOOLS_TIMEOUT, async {
            self.write
                .write_all(request.to_string().as_bytes())
                .await
                .map_err(failure)?;
            self.write.write_all(&[0]).await.map_err(failure)?;
            loop {
                let mut response = Vec::new();
                let length = (&mut self.read)
                    .take(MAX_REQUEST as u64 + 1)
                    .read_until(0, &mut response)
                    .await
                    .map_err(failure)?;
                if length == 0 || length > MAX_REQUEST || response.pop() != Some(0) {
                    return Err(prerequisite(
                        "Browser DevTools pipe closed or exceeded its limit",
                    ));
                }
                let response: Value = serde_json::from_slice(&response).map_err(failure)?;
                if response["id"] != id {
                    continue;
                }
                if let Some(error) = response.get("error") {
                    return Err(prerequisite(error));
                }
                return Ok(response["result"].clone());
            }
        })
        .await
        .map_err(|_| prerequisite(format!("Timed out waiting for the owned browser: {method}")))?
    }
}
