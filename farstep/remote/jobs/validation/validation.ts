export const DEFAULT_LINES = 200;
export const MAX_WAIT_SECONDS = 3600;
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;

export function validateLogPattern(value: string | undefined): void {
  if (value !== undefined) {
    if (!value) throw new Error("Log pattern must not be empty");
    new RegExp(value, "u");
  }
}
