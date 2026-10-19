export type Level = [price: number, size: number];
export interface Book { marketId: number; asks: Level[]; bids: Level[]; ts: number; rx: number }

export const roundTo = (x: number, p: number) => Math.round(x * 10 ** p) / 10 ** p;
export const floorTo = (x: number, p: number) => Math.floor(x * 10 ** p + 1e-9) / 10 ** p;

/** API books are Yes-quoted. The other outcome = swap sides and complement prices. */
export function noView(b: Book, prec: number): Book {
  const c = (p: number) => roundTo(1 - p, prec);
  return {
    ...b,
    asks: b.bids.map(([p, q]) => [c(p), q] as Level), // buy-No price = 1 - Yes bid
    bids: b.asks.map(([p, q]) => [c(p), q] as Level),
  };
}

export function sweep(levels: Level[], shares: number) {
  let left = shares, cost = 0, worst = NaN;
  for (const [p, q] of levels) {
    const t = Math.min(left, q);
    cost += t * p; left -= t; worst = p;
    if (left <= 1e-9) break;
  }
  const filled = shares - left;
  return { filled, cost, worst, avg: filled > 0 ? cost / filled : NaN };
}
