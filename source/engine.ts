import fs from "node:fs";
import { envFor, creds, allowLive, DEFAULTS, type Mode, type Settings } from "./config.js";
import { Api } from "./api.js";
import { Fills } from "./fills.js";
import { Hub } from "./hub.js";
import { Executor } from "./executor.js";
import { Ledger } from "./ledger.js";
import { estFee } from "./fees.js";
import { noView, sweep, floorTo, type Book } from "./book.js";
import { isBinary, isOpen, type Category, type Market, type Outcome } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ASSETS: Record<string, RegExp> = { BTC: /btc|bitcoin/i, ETH: /eth|ethereum/i, BNB: /bnb/i };
const SETTINGS_FILE = "data/settings.json";

interface Win { asset: string; slug: string; m: Market; up: Outcome; dn: Outcome; startsAt: number; endsAt: number }
interface WinState { status: "watching" | "entering" | "entered" | "skipped"; note: string; attempts: number; closed: boolean }
export interface Entry {
  slug: string; asset: string; marketId: number; conditionId: string; isNegRisk: boolean; isYieldBearing: boolean;
  side: "UP" | "DOWN"; indexSet: number; shares: number; avgPrice: number; fee: number; cost: number;
  endsAt: number; ts: number; simulated: boolean; resolved?: boolean; claimed?: boolean;
  msToOrder?: number; msToFill?: number; secsLeft?: number; // trigger->order / trigger->fill latency, window time left at trigger
}
export interface Result { slug: string; asset: string; side: string; shares: number; avgPrice: number; cost: number; payout: number; pnl: number; won: boolean; inferred: boolean; ts: number }

const logErr = (e: unknown) => console.error("[err]", (e as Error).message);

export class Engine {
  mode: Mode;
  S: Settings = { ...DEFAULTS };
  running = false;
  halted = false;
  haltReason = "";
  lastError = "";
  private api!: Api; private fills!: Fills; private hub!: Hub; private ex?: Executor; private ledger!: Ledger;
  private windows = new Map<string, Win>();
  private byMarket = new Map<number, Win>();
  private states = new Map<string, WinState>();
  private entries = new Map<string, Entry>();
  private results: Result[] = [];
  private windowsSeen = 0;
  private startEquity?: number;
  private cash = 0;
  private timers: NodeJS.Timeout[] = [];
  private probeMs = Infinity;
  private lastProbe = 0; private lastResolve = 0; private lastBal = 0; private lastLoop = 0;

  constructor(mode: Mode) {
    this.mode = mode;
    try { Object.assign(this.S, JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"))); } catch { /* defaults */ }
  }

  // ---------- lifecycle ----------
  async init() { await this.build(); }

  private async build() {
    this.lastError = "";
    const env = envFor(this.mode);
    try {
      if (env.name === "mainnet" && !env.apiKey) throw new Error("API_KEY (mainnet) is not set");
      this.ledger = new Ledger(`data/${this.mode}`);
      this.loadLedger();
      this.api = new Api(env);
      this.fills = new Fills();
      this.hub = new Hub(env.wsUrl, env.apiKey, this.fills);
      this.hub.onBook((id) => this.onBook(id));
      if (this.mode !== "shadow") {
        if (!creds.signerKey) throw new Error("SIGNER_PRIVATE_KEY is not set");
        this.ex = new Executor(env, creds, this.api, this.fills);
        await this.ex.init();
        await this.ex.authenticate();
        this.hub.subscribeWallet(this.api.jwt);
        this.api.onJwt = (j) => this.hub.subscribeWallet(j);
      } else this.ex = undefined;
      this.hub.start();
      await this.refreshBalance();
      if (this.startEquity === undefined) {
        this.startEquity = this.mode === "shadow" ? this.S.shadowBankroll : this.cash;
        this.ledger.append({ type: "init", startEquity: this.startEquity });
        await this.refreshBalance();
      }
      for (const e of this.entries.values()) if (!e.resolved) this.hub.watch(e.marketId);
      await this.discover();
      this.timers.push(
        setInterval(() => void this.discover().catch(logErr), 20_000),
        setInterval(() => void this.tick().catch(logErr), 1000),
      );
      console.log(`[engine] mode=${this.mode} env=${env.name} ready (stopped; press Start in the dashboard)`);
    } catch (e) {
      this.lastError = (e as Error).message;
      logErr(e);
    }
  }

  async teardown() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.hub?.close();
    this.windows.clear(); this.byMarket.clear(); this.states.clear();
    this.entries.clear(); this.results = []; this.windowsSeen = 0; this.startEquity = undefined;
  }

  async setMode(mode: Mode, confirm?: string) {
    if (mode === "live") {
      if (!allowLive) throw new Error("live mode is disabled: set ALLOW_LIVE=true in .env and restart");
      if (confirm !== "LIVE") throw new Error('type LIVE to confirm switching to real-money trading');
    }
    await this.teardown();
    this.mode = mode;
    this.halted = false; this.haltReason = "";
    await this.build();
    this.ledger?.append({ type: "mode", mode });
  }

  start() {
    if (this.lastError) throw new Error(this.lastError);
    this.halted = false; this.haltReason = ""; this.running = true;
    this.ledger.append({ type: "start" });
    this.checkDrawdown();
  }
  stop() { this.running = false; this.ledger.append({ type: "stop" }); }
  halt(reason: string) {
    this.running = false; this.halted = true; this.haltReason = reason;
    this.ledger.append({ type: "halt", reason });
    console.error(`[HALT] ${reason}`); // entries are fill-or-kill, so no resting orders exist to cancel
  }

  updateSettings(p: Partial<Settings>) {
    const n = <T extends number>(v: unknown, lo: number, hi: number, d: T) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) as T : d);
    const S = this.S;
    if (p.trigger !== undefined) S.trigger = n(p.trigger, 0.5, 0.99, S.trigger);
    if (p.clipUsd !== undefined) S.clipUsd = n(p.clipUsd, 1, 20, S.clipUsd);
    if (p.slippagePct !== undefined) S.slippagePct = n(p.slippagePct, 0, 5, S.slippagePct);
    if (p.minSecondsLeft !== undefined) S.minSecondsLeft = n(p.minSecondsLeft, 0, 120, S.minSecondsLeft);
    if (p.maxEntryAsk !== undefined) S.maxEntryAsk = n(p.maxEntryAsk, 0.5, 0.99, S.maxEntryAsk);
    if (p.dailyDrawdownUsd !== undefined) S.dailyDrawdownUsd = n(p.dailyDrawdownUsd, 1, 100000, S.dailyDrawdownUsd);
    if (p.autoClaim !== undefined) S.autoClaim = !!p.autoClaim;
    if (p.shadowBankroll !== undefined) S.shadowBankroll = n(p.shadowBankroll, 10, 1e7, S.shadowBankroll);
    if (p.shadowLatencyMs !== undefined) S.shadowLatencyMs = n(p.shadowLatencyMs, 0, 5000, S.shadowLatencyMs);
    if (p.feeModel === "bps" || p.feeModel === "poly_crypto") S.feeModel = p.feeModel;
    if (p.feeMult !== undefined) S.feeMult = n(p.feeMult, 0, 10, S.feeMult);
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(S, null, 2));
  }

  // ---------- state rebuilt from the ledger ----------
  private loadLedger() {
    for (const ev of this.ledger.readAll()) {
      if (ev.type === "init") this.startEquity = ev.startEquity;
      else if (ev.type === "entry") this.entries.set(ev.slug, ev as Entry);
      else if (ev.type === "resolved") {
        const e = this.entries.get(ev.slug); if (e) e.resolved = true;
        this.results.push(ev as Result);
      } else if (ev.type === "claim" && ev.ok) { const e = this.entries.get(ev.slug); if (e) e.claimed = true; }
      else if (ev.type === "window_end") this.windowsSeen++;
    }
  }

  private async refreshBalance() {
    if (this.mode === "shadow") {
      const base = this.startEquity ?? this.S.shadowBankroll;
      const open = [...this.entries.values()].filter((e) => !e.resolved).reduce((a, e) => a + e.cost, 0);
      this.cash = base + this.results.reduce((a, r) => a + r.pnl, 0) - open;
    } else if (this.ex) this.cash = await this.ex.balanceUsd();
  }

  // ---------- discovery ----------
  private assetOf(cat: Category) {
    const text = `${cat.slug} ${cat.title} ${JSON.stringify(cat.variantDetails ?? {})}`;
    return Object.keys(ASSETS).find((a) => ASSETS[a].test(text));
  }

  private async discover() {
    const cats = await this.api.categories(300, { marketVariant: "CRYPTO_UP_DOWN" });
    const now = Date.now();
    for (const cat of cats) {
      if (String(cat.marketVariant) !== "CRYPTO_UP_DOWN" || this.windows.has(cat.slug)) continue;
      const asset = this.assetOf(cat);
      if (!asset || !this.S.assets.includes(asset)) continue;
      const startsAt = Date.parse(cat.startsAt ?? ""), endsAt = Date.parse(cat.endsAt ?? "");
      if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) continue;
      const dur = (endsAt - startsAt) / 1000;
      if (dur < 280 || dur > 320) continue; // 5-minute windows only
      if (endsAt < now - 60_000 || startsAt > now + 90_000) continue; // current + imminent
      const m = cat.markets.find((x) => isBinary(x) && isOpen(x));
      if (!m) continue;
      const up = m.outcomes.find((o) => /^up$/i.test(o.name)) ?? m.outcomes.find((o) => o.indexSet === 1)!;
      const dn = m.outcomes.find((o) => /^down$/i.test(o.name)) ?? m.outcomes.find((o) => o.indexSet === 2)!;
      const w: Win = { asset, slug: cat.slug, m, up, dn, startsAt, endsAt };
      this.windows.set(w.slug, w);
      this.byMarket.set(m.id, w);
      this.states.set(w.slug, { status: "watching", note: "", attempts: 0, closed: false });
      this.hub.watch(m.id);
    }
  }

  // ---------- 1 s housekeeping ----------
  private async tick() {
    const now = Date.now();
    this.lastLoop = now;
    for (const w of this.windows.values()) {
      const st = this.states.get(w.slug)!;
      if (now >= w.endsAt && !st.closed) {
        st.closed = true;
        this.windowsSeen++;
        const status = st.status === "watching" ? (st.note ? `missed: ${st.note}` : "no_trigger") : st.status === "skipped" ? `skipped: ${st.note}` : st.status;
        this.ledger.append({ type: "window_end", slug: w.slug, asset: w.asset, status });
      }
    }
    if (now - this.lastProbe > 5000) { this.lastProbe = now; void this.probe(); }
    if (now - this.lastResolve > 5000) { this.lastResolve = now; await this.checkResolutions(); }
    if (this.mode !== "shadow" && now - this.lastBal > 10_000) { this.lastBal = now; await this.refreshBalance().catch(logErr); }
    for (const w of [...this.windows.values()]) { // prune old windows
      const e = this.entries.get(w.slug);
      if (now > w.endsAt + 10 * 60_000 && (!e || e.resolved)) {
        this.windows.delete(w.slug); this.states.delete(w.slug); this.byMarket.delete(w.m.id); this.hub.unwatch(w.m.id);
      }
    }
  }

  private async probe() {
    const w = [...this.windows.values()][0];
    if (!w) return;
    const t0 = Date.now();
    try { await this.api.orderbook(w.m.id); this.probeMs = Date.now() - t0; } catch { this.probeMs = Infinity; }
  }

  // ---------- trigger + entry ----------
  private views(w: Win, b: Book) {
    const no = noView(b, w.m.decimalPrecision);
    const upYes = w.up.indexSet === 1;
    return { up: upYes ? b : no, dn: upYes ? no : b };
  }

  private onBook(id: number) {
    const w = this.byMarket.get(id);
    if (w) void this.evaluate(w).catch(logErr);
  }

  private async evaluate(w: Win) {
    const st = this.states.get(w.slug);
    const now = Date.now();
    if (!st || st.status !== "watching" || !this.running || this.halted) return;
    if (now < w.startsAt || now >= w.endsAt) return;
    const b = this.hub.get(w.m.id);
    if (!b) return;
    const v = this.views(w, b);
    const cand = [
      { side: "UP" as const, ask: v.up.asks[0]?.[0] },
      { side: "DOWN" as const, ask: v.dn.asks[0]?.[0] },
    ].filter((x): x is { side: "UP" | "DOWN"; ask: number } => x.ask !== undefined && x.ask >= this.S.trigger)
     .sort((a, c) => c.ask - a.ask)[0];
    if (!cand) return;

    const secsLeft = (w.endsAt - now) / 1000;
    if (secsLeft < this.S.minSecondsLeft) { st.status = "skipped"; st.note = "too late in window"; return; }
    const cap = this.capFor(w);
    if (cand.ask > cap) { st.note = `ask ${cand.ask} jumped past cap ${cap}`; return; }
    if (!this.lagOk(b)) { st.note = "lag guard"; return; }
    if (this.cash < this.S.clipUsd) { st.note = "insufficient balance"; return; }
    if (this.checkDrawdown()) return;

    st.status = "entering"; st.note = ""; // one-position-per-market lock
    try { await this.enter(w, st, cand.side, cand.ask, now); }
    catch (e) { this.retry(st, (e as Error).message); }
  }

  /** Worst acceptable price: trigger x (1 + slippage%), so an ask that gaps well past the trigger is skipped. */
  private capFor(w: Win) {
    const S = this.S;
    return floorTo(Math.min(0.99, S.maxEntryAsk, S.trigger * (1 + S.slippagePct / 100)), w.m.decimalPrecision);
  }

  private lagOk(b: Book) {
    return this.hub.ws.healthy() && this.probeMs <= this.S.lagMs && Date.now() - b.rx <= this.S.staleMs;
  }

  private retry(st: WinState, note: string) {
    st.attempts++; st.note = note;
    st.status = st.attempts >= 3 ? "skipped" : "watching";
  }

  private async enter(w: Win, st: WinState, side: "UP" | "DOWN", ask: number, trigAt: number) {
    const m = w.m, S = this.S, prec = m.decimalPrecision;
    const out = side === "UP" ? w.up : w.dn;
    const secsLeft = (w.endsAt - trigAt) / 1000;
    const cap = this.capFor(w);
    const perShare = cap + estFee(S, m.feeRateBps, cap, 1);
    const shares = Math.floor((S.clipUsd / perShare) * 100) / 100; // clip is a hard cap incl. fees
    if (shares < 0.01) return this.retry(st, "clip too small");
    const tryFill = (b: Book) => {
      const v = this.views(w, b);
      return sweep((side === "UP" ? v.up : v.dn).asks.filter((l) => l[0] <= cap + 1e-9), shares);
    };

    if (this.mode === "shadow") {
      await sleep(S.shadowLatencyMs); // simulated trigger -> fill delay
      const b2 = this.hub.get(m.id);
      const sw = b2 ? tryFill(b2) : undefined;
      if (!sw || sw.filled < shares - 1e-9) return this.retry(st, "shadow FOK killed (book moved / thin)");
      return this.register(w, st, side, out, shares, sw.avg, estFee(S, m.feeRateBps, sw.avg, shares), true, { msToFill: S.shadowLatencyMs, secsLeft });
    }

    const b = this.hub.get(m.id);
    const pre = b ? tryFill(b) : undefined;
    if (!pre || pre.filled < shares - 1e-9) return this.retry(st, "book moved past slippage cap");
    const placed = await this.ex!.buyFok(m, out.onChainId, cap, shares);
    const placedAt = Date.now();
    const s = await this.fills.wait(placed.orderId, 12_000);
    const filledAt = Date.now();
    const done = (x: { shares: number; notional: number; feeUsd: number }, tm: Record<string, number> = { secsLeft }) =>
      this.register(w, st, side, out, x.shares, x.notional / x.shares, x.feeUsd || estFee(S, m.feeRateBps, cap, x.shares), false, tm);
    if (s.shares >= shares * 0.99) return done(s, { msToOrder: placedAt - trigAt, msToFill: filledAt - trigAt, secsLeft });
    if (s.closed) return this.retry(st, `FOK killed (${s.why ?? "no fill"})`);
    st.note = "awaiting settlement"; // settlement can lag; reconcile once more before giving up
    setTimeout(() => {
      const late = this.fills.get(placed.orderId);
      if (late.shares > 0.01 && !this.entries.has(w.slug)) done(late);
      else if (!this.entries.has(w.slug)) this.retry(st, "no fill after settlement wait");
    }, 30_000);
  }

  private register(w: Win, st: WinState, side: "UP" | "DOWN", out: Outcome, shares: number, avg: number, fee: number, simulated: boolean, tm: Record<string, number> = {}) {
    const e: Entry = {
      slug: w.slug, asset: w.asset, marketId: w.m.id, conditionId: w.m.conditionId,
      isNegRisk: w.m.isNegRisk, isYieldBearing: w.m.isYieldBearing, side, indexSet: out.indexSet,
      shares, avgPrice: avg, fee, cost: shares * avg + fee, endsAt: w.endsAt, ts: Date.now(), simulated, ...tm,
    };
    this.entries.set(w.slug, e);
    st.status = "entered"; st.note = "";
    this.ledger.append({ type: "entry", ...e });
    console.log(`[entry] ${w.asset} ${side} ${shares}@${avg.toFixed(4)} cost=$${e.cost.toFixed(2)}${simulated ? " (shadow)" : ""}`);
    void this.refreshBalance().catch(logErr);
  }

  // ---------- resolution scoring + claim ----------
  private winner(m: any): number | undefined {
    const won = (m?.outcomes as any[] | undefined)?.find((o) => String(o.status).toUpperCase() === "WON");
    if (won) return Number(won.indexSet);
    if (m?.resolution?.indexSet) return Number(m.resolution.indexSet);
    return undefined;
  }

  private async checkResolutions() {
    const now = Date.now();
    for (const e of this.entries.values()) {
      if (e.resolved || now < e.endsAt + 2000) continue;
      let win: number | undefined, inferred = false;
      try { win = this.winner(await this.api.market(e.marketId)); } catch (err) { logErr(err); }
      if (win === undefined && now > e.endsAt + 150_000) { // fallback, like the dataset: winner's bid ~0.99
        const w = this.windows.get(e.slug), b = this.hub.last(e.marketId);
        if (w && b) {
          const v = this.views(w, b);
          if ((v.up.bids[0]?.[0] ?? 0) >= 0.95) win = w.up.indexSet;
          else if ((v.dn.bids[0]?.[0] ?? 0) >= 0.95) win = w.dn.indexSet;
          inferred = win !== undefined;
        }
      }
      if (win !== undefined) await this.resolve(e, win, inferred);
    }
  }

  private async resolve(e: Entry, winnerIdx: number, inferred: boolean) {
    const won = e.indexSet === winnerIdx;
    const payout = won ? e.shares : 0;
    const r: Result = { slug: e.slug, asset: e.asset, side: e.side, shares: e.shares, avgPrice: e.avgPrice, cost: e.cost, payout, pnl: payout - e.cost, won, inferred, ts: Date.now() };
    e.resolved = true;
    this.results.push(r);
    this.ledger.append({ type: "resolved", ...r });
    console.log(`[resolved] ${e.asset} ${e.side} ${won ? "WIN" : "LOSS"} pnl=${r.pnl.toFixed(2)}${inferred ? " (inferred)" : ""}`);
    if (this.mode !== "shadow" && won && !inferred && this.S.autoClaim) await this.claim(e);
    await this.refreshBalance().catch(logErr);
    this.checkDrawdown();
  }

  private async claim(e: Entry) {
    if (!this.ex) return;
    const before = await this.ex.balanceUsd().catch(() => NaN);
    try {
      await this.ex.redeem(e.conditionId, e.indexSet, e.isNegRisk, e.isYieldBearing);
      const after = await this.ex.balanceUsd().catch(() => NaN);
      e.claimed = true;
      this.ledger.append({ type: "claim", slug: e.slug, ok: true, delta: after - before });
    } catch (err) {
      // may simply mean the account auto-claimed already; the balance delta in the log tells you
      this.ledger.append({ type: "claim", slug: e.slug, ok: false, error: (err as Error).message, balanceBefore: before });
    }
  }

  async manualClaim() {
    const won = new Set(this.results.filter((r) => r.won && !r.inferred).map((r) => r.slug));
    for (const e of this.entries.values()) if (won.has(e.slug) && !e.claimed) await this.claim(e);
    await this.refreshBalance().catch(logErr);
  }

  // ---------- risk ----------
  private dayStart() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
  private checkDrawdown(): boolean {
    const today = this.results.filter((r) => r.ts >= this.dayStart()).reduce((a, r) => a + r.pnl, 0);
    if (today <= -this.S.dailyDrawdownUsd && !this.halted) this.halt(`daily drawdown ceiling hit (${today.toFixed(2)})`);
    return this.halted;
  }

  // ---------- dashboard snapshot ----------
  exportRaw() { return this.ledger.raw(); }
  exportCsv() { return this.ledger.csv(); }

  snapshot() {
    const now = Date.now();
    const sum = (since: number) => this.results.filter((r) => r.ts >= since).reduce((a, r) => a + r.pnl, 0);
    const base = this.startEquity ?? this.S.shadowBankroll;
    const pnl = { hour: sum(now - 3.6e6), day: sum(now - 864e5), week: sum(now - 6048e5), total: sum(0) };
    const open = [...this.entries.values()].filter((e) => !e.resolved);
    const openCost = open.reduce((a, e) => a + e.cost, 0);
    const wins = this.results.filter((r) => r.won).length;
    const rows = this.S.assets.map((asset) => {
      const ws = [...this.windows.values()].filter((w) => w.asset === asset && w.endsAt > now).sort((a, c) => a.startsAt - c.startsAt);
      const w = ws.find((x) => x.startsAt <= now) ?? ws[0];
      if (!w) return { asset, slug: "-", note: "no window discovered" };
      const st = this.states.get(w.slug)!;
      const b = this.hub.last(w.m.id);
      const v = b ? this.views(w, b) : undefined;
      const upAsk = v?.up.asks[0]?.[0], dnAsk = v?.dn.asks[0]?.[0];
      const hit = (upAsk ?? 0) >= this.S.trigger || (dnAsk ?? 0) >= this.S.trigger;
      return {
        asset, slug: w.slug, startsAt: w.startsAt, endsAt: w.endsAt, live: w.startsAt <= now,
        upAsk, dnAsk, status: st.status, note: st.note, hit, bookAgeMs: b ? now - b.rx : null,
      };
    });
    return {
      now, mode: this.mode, running: this.running, halted: this.halted, haltReason: this.haltReason,
      lastError: this.lastError, liveAllowed: allowLive, settings: this.S,
      equity: { start: base, cash: this.cash, openCost, equity: this.cash + openCost },
      pnl, pnlPct: Object.fromEntries(Object.entries(pnl).map(([k, v]) => [k, base ? (v / base) * 100 : 0])),
      stats: { scored: this.results.length, wins, winRate: this.results.length ? wins / this.results.length : null, windows: this.windowsSeen },
      health: { ws: this.hub?.ws.healthy() ?? false, probeMs: Number.isFinite(this.probeMs) ? this.probeMs : null, loopAgeMs: now - this.lastLoop },
      rows, open, results: this.results.slice(-50).reverse(),
    };
  }
}
