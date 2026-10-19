import type { Settings } from "./config.js";

/**
 * ESTIMATE ONLY. Predict's exact taker-fee formula is not documented in what I could read.
 *  bps         : shares * feeRateBps/1e4 * min(p, 1-p)       (legacy Polymarket-style shape)
 *  poly_crypto : shares * 0.25 * (p*(1-p))^2                  (Polymarket 5/15-min crypto taker fee, from memory)
 * Both are tiny near p=0.9 (~0.15-0.2c/share). Verify against a real testnet fill.
 */
export function estFee(S: Pick<Settings, "feeModel" | "feeMult">, bps: number, price: number, shares: number) {
  const f = S.feeModel === "bps"
    ? (bps / 1e4) * Math.min(price, 1 - price)
    : 0.25 * Math.pow(price * (1 - price), 2);
  return f * shares * S.feeMult;
}
