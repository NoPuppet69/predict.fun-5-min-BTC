export interface Outcome { name: string; indexSet: number; onChainId: string }

export interface Market {
  id: number; title: string; tradingStatus: string; status: string;
  isNegRisk: boolean; isYieldBearing: boolean; feeRateBps: number;
  conditionId: string; decimalPrecision: number; outcomes: Outcome[];
}
export interface Category {
  id: number; slug: string; title: string; marketVariant: string; status: string;
  startsAt?: string; endsAt?: string; variantDetails?: unknown; markets: Market[];
}

export const isBinary = (m: Market) => m.outcomes.length === 2;
export const isOpen = (m: Market) =>
  m.tradingStatus === "OPEN" && (m.status === "REGISTERED" || m.status === "UNPAUSED");
