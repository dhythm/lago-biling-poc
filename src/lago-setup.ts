// シナリオ定義を Lago 上のリソース(メトリクス・税・プラン・顧客・ウォレット・契約)に写す。
import type { LagoClient } from "./lago-client.ts";
import { isLagoApiError } from "./lago-client.ts";
import type { ChargeSpec, PlanSpec } from "./pricing.ts";
import { CURRENCY, METRICS, TAX } from "./scenario.ts";

export async function poll<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`タイムアウト: ${label}`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1500));
  }
}

async function ensure<T>(lago: LagoClient, getPath: string, create: () => Promise<T>): Promise<T> {
  const existing = await lago.getOrNull<T>(getPath);
  if (existing) return existing;
  try {
    return await create();
  } catch (e) {
    // 並行実行などで先に作られていた場合は既存を使う
    if (isLagoApiError(e) && e.status === 422) {
      const again = await lago.getOrNull<T>(getPath);
      if (again) return again;
    }
    throw e;
  }
}

export async function ensureTax(lago: LagoClient): Promise<void> {
  await ensure(lago, `/taxes/${TAX.code}`, () =>
    lago.post("/taxes", { tax: { name: TAX.name, code: TAX.code, rate: String(TAX.rate) } }),
  );
}

export async function ensureMetrics(lago: LagoClient): Promise<Record<"apiCalls" | "tokens", string>> {
  const a = METRICS.apiCalls;
  const t = METRICS.tokens;
  const apiCalls = await ensure<any>(lago, `/billable_metrics/${a.code}`, () =>
    lago.post("/billable_metrics", {
      billable_metric: { name: a.name, code: a.code, aggregation_type: a.aggregation, recurring: false },
    }),
  );
  const tokens = await ensure<any>(lago, `/billable_metrics/${t.code}`, () =>
    lago.post("/billable_metrics", {
      billable_metric: {
        name: t.name,
        code: t.code,
        aggregation_type: t.aggregation,
        field_name: t.field,
        recurring: false,
      },
    }),
  );
  return { apiCalls: apiCalls.billable_metric.lago_id, tokens: tokens.billable_metric.lago_id };
}

export function toLagoCharge(spec: ChargeSpec): { charge_model: string; properties: Record<string, unknown> } {
  switch (spec.model) {
    case "standard":
      return { charge_model: "standard", properties: { amount: String(spec.perUnit) } };
    case "graduated":
      return {
        charge_model: "graduated",
        properties: {
          graduated_ranges: spec.ranges.map((r) => ({
            from_value: r.from,
            to_value: r.to,
            per_unit_amount: String(r.perUnit),
            flat_amount: String(r.flat),
          })),
        },
      };
    case "package":
      return {
        charge_model: "package",
        properties: { amount: String(spec.amount), package_size: spec.packageSize, free_units: spec.freeUnits },
      };
  }
}

export async function ensurePlan(
  lago: LagoClient,
  plan: PlanSpec,
  metricIds: Record<"apiCalls" | "tokens", string>,
): Promise<void> {
  await ensure(lago, `/plans/${plan.code}`, () =>
    lago.post("/plans", {
      plan: {
        name: plan.name,
        code: plan.code,
        interval: "monthly",
        amount_cents: plan.baseAmount, // JPY は補助単位なしなので円そのまま
        amount_currency: CURRENCY,
        pay_in_advance: false,
        charges: (["apiCalls", "tokens"] as const).map((key) => ({
          billable_metric_id: metricIds[key],
          pay_in_advance: false,
          invoiceable: true,
          ...toLagoCharge(plan.charges[key]),
        })),
      },
    }),
  );
}

export async function createCustomer(lago: LagoClient, externalId: string, name: string): Promise<void> {
  await lago.post("/customers", {
    customer: { external_id: externalId, name, currency: CURRENCY, tax_codes: [TAX.code] },
  });
}

/** ウォレットを作り、クレジット購入の請求書を「入金済み」にして残高を有効化する。 */
export async function fundWallet(
  lago: LagoClient,
  customerId: string,
  credits: { paidCredits: number; grantedCredits: number },
): Promise<{ walletId: string; purchaseInvoice: any }> {
  const { wallet } = await lago.post<any>("/wallets", {
    wallet: {
      external_customer_id: customerId,
      name: "前払いクレジット",
      rate_amount: "1",
      currency: CURRENCY,
      paid_credits: String(credits.paidCredits),
      granted_credits: String(credits.grantedCredits),
    },
  });
  const purchase = await poll(`クレジット購入請求書の発行 (${customerId})`, async () => {
    const res = await lago.get<any>(`/invoices?external_customer_id=${customerId}&invoice_type=credit`);
    return res.invoices?.[0];
  });
  await lago.put(`/invoices/${purchase.lago_id}`, { invoice: { payment_status: "succeeded" } });
  const expected = credits.paidCredits + credits.grantedCredits;
  await poll(`ウォレット残高の反映 (${customerId})`, async () => {
    const res = await lago.get<any>(`/wallets/${wallet.lago_id}`);
    return Number(res.wallet.credits_balance) === expected;
  });
  const { invoice } = await lago.get<any>(`/invoices/${purchase.lago_id}`);
  return { walletId: wallet.lago_id, purchaseInvoice: invoice };
}

export async function createSubscription(
  lago: LagoClient,
  args: { customerId: string; subscriptionId: string; planCode: string; startAt: Date },
): Promise<void> {
  await lago.post("/subscriptions", {
    subscription: {
      external_customer_id: args.customerId,
      external_id: args.subscriptionId,
      plan_code: args.planCode,
      billing_time: "anniversary",
      subscription_at: args.startAt.toISOString(),
    },
  });
}
