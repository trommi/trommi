// slices.ts: hands a group's history to the core in slices (the core's walks in steps: `learnSlice`,
// `codeCheckSlice`, `sessionCheckSlice`, `recoveryPlanSlice`). A room that grew old has more Commits than one call
// may carry; the hub's pages are read while the core takes them, and no more than one slice is held at a time.

/** The most one slice holds (the core's `MAX_SLICE_COMMITS` and `MAX_SLICE_LEN`). Tests set it higher to see the
 *  core refuse a slice `too-large` and the slice halved. */
export const SLICE = { commits: 256, bytes: 16 << 20 }

/**
 * `feed` for a slice the core may refuse `too-large` (`tooLarge`): such a slice is halved and each half handed in
 * turn (the walk stands where it was). Any other refusal ends the walk and is thrown. The answer is the last half's.
 */
export function halving<T>(feed: (slice: T[]) => Promise<boolean>, tooLarge: (e: unknown) => boolean): (slice: T[]) => Promise<boolean> {
  const give = async (slice: T[]): Promise<boolean> => {
    try { return await feed(slice) } catch (e) {
      if (!tooLarge(e) || slice.length < 2) throw e
      const half = Math.ceil(slice.length / 2)
      return (await give(slice.slice(0, half))) || give(slice.slice(half))
    }
  }
  return give
}

/**
 * Reads `next` until it gives null and hands what it read to `feed`, in slices of at most `SLICE`. `feed` answers
 * true when the walk needs no more: the rest is not read.
 */
export async function inSlices<T>(next: () => Promise<T | null>, size: (item: T) => number, feed: (slice: T[]) => Promise<boolean>): Promise<void> {
  let carry = await next()
  while (carry !== null) {
    const slice: T[] = []
    let bytes = 0
    while (carry !== null && slice.length < SLICE.commits && (slice.length === 0 || bytes + size(carry) <= SLICE.bytes)) {
      slice.push(carry)
      bytes += size(carry)
      carry = await next()
    }
    if (await feed(slice)) return
  }
}
