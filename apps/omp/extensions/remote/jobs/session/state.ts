import type { Scope } from "../types";

export interface SessionState {
  isCurrent(scope: Scope): boolean;
  assertCurrent(scope: Scope): void;
  notice(content: string): void;
  error(error: unknown): string;
}
