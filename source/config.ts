import "dotenv/config";
import { randomBytes } from "node:crypto";
import { ChainId } from "@predictdotfun/sdk";

export type Mode = "shadow" | "test" | "live";
export interface EnvCfg {
  name: "mainnet" | "testnet";
  apiBase: string;
  wsUrl: string;
  chainId: ChainId;
  apiKey: string;
  rpcUrl: string;
}

const s = (k: string, d = "") => process.env[k] ?? d;

export const ENVS: Record<"mainnet" | "testnet", EnvCfg> = {
  mainnet: {
    name: "mainnet", apiBase: "https://api.predict.fun", chainId: ChainId.BnbMainnet,
    wsUrl: s("WS_URL_MAINNET", "wss://ws.predict.fun/ws"), apiKey: s("API_KEY"), rpcUrl: s("RPC_URL"),
  },
  testnet: {
    name: "testnet", apiBase: "https://api-testnet.predict.fun", chainId: ChainId.BnbTestnet,
    wsUrl: s("WS_URL_TESTNET", "wss://ws.predict.fun/ws"), apiKey: s("API_KEY_TESTNET"), rpcUrl: s("RPC_URL_TESTNET"),
  },
};
/** shadow reads MAINNET data without trading; test uses testnet; live uses mainnet. */
export const envFor = (m: Mode): EnvCfg => (m === "test" ? ENVS.testnet : ENVS.mainnet);

export const creds = { signerKey: s("SIGNER_PRIVATE_KEY"), predictAccount: s("PREDICT_ACCOUNT") || undefined };
export const allowLive = s("ALLOW_LIVE") === "true";
export const dash = { port: Number(s("DASH_PORT", "8787")), token: s("DASH_TOKEN") || randomBytes(12).toString("hex") };

export interface Settings {
  trigger: number;          // buy the first side whose ask >= this
  clipUsd: number;          // $ per entry, hard-clamped 1..20
  slippagePct: number;      // price cap = ask * (1 + pct/100); order is fill-or-kill at that cap
  minSecondsLeft: number;   // don't enter inside the last N seconds
  maxEntryAsk: number;      // skip if the ask is already above this
  dailyDrawdownUsd: number; // halt when today's realized loss reaches this
  autoClaim: boolean;       // test/live: call redeem after a win
  shadowBankroll: number;   // virtual starting equity in shadow mode
  shadowLatencyMs: number;  // shadow: delay between trigger and simulated fill
  feeModel: "bps" | "poly_crypto";
  feeMult: number;
  lagMs: number;            // pause entries if REST probe round trip exceeds this
  staleMs: number;          // pause entries if the market's book hasn't updated for this long
  assets: string[];
}
export const DEFAULTS: Settings = {
  trigger: 0.9, clipUsd: 5, slippagePct: 2, minSecondsLeft: 5, maxEntryAsk: 0.95,
  dailyDrawdownUsd: 25, autoClaim: true, shadowBankroll: 500, shadowLatencyMs: 500,
  feeModel: "bps", feeMult: 1, lagMs: 1500, staleMs: 5000, assets: ["BTC", "ETH", "BNB"],
};
