import { Wallet, JsonRpcProvider } from "ethers";
import { OrderBuilder, Side } from "@predictdotfun/sdk";
import type { EnvCfg } from "./config.js";
import { roundTo } from "./book.js";
import type { Api } from "./api.js";
import type { Fills } from "./fills.js";
import type { Market } from "./types.js";

/**
 * "Market buy with slippage tolerance" = fill-or-kill LIMIT at ask*(1+slip). Same economics, and the
 * price cap is explicit. (The SDK's MARKET helper takes a book with no outcome argument, so the
 * book orientation for the second outcome is ambiguous.)
 */
export class Executor {
  private builder!: OrderBuilder;
  private signer!: Wallet;
  private account = "";
  constructor(
    private env: EnvCfg,
    private creds: { signerKey: string; predictAccount?: string },
    private api: Api,
    readonly fills: Fills,
  ) {}

  async init() {
    const provider = this.env.rpcUrl ? new JsonRpcProvider(this.env.rpcUrl) : undefined;
    if (provider) provider.pollingInterval = 300;
    this.signer = new Wallet(this.creds.signerKey, provider);
    this.builder = await OrderBuilder.make(
      this.env.chainId, this.signer,
      this.creds.predictAccount ? { predictAccount: this.creds.predictAccount } : undefined,
    );
    this.account = this.creds.predictAccount ?? this.signer.address;
  }

  async authenticate() {
    const sign = this.creds.predictAccount
      ? (m: string) => this.builder.signPredictAccountMessage(m)
      : (m: string) => this.signer.signMessage(m);
    await this.api.authenticate(this.account, sign);
  }

  async balanceUsd(): Promise<number> { return Number(await this.builder.balanceOf()) / 1e18; }

  async buyFok(m: Market, tokenId: string, capPrice: number, shares: number) {
    const prec = m.decimalPrecision;
    const price = roundTo(capPrice, prec);
    const sh = Math.floor(shares * 100) / 100;
    const pricePerShareWei = BigInt(Math.round(price * 10 ** prec)) * 10n ** BigInt(18 - prec);
    const quantityWei = BigInt(Math.round(sh * 100)) * 10n ** 16n;
    const { pricePerShare, makerAmount, takerAmount } = this.builder.getLimitOrderAmounts({
      side: Side.BUY, pricePerShareWei, quantityWei,
    });
    const order = this.builder.buildOrder("LIMIT", {
      maker: this.account, signer: this.account, side: Side.BUY, tokenId,
      makerAmount, takerAmount, nonce: 0n, feeRateBps: m.feeRateBps,
    });
    const typed = this.builder.buildTypedData(order, { isNegRisk: m.isNegRisk, isYieldBearing: m.isYieldBearing });
    const signed = await this.builder.signTypedDataOrder(typed);
    const hash = this.builder.buildTypedDataHash(typed);
    const res = await this.api.createOrder({
      order: { ...signed, hash } as unknown as Record<string, unknown>,
      pricePerShare: pricePerShare.toString(), strategy: "LIMIT", isFillOrKill: true,
    });
    this.fills.expect(res.orderId, sh);
    return { orderId: res.orderId, shares: sh, price };
  }

  /** Claim winnings. Standard (non-neg-risk) markets only; a revert may just mean auto-claim already paid. */
  async redeem(conditionId: string, indexSet: number, isNegRisk: boolean, isYieldBearing: boolean) {
    if (isNegRisk) throw new Error("neg-risk redeem needs an amount; not implemented");
    const r = await this.builder.redeemPositions({ conditionId, indexSet: String(indexSet), isNegRisk, isYieldBearing } as never);
    if (!r.success) throw new Error(`redeem failed: ${String((r as any).cause ?? "")}`);
  }
}
