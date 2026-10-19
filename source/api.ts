import type { EnvCfg } from "./config.js";
import type { Category, Market } from "./types.js";

const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CreateOrderBody {
  order: Record<string, unknown>; pricePerShare: string; strategy: "LIMIT" | "MARKET";
  isFillOrKill?: boolean; isPostOnly?: boolean;
}
export interface CreateOrderResult { code: string; orderId: string; orderHash: string }

/** REST client. Calls are spaced 300 ms apart (~200/min) to stay under the 240/min default cap. */
export class Api {
  jwt = "";
  onJwt?: (jwt: string) => void;
  private sign?: (m: string) => Promise<string>;
  private address = "";
  private last = 0;
  constructor(private env: EnvCfg) {}

  private async throttle() {
    const now = Date.now();
    const at = Math.max(now, this.last + 300);
    this.last = at;
    if (at > now) await sleep(at - now);
  }

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown, authed = false, retry = true): Promise<T> {
    await this.throttle();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.env.apiKey) headers["x-api-key"] = this.env.apiKey;
    if (authed) headers.Authorization = `Bearer ${this.jwt}`;
    const res = await fetch(this.env.apiBase + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body, replacer),
    });
    const text = await res.text();
    if (retry && authed && res.status === 401 && this.sign) {
      await this.authenticate(this.address, this.sign);
      return this.req<T>(method, path, body, authed, false);
    }
    if (retry && res.status === 429) { await sleep(2000); return this.req<T>(method, path, body, authed, false); }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  async authenticate(address: string, sign: (m: string) => Promise<string>) {
    this.address = address; this.sign = sign;
    const m = await this.req<{ data: { message: string } }>("GET", "/v1/auth/message");
    const signature = await sign(m.data.message);
    const out = await this.req<{ data: { token: string } }>("POST", "/v1/auth", { signer: address, message: m.data.message, signature });
    this.jwt = out.data.token;
    this.onJwt?.(this.jwt);
  }

  async categories(max = 300, extra: Record<string, string> = {}): Promise<Category[]> {
    const out: Category[] = [];
    let after: string | undefined;
    do {
      const q = new URLSearchParams({ status: "OPEN", first: "100", ...extra });
      if (after) q.set("after", after);
      const r = await this.req<{ cursor?: string; data: Category[] }>("GET", `/v1/categories?${q}`);
      if (!r.data.length) break;
      out.push(...r.data);
      after = r.cursor;
    } while (after && out.length < max);
    return out;
  }

  market(id: number) { return this.req<{ data: Market & Record<string, any> }>("GET", `/v1/markets/${id}`).then((r) => r.data); }
  orderbook(id: number) { return this.req<{ data: any }>("GET", `/v1/markets/${id}/orderbook`).then((r) => r.data); }
  createOrder(data: CreateOrderBody) {
    return this.req<{ data: CreateOrderResult }>("POST", "/v1/orders", { data }, true).then((r) => r.data);
  }
}
