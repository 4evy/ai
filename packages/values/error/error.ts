// Diagnostics must survive arbitrary thrown values, including hostile getters
export function errorMessage(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = error.message;
      if (typeof message === "string") return message;
    }
    return String(error);
  } catch {
    return "Unknown error";
  }
}

export function errorCode(error: unknown): string | undefined {
  try {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = error.code;
      return typeof code === "string" ? code : undefined;
    }
  } catch {
    // A thrown proxy can reject property inspection
  }
  return undefined;
}
