/** Message waits stay open until arrival, cancellation, or this five-minute deadline. */
export const OFFICE_WAIT_MS = 300_000;
/** Allow transport and response overhead beyond the server deadline. */
export const OFFICE_TOOL_TIMEOUT_MS = 360_000;
/** Codex configuration uses seconds; derive it from the shared transport deadline. */
export const OFFICE_TOOL_TIMEOUT_SECONDS = OFFICE_TOOL_TIMEOUT_MS / 1000;
