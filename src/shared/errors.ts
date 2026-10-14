/** Normalize unknown failures at infrastructure and task boundaries. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
