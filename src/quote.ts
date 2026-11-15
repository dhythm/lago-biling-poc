// 画面用の見積もり(純粋関数)。Lago に接続せず、pricing.ts の計算だけで3プランを比べる。
import { expectedInvoice, type ExpectedInvoice, type UsageTotals } from "./pricing.ts";
import { PLANS, PREPAID_WALLET, TAX, type PlanKey } from "./scenario.ts";

export type PlanQuote = {
  plan: PlanKey;
  planName: string;
  invoice: ExpectedInvoice;
  creditPurchase: number;
  cashOut: number; // 当月の支払総額 = クレジット購入 + 請求額
  walletRemaining: number | null;
};

export type CurvePoint = { apiCalls: number; tokens: number } & Record<PlanKey, number>;

const PLAN_ORDER: PlanKey[] = ["flat", "payg", "prepaid"];
const MAX_UNITS = 1e12;

export function quotePlans(usage: UsageTotals): PlanQuote[] {
  return PLAN_ORDER.map((plan) => {
    const prepaid = plan === "prepaid";
    const walletBalance = prepaid ? PREPAID_WALLET.paidCredits + PREPAID_WALLET.grantedCredits : 0;
    const invoice = expectedInvoice(PLANS[plan], usage, { taxRate: TAX.rate, walletBalance });
    // クレジット購入の請求書には税が付かない(Lago の実測どおり)
    const creditPurchase = prepaid ? PREPAID_WALLET.paidCredits : 0;
    return {
      plan,
      planName: PLANS[plan].name,
      invoice,
      creditPurchase,
      cashOut: creditPurchase + invoice.amountDue,
      walletRemaining: prepaid ? invoice.walletRemaining : null,
    };
  });
}

export function cheapest(quotes: PlanQuote[]): PlanQuote {
  if (quotes.length === 0) throw new Error("見積もりが空です");
  return quotes.reduce((best, q) => (q.cashOut < best.cashOut ? q : best));
}

export function costCurve(opts: { tokensPerCall: number; maxCalls: number; points: number }): CurvePoint[] {
  const { tokensPerCall, maxCalls, points } = opts;
  if (!Number.isInteger(points) || points < 2 || points > 500) {
    throw new Error("points は 2〜500 の整数にしてください");
  }
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_UNITS) {
    throw new Error("maxCalls は 1 以上の整数にしてください");
  }
  if (!Number.isFinite(tokensPerCall) || tokensPerCall < 0 || tokensPerCall > 1e9) {
    throw new Error("tokensPerCall は 0 以上の数にしてください");
  }
  return Array.from({ length: points }, (_, i) => {
    const apiCalls = Math.round((maxCalls * i) / (points - 1));
    const tokens = Math.round(apiCalls * tokensPerCall);
    const [flat, payg, prepaid] = quotePlans({ apiCalls, tokens });
    return { apiCalls, tokens, flat: flat.cashOut, payg: payg.cashOut, prepaid: prepaid.cashOut };
  });
}

function nonNegativeInt(params: URLSearchParams, name: string): number {
  const raw = params.get(name);
  const value = raw === null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_UNITS) {
    throw new Error(`${name} は 0 以上 ${MAX_UNITS} 以下の整数で指定してください`);
  }
  return value;
}

export function parseUsageQuery(params: URLSearchParams): UsageTotals {
  return { apiCalls: nonNegativeInt(params, "apiCalls"), tokens: nonNegativeInt(params, "tokens") };
}
