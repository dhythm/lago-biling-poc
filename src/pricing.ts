// 期待請求額の計算(純粋関数)。Lago が返す請求書と突き合わせるための独立した基準。

export type GraduatedRange = { from: number; to: number | null; perUnit: number; flat: number };

export type ChargeSpec =
  | { model: "standard"; perUnit: number }
  | { model: "graduated"; ranges: GraduatedRange[] }
  | { model: "package"; amount: number; packageSize: number; freeUnits: number };

export type MetricKey = "apiCalls" | "tokens";
export type UsageTotals = Record<MetricKey, number>;

export type PlanSpec = {
  code: string;
  name: string;
  baseAmount: number;
  charges: Record<MetricKey, ChargeSpec>;
};

export type ExpectedInvoice = {
  baseFee: number;
  fees: Record<MetricKey, number>;
  subtotal: number;
  tax: number;
  total: number;
  prepaidApplied: number;
  amountDue: number;
  walletRemaining: number;
};

/** JPY は小数を持たないので整数へ四捨五入する。 */
export function roundCurrency(amount: number): number {
  // 浮動小数の誤差(例: 9004.499999)で丸め方向が変わらないよう微小値を足す
  return Math.round(amount + 1e-9);
}

export function graduatedAmount(units: number, ranges: GraduatedRange[]): number {
  let total = 0;
  for (const r of ranges) {
    // from は「この段に入る最初の1件目」。0始まりの段は1件目から数える。
    const lowerExclusive = r.from === 0 ? 0 : r.from - 1;
    if (units <= lowerExclusive) break;
    const upper = r.to === null ? units : Math.min(units, r.to);
    total += (upper - lowerExclusive) * r.perUnit + r.flat;
  }
  return total;
}

export function packageAmount(
  units: number,
  spec: { amount: number; packageSize: number; freeUnits: number },
): number {
  const billable = Math.max(0, units - spec.freeUnits);
  return Math.ceil(billable / spec.packageSize) * spec.amount;
}

export function chargeAmount(units: number, spec: ChargeSpec): number {
  switch (spec.model) {
    case "standard":
      return units * spec.perUnit;
    case "graduated":
      return graduatedAmount(units, spec.ranges);
    case "package":
      return packageAmount(units, spec);
  }
}

export function expectedInvoice(
  plan: PlanSpec,
  usage: UsageTotals,
  opts: { taxRate: number; walletBalance: number },
): ExpectedInvoice {
  for (const [key, units] of Object.entries(usage)) {
    if (!Number.isFinite(units) || units < 0) {
      throw new Error(`利用量が不正です: ${key}=${units}`);
    }
  }
  const fees = {
    apiCalls: roundCurrency(chargeAmount(usage.apiCalls, plan.charges.apiCalls)),
    tokens: roundCurrency(chargeAmount(usage.tokens, plan.charges.tokens)),
  };
  const subtotal = plan.baseAmount + fees.apiCalls + fees.tokens;
  const tax = roundCurrency((subtotal * opts.taxRate) / 100);
  const total = subtotal + tax;
  const prepaidApplied = Math.min(total, Math.max(0, opts.walletBalance));
  return {
    baseFee: plan.baseAmount,
    fees,
    subtotal,
    tax,
    total,
    prepaidApplied,
    amountDue: total - prepaidApplied,
    walletRemaining: opts.walletBalance - prepaidApplied,
  };
}
