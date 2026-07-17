/**
 * Loading is a transient state, not an alternative to an initial error. MCP
 * mode has no React Query request status to end its spinner, so the serial
 * coordinator's first error must explicitly make loading false.
 */
export function snapshotStreamIsLoading(input: {
  hasSnapshot: boolean;
  hasError: boolean;
  mcpMode: boolean;
  queryLoading: boolean;
}): boolean {
  return !input.hasSnapshot && !input.hasError && (input.mcpMode || input.queryLoading);
}
