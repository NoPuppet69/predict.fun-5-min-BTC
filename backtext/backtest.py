#!/usr/bin/env python3
"""
Replay the Kacho Polymarket 5-minute crypto dataset through the proposal's strategy:
  buy the first side whose ask >= TRIGGER, fill-or-kill within slippage, hold to resolution.

Data: https://huggingface.co/datasets/kachoio/polymarket-5-minute-crypto-up-down-markets
Files needed in --data-dir:  <coin>_markets.parquet + <coin>_ticks.parquet  (or .csv)

Honest limits (printed again at the end):
  * Polymarket data, not Predict.fun. Fees, depth and flow differ.
  * 1 Hz top-of-book only: no ask depth, so fills are modelled at the best ask.
  * `outcome` is inferred from the last tick; markets with null outcome are excluded.
  * Sweeping many parameters on one dataset overfits. Trust the half-vs-half split more than the best cell.
"""
import argparse, math, os, sys
import numpy as np
import pandas as pd

TRIGGERS = [0.80, 0.85, 0.88, 0.90, 0.92, 0.94]
LATENCIES = [0, 1, 2]  # seconds between trigger tick and fill tick (data is 1 Hz)


def read(data_dir, coin, kind):
    for ext in ("parquet", "csv"):
        p = os.path.join(data_dir, f"{coin}_{kind}.{ext}")
        if os.path.exists(p):
            return pd.read_parquet(p) if ext == "parquet" else pd.read_csv(p)
    sys.exit(f"missing {coin}_{kind}.parquet/.csv in {data_dir}")


def fee_ps(p, model, bps, mult):
    p = np.asarray(p, dtype=float)
    if model == "none":
        return np.zeros_like(p)
    if model == "bps":
        return bps / 1e4 * np.minimum(p, 1 - p) * mult
    if model == "poly_crypto":  # 0.25 * (p(1-p))^2, Polymarket 5/15-min crypto taker fee (from memory)
        return 0.25 * (p * (1 - p)) ** 2 * mult
    raise ValueError(model)


def wilson(w, n, z=1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    ph = w / n
    d = 1 + z * z / n
    c = ph + z * z / (2 * n)
    a = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))
    return ((c - a) / d, (c + a) / d)


def simulate_market(t, au, ad, end_s, trig, lat, slip, min_left, max_ask, strict=False, bu=None, bd=None, exit_at=0.0):
    """Return (side, fill_ask, seconds_left_at_fill) or ('missed'|None, None, None).
    cap = trigger*(1+slip%). Bot behaviour (strict=False): enter on the first tick whose ask is in [trigger, cap].
    strict=True: look only at the very first touch (ask >= trigger); skip the window if that ask is already past the cap."""
    left = end_s - t
    ok = left >= min_left
    cap = min(max_ask, 0.99, trig * (1 + slip / 100))
    if strict:
        hu = (au >= trig) & ok
        hd = (ad >= trig) & ok
    else:
        hu = (au >= trig) & (au <= cap) & ok
        hd = (ad >= trig) & (ad <= cap) & ok
    hit = hu | hd
    if not hit.any():
        return None, None, None, False
    i = int(np.argmax(hit))
    side = "Up" if (hu[i] and (not hd[i] or au[i] >= ad[i])) else "Down"
    ask_hit = au[i] if side == "Up" else ad[i]
    if ask_hit > cap + 1e-9:
        return "missed", None, None, False  # first touch already gapped past the cap
    j = int(np.searchsorted(t, t[i] + lat, side="left"))
    if j >= len(t) or left[j] < 0:
        return "missed", None, None, False
    fill = au[j] if side == "Up" else ad[j]
    if not np.isfinite(fill) or fill > cap + 1e-9:
        return "missed", None, None, False  # fill-or-kill would be killed: price ran past the cap before the fill
    exited = False
    if exit_at > 0 and bu is not None:  # resting sell at exit_at fills once the side's best bid reaches it
        bid = bu if side == "Up" else bd
        exited = bool(((bid[j:] >= exit_at) & (left[j:] >= 0)).any())
    return side, float(fill), float(left[j]), exited


def run_coin(coin, a, grid):
    mk = read(a.data_dir, coin, "markets")
    tk = read(a.data_dir, coin, "ticks")
    mk["market_end"] = pd.to_datetime(mk["market_end"], utc=True)
    info = {r.condition_id: (r.market_end.timestamp(), r.outcome) for r in mk.itertuples()}
    tk = tk.sort_values(["condition_id", "t"])
    rows, stats = [], {"markets": len(mk), "null_outcome": int(mk["outcome"].isna().sum())}
    for cid, g in tk.groupby("condition_id", sort=False):
        end_s, outcome = info.get(cid, (None, None))
        if end_s is None:
            continue
        t = g["t"].to_numpy(dtype=float)
        au = g["au"].to_numpy(dtype=float)
        ad = g["ad"].to_numpy(dtype=float)
        au = np.where(np.isfinite(au), au, -1.0)
        ad = np.where(np.isfinite(ad), ad, -1.0)
        bu = np.where(np.isfinite(g["bu"].to_numpy(dtype=float)), g["bu"].to_numpy(dtype=float), -1.0) if a.exit_at > 0 else None
        bd = np.where(np.isfinite(g["bd"].to_numpy(dtype=float)), g["bd"].to_numpy(dtype=float), -1.0) if a.exit_at > 0 else None
        for trig, lat in grid:
            side, fill, lf, ex = simulate_market(t, au, ad, end_s, trig, lat, a.slip, a.min_left, a.max_ask, a.strict_first_touch, bu, bd, a.exit_at)
            if fill is None:
                if side == "missed":
                    rows.append((coin, cid, end_s, trig, lat, None, np.nan, np.nan, True, np.nan, np.nan, False))
                continue
            win = np.nan if outcome not in ("Up", "Down") else float(side == outcome)
            rows.append((coin, cid, end_s, trig, lat, side, fill, win, False, lf, (a.exit_at if ex else win), ex))
    df = pd.DataFrame(rows, columns=["coin", "cid", "end_s", "trig", "lat", "side", "fill", "win", "missed", "left", "payoff", "exited"])
    return df, stats


def summarize(df, model, bps, mult, clip):
    d = df[(~df["missed"]) & df["win"].notna()].copy()
    n = len(d)
    if n == 0:
        return dict(n=0)
    d["cost"] = d["fill"] + fee_ps(d["fill"], model, bps, mult)
    d["pnl"] = d["payoff"] - d["cost"]
    w = int(d["win"].sum())
    lo, hi = wilson(w, n)
    d = d.sort_values("end_s")
    usd = clip * d["pnl"] / d["cost"]  # each trade deploys `clip` dollars
    dd = float((usd.cumsum() - usd.cumsum().cummax()).min())
    return dict(n=n, win=w / n, lo=lo, hi=hi, breakeven=float(d["cost"].mean()),
                roi=float(d["pnl"].sum() / d["cost"].sum()), usd=float(usd.sum()), maxdd=dd)


def fmt(s):
    if s.get("n", 0) == 0:
        return "no trades"
    return (f"n={s['n']:>6}  win={s['win']*100:5.1f}% [{s['lo']*100:4.1f},{s['hi']*100:4.1f}]  "
            f"breakeven={s['breakeven']*100:5.1f}%  ROI={s['roi']*100:+6.2f}%  "
            f"P&L=${s['usd']:+9.2f}  maxDD=${s['maxdd']:9.2f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="./dataset")
    ap.add_argument("--coins", default="btc,eth,bnb")
    ap.add_argument("--trigger", type=float, default=0.90)
    ap.add_argument("--latency", type=int, default=1, help="seconds, data is 1 Hz")
    ap.add_argument("--slip", type=float, default=2.0, help="percent")
    ap.add_argument("--min-left", type=float, default=5.0)
    ap.add_argument("--max-ask", type=float, default=0.95)
    ap.add_argument("--bps", type=float, default=200.0)
    ap.add_argument("--fee-mult", type=float, default=1.0)
    ap.add_argument("--clip", type=float, default=5.0)
    ap.add_argument("--strict-first-touch", action="store_true", help="skip the window if the first touch ask is already past the cap")
    ap.add_argument("--exit-at", type=float, default=0.0, help="e.g. 0.99: sell there once the bid reaches it, instead of holding to resolution")
    ap.add_argument("--sweep", action="store_true", help="also sweep trigger x latency (slower)")
    a = ap.parse_args()

    grid = [(a.trigger, a.latency)]
    if a.sweep:
        grid = sorted(set(grid + [(t, l) for t in TRIGGERS for l in LATENCIES]))
    frames = []
    for coin in [c.strip() for c in a.coins.split(",") if c.strip()]:
        df, st = run_coin(coin, a, grid)
        frames.append(df)
        print(f"{coin}: {st['markets']} markets, {st['null_outcome']} with null outcome (excluded)")
    all_ = pd.concat(frames, ignore_index=True)
    main_ = all_[(all_["trig"] == a.trigger) & (all_["lat"] == a.latency)]

    print(f"\n=== trigger {a.trigger}, latency {a.latency}s, slip {a.slip}%, clip ${a.clip} ===")
    for model in ("none", "bps", "poly_crypto"):
        print(f"\n-- fee model: {model}" + (f" ({a.bps:.0f} bps x {a.fee_mult})" if model == "bps" else ""))
        for coin in sorted(main_["coin"].unique()):
            print(f"  {coin:<5}", fmt(summarize(main_[main_["coin"] == coin], model, a.bps, a.fee_mult, a.clip)))
        print(f"  {'ALL':<5}", fmt(summarize(main_, model, a.bps, a.fee_mult, a.clip)))
    miss = int(main_["missed"].sum())
    print(f"\nkilled/missed entries (book moved past slippage before fill): {miss}")
    if a.exit_at > 0:
        ex_n = int(main_["exited"].sum()); tr_n = int((~main_["missed"]).sum())
        print(f"exit at {a.exit_at}: {ex_n} of {tr_n} filled trades exited early (ROI above includes the exit; compare with --exit-at 0)")

    done = main_[(~main_["missed"]) & main_["win"].notna()].sort_values("end_s")
    if len(done) >= 20:
        half = len(done) // 2
        print("\n-- stability (fee model: bps)")
        print("  first half ", fmt(summarize(done.iloc[:half], "bps", a.bps, a.fee_mult, a.clip)))
        print("  second half", fmt(summarize(done.iloc[half:], "bps", a.bps, a.fee_mult, a.clip)))
        print("\n-- by seconds left at fill (fee model: bps). Late touches inflate win% but may be unfillable.")
        for lo, hi in zip([0, 30, 60, 120], [30, 60, 120, 301]):
            g = done[(done["left"] >= lo) & (done["left"] < hi)]
            if len(g):
                print(f"  {lo:>3}-{hi - 1:<3}s ", fmt(summarize(g, "bps", a.bps, a.fee_mult, a.clip)))
        done = done.assign(week=pd.to_datetime(done["end_s"], unit="s", utc=True).dt.strftime("%G-W%V"))
        for wk, g in done.groupby("week"):
            s = summarize(g, "bps", a.bps, a.fee_mult, a.clip)
            print(f"  {wk}  n={s['n']:>5}  win={s['win']*100:5.1f}%  ROI={s['roi']*100:+6.2f}%")

    if a.sweep:
        print("\n-- sweep (ALL coins, fee model: bps)  ROI% / win% / breakeven% / n")
        print("  trig \\ lat  " + "".join(f"{l:>26}s" for l in LATENCIES))
        for t in TRIGGERS:
            cells = []
            for l in LATENCIES:
                s = summarize(all_[(all_["trig"] == t) & (all_["lat"] == l)], "bps", a.bps, a.fee_mult, a.clip)
                cells.append("n/a" if s.get("n", 0) == 0 else f"{s['roi']*100:+5.1f}/{s['win']*100:4.1f}/{s['breakeven']*100:4.1f}/{s['n']}")
            print(f"  {t:<10}  " + "".join(f"{c:>27}" for c in cells))

    print("\nReproduce first-touch tables: --strict-first-touch --latency 0 --min-left 0 --max-ask 1 --slip 100  (no cap)"
          "\n                              ... same with --slip 2  (2% cap = ask must be <= trigger*1.02)")
    print("\nREAD THIS: a trade at 0.91 only breaks even if it wins ~91-92% of the time. ROI here is a historical"
          "\nreplay on Polymarket top-of-book data (no ask depth, 1 Hz). Picking the best sweep cell overfits."
          "\nCompare first-half vs second-half, then confirm in shadow mode on Predict.fun before risking money.")


if __name__ == "__main__":
    main()

