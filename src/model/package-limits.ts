export const PACKAGE_LIMITS = Object.freeze({
  articleBytes: 32 * 1024 * 1024,
  mineruContentListBytes: 32 * 1024 * 1024,
  contractBytes: 4 * 1024 * 1024,
  manifestBytes: 4 * 1024 * 1024,
  assetCount: 256,
  assetBytes: 32 * 1024 * 1024,
  totalAssetBytes: 256 * 1024 * 1024,
  assetHashConcurrency: 4,
  renderedResourceCount: 256
});

export class PackageLimitError extends Error {
  constructor(
    message: string,
    readonly actual: number,
    readonly limit: number
  ) {
    super(message);
    this.name = "PackageLimitError";
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => runWorker()
  ));
  return results;
}
