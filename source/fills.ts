/** Tracks per-order fills from `predictWalletEvents` so strategies can reconcile. */

export interface WalletEvent {
  type: string;
  orderId: string;
  orderHash: string;
  reason?: string;
  settlementId?: string;
  fill?: { executedPriceWei: string; executedSizeWei: string; executedValueWei: string };
  fee?: { amountWei: string; type: "COLLATERAL" | "SHARES" };
}

export interface OrderState {
  orderId: string;
  shares: number;
  notional: number; // USD paid/received
  feeUsd: number;
  closed: boolean; // rejected / cancelled / expired / settlement failed
  expected?: number;
  why?: string;
}

const wei = (x: string) => Number(BigInt(x)) / 1e18;

export class Fills {
  private orders = new Map<string, OrderState>();
  private seen = new Set<string>();
  private waiters = new Map<string, () => void>();

  get(orderId: string): OrderState {
    let s = this.orders.get(orderId);
    if (!s) {
      s = { orderId, shares: 0, notional: 0, feeUsd: 0, closed: false };
      this.orders.set(orderId, s);
    }
    return s;
  }

  expect(orderId: string, shares: number) {
    this.get(orderId).expected = shares;
  }

  done(s: OrderState) {
    return s.closed || (s.expected !== undefined && s.shares >= s.expected * 0.99); // buy fees are taken in shares (~0.2-0.4%)
  }

  ingest(e: WalletEvent) {
    const s = this.get(e.orderId);
    switch (e.type) {
      case "orderTransactionSuccess": {
        const key = e.settlementId ?? `${e.orderId}:${e.orderHash}:${e.fill?.executedSizeWei}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (e.fill) {
          s.shares += wei(e.fill.executedSizeWei);
          s.notional += wei(e.fill.executedValueWei);
        }
        if (e.fee?.type === "COLLATERAL") s.feeUsd += wei(e.fee.amountWei);
        break;
      }
      case "orderNotAccepted":
      case "orderExpired":
      case "orderCancelled":
        s.closed = true;
        s.why = e.reason ?? e.type;
        break;
      case "orderTransactionFailed":
        s.why = "settlementFailed";
        console.warn(`[fills] settlement FAILED for order ${e.orderId}`);
        break;
      default:
        return; // accepted / submitted: nothing to account yet
    }
    if (this.done(s)) this.waiters.get(e.orderId)?.();
  }

  /** Resolve when the order is done or `ms` elapses; returns the (live) state either way. */
  wait(orderId: string, ms: number): Promise<OrderState> {
    const s = this.get(orderId);
    if (this.done(s)) return Promise.resolve(s);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(orderId);
        resolve(s);
      }, ms);
      this.waiters.set(orderId, () => {
        clearTimeout(t);
        this.waiters.delete(orderId);
        resolve(s);
      });
    });
  }
}
