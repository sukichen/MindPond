/** Bound SDK validation work before schema parsing. String bodies use the HTTP
 * byte limit independently; large organization work must use bounded batches. */
export const MAX_MCP_INPUT_ELEMENTS = 10_000;
