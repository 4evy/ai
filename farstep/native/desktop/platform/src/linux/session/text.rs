use super::super::clipboard;
use super::super::portal::InputBackend;
use super::super::protocol::*;
use super::Session;

// EI text requests allow 255 bytes including the terminating NUL
const MAX_EI_TEXT_BYTES: usize = u8::MAX as usize - 1;

impl Session {
    pub(super) async fn text(&mut self, input: TypeText) -> Result<Receipt> {
        let mut receipt = Receipt::default();
        if input.text.is_empty() {
            return Ok(receipt);
        }
        if let InputBackend::Eis(eis) = &self.portal.backend
            && eis.has_text().await
        {
            receipt.mechanism = "ei-text";
            self.set_receipt(&receipt);
            let mut remaining = input.text.as_str();
            while !remaining.is_empty() {
                let end = remaining.floor_char_boundary(MAX_EI_TEXT_BYTES);
                let (chunk, rest) = remaining.split_at_checked(end).ok_or_else(|| {
                    Failure::new("backend-error", "Text chunk boundary is invalid")
                })?;
                receipt.partial = true;
                self.set_receipt(&receipt);
                if let Err(mut error) = eis.text(chunk).await {
                    receipt.partial = receipt.submitted_bytes > 0 || error.code == "partial-input";
                    error.receipt = Some(receipt);
                    return Err(error);
                }
                receipt.submitted_bytes += end;
                receipt.partial = false;
                self.set_receipt(&receipt);
                remaining = rest;
            }
            return Ok(receipt);
        }
        let keys = self
            .keys(Some(input.paste_key.as_deref().unwrap_or("Ctrl+v")))
            .await?;
        let effects = self
            .last_receipt
            .clone()
            .ok_or_else(|| Failure::new("backend-error", "Text effect receipt missing"))?;
        let (owner, mechanism) = clipboard::publish(&self.portal, &input.text, effects).await?;
        receipt.mechanism = mechanism;
        receipt.clipboard_changed = true;
        receipt.partial = true;
        self.set_receipt(&receipt);
        self.clipboard = Some(owner);
        let submitted = async {
            for key in &keys {
                self.key(*key, true).await?;
            }
            for key in keys.iter().rev() {
                self.key(*key, false).await?;
            }
            Ok::<(), Failure>(())
        }
        .await;
        if let Err(mut error) = submitted {
            receipt.partial = true;
            error.receipt = Some(receipt);
            return Err(error);
        }
        receipt.submitted_bytes = input.text.len();
        receipt.partial = false;
        self.set_receipt(&receipt);
        Ok(receipt)
    }
}
