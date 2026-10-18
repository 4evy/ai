import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { toError } from "@oh-my-pi/pi-utils/type-guards";

const NOTICE_TYPE = "remote-job-notice";
const MAX_ERROR_LENGTH = 512;

export function noticeError(error: unknown): string {
  return toError(error)
    .message.replace(/\p{Cc}/gu, " ")
    .slice(0, MAX_ERROR_LENGTH);
}

export function sendJobNotice(api: ExtensionAPI, content: string): void {
  api.sendMessage({ customType: NOTICE_TYPE, content, display: true });
}
