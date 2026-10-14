/** Run bounded work and drain every started job before returning stable, ordered outcomes. */
export async function mapSettledLimit<T, R>(items: readonly T[], limit: number, operation: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error("Concurrency must be between 1 and 32");
  const outcomes = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        signal?.throwIfAborted();
        outcomes[index] = { status: "fulfilled", value: await operation(items[index]!, index) };
      } catch (reason) { outcomes[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return outcomes;
}
