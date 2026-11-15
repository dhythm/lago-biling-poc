// 所見の裏付け用の追加検証(重複イベント・未入金クレジット・期間外イベント・日割り)。
import { createLagoClient, isLagoApiError } from "./lago-client.ts";
import { createCustomer, createSubscription, poll } from "./lago-setup.ts";
import { PLANS, CURRENCY } from "./scenario.ts";

const lago = createLagoClient({ baseUrl: process.env.LAGO_API_URL!, apiKey: process.env.LAGO_ORG_API_KEY! });
const id = `probe-${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: Record<string, unknown> = {};
const attempt = async (fn: () => Promise<unknown>) => {
  try {
    return await fn();
  } catch (e) {
    return isLagoApiError(e) ? `HTTP ${e.status}: ${e.body.slice(0, 200)}` : String(e);
  }
};
const usage = async (cid: string) => {
  const r = await lago.get<any>(`/customers/${cid}/current_usage?external_subscription_id=${cid}`);
  return Object.fromEntries(r.customer_usage.charges_usage.map((c: any) => [c.billable_metric.code, Number(c.units)]));
};

// 1) 未入金のクレジット購入: 入金前の残高と請求書の中身
const w = `${id}-wallet`;
await createCustomer(lago, w, "probe wallet");
const { wallet } = await lago.post<any>("/wallets", {
  wallet: { external_customer_id: w, name: "p", rate_amount: "1", currency: CURRENCY, paid_credits: "20000", granted_credits: "2000" },
});
const inv = await poll("credit invoice", async () => (await lago.get<any>(`/invoices?external_customer_id=${w}&invoice_type=credit`)).invoices?.[0]);
await sleep(3000);
const before = (await lago.get<any>(`/wallets/${wallet.lago_id}`)).wallet;
out.wallet_before_payment = { credits_balance: before.credits_balance, status: before.status };
out.credit_invoice = { status: inv.status, payment_status: inv.payment_status, fees: inv.fees_amount_cents, taxes: inv.taxes_amount_cents, total: inv.total_amount_cents };

// 2) 重複イベント・期間外イベント
const s = `${id}-events`;
await createCustomer(lago, s, "probe events");
const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
await createSubscription(lago, { customerId: s, subscriptionId: s, planCode: PLANS.payg.code, startAt: tenDaysAgo });
const now = Math.floor(Date.now() / 1000);
const ev = (tx: string, ts: number) => ({ transaction_id: tx, external_subscription_id: s, code: "api_calls", timestamp: ts, properties: {} });
out.first_send = await attempt(() => lago.post("/events", { event: ev(`${s}-1`, now - 3600) }).then(() => "ok"));
out.duplicate_single = await attempt(() => lago.post("/events", { event: ev(`${s}-1`, now - 3600) }).then(() => "ok"));
out.duplicate_batch = await attempt(() => lago.post("/events/batch", { events: [ev(`${s}-1`, now - 3600), ev(`${s}-2`, now - 3500)] }).then(() => "ok"));
out.before_subscription_start = await attempt(() => lago.post("/events", { event: ev(`${s}-old`, now - 20 * 86_400) }).then(() => "ok"));
out.unknown_metric = await attempt(() => lago.post("/events", { event: { ...ev(`${s}-x`, now - 100), code: "no_such_metric" } }).then(() => "ok"));
await sleep(8000);
out.units_after_duplicates = await usage(s);

// 3) 期間途中の解約: 月額固定の日割り
const f = `${id}-flat`;
await createCustomer(lago, f, "probe proration");
await createSubscription(lago, { customerId: f, subscriptionId: f, planCode: PLANS.flat.code, startAt: tenDaysAgo });
await lago.del(`/subscriptions/${f}`);
const pro = await poll("prorated invoice", async () => (await lago.get<any>(`/invoices?external_customer_id=${f}&invoice_type=subscription`)).invoices?.find((i: any) => i.status === "finalized"));
const fee = pro.fees?.find((x: any) => x.item.type === "subscription");
out.proration = { base_fee: fee?.amount_cents, from: fee?.from_date, to: fee?.to_date, total: pro.total_amount_cents };

console.log(JSON.stringify(out, null, 2));
