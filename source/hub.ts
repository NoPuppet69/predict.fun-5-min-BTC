import { PredictWs } from "./ws.js";
import type { Fills, WalletEvent } from "./fills.js";
import type { Book, Level } from "./book.js";

export class Hub {
  readonly ws: PredictWs;
  private books = new Map<number, Book>();
  private status = new Map<number, string>();
  private watched = new Set<number>();
  private wallet = "";
  private listeners = new Set<(id: number) => void>();

  constructor(url: string, apiKey: string, private fills: Fills) {
    this.ws = new PredictWs(url, apiKey, (t, d) => this.handle(t, d));
  }
  start() { this.ws.connect(); }
  close() { this.ws.close(); }
  onBook(f: (id: number) => void) { this.listeners.add(f); }

  watch(id: number) {
    if (this.watched.has(id)) return;
    this.watched.add(id);
    this.ws.subscribe(`predictOrderbook/${id}`);
    this.ws.subscribe(`predictTradingStatus/${id}`);
  }
  unwatch(id: number) {
    if (!this.watched.delete(id)) return;
    this.ws.unsubscribe(`predictOrderbook/${id}`);
    this.ws.unsubscribe(`predictTradingStatus/${id}`);
    this.books.delete(id);
  }
  subscribeWallet(jwt: string) {
    if (this.wallet) this.ws.unsubscribe(this.wallet);
    this.wallet = `predictWalletEvents/${jwt}`;
    this.ws.subscribe(this.wallet);
  }

  /** Tradable book: feed healthy and market matching. */
  get(id: number): Book | undefined {
    if (!this.ws.healthy()) return undefined;
    const st = this.status.get(id);
    if (st && st !== "OPEN") return undefined;
    return this.books.get(id);
  }
  /** Last known book regardless of status (used to infer outcomes after close). */
  last(id: number): Book | undefined { return this.books.get(id); }

  private handle(topic: string, d: any) {
    if (topic.startsWith("predictOrderbook/")) {
      const id = Number(d.marketId);
      this.books.set(id, { marketId: id, asks: (d.asks ?? []) as Level[], bids: (d.bids ?? []) as Level[], ts: d.updateTimestampMs, rx: Date.now() });
      for (const f of this.listeners) f(id);
    } else if (topic.startsWith("predictTradingStatus/")) {
      this.status.set(Number(d.marketId), d.tradingStatus);
    } else if (topic.startsWith("predictWalletEvents/")) {
      this.fills.ingest(d as WalletEvent);
    }
  }
}
