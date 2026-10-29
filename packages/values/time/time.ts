// Native timers overflow beyond this delay and can fire almost immediately
export const MAX_TIMER_DELAY = 2_147_483_647;

export function assertTimerDelay(value: number, label = "Timeout"): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TIMER_DELAY)
    throw new RangeError(
      `${label} must be an integer between 0 and ${MAX_TIMER_DELAY} milliseconds`,
    );
}
