import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('preserves input order even when later items finish first', async () => {
    const items = [30, 10, 20];
    const result = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it('never runs more than the limit at once', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await mapWithConcurrency(items, 4, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return item * 2;
    });

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(result).toEqual(items.map((i) => i * 2));
  });

  it('works when there are fewer items than the limit', async () => {
    const result = await mapWithConcurrency([1, 2], 8, async (n) => n * 10);
    expect(result).toEqual([10, 20]);
  });

  it('returns an empty array for empty input without calling fn', async () => {
    const fn = jest.fn(async (n: number) => n);
    const result = await mapWithConcurrency([], 8, fn);
    expect(result).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('lets a rejection from fn propagate instead of swallowing it', async () => {
    // Callers (the AWS fetchers) decide what a failure means — e.g. count it
    // as a failed tag lookup — so this must not turn a thrown error into a
    // null result.
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      })
    ).rejects.toThrow('boom');
  });
});
