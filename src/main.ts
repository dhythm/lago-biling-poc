// 3プラン × 利用プロファイルを Lago に流し、請求書を取得して期待値と比較する。
import { mkdir, writeFile } from "node:fs/promises";
import { createLagoClient, type LagoClient } from "./lago-client.ts";
import { sendEvents } from "./events.ts";
import {
  ensureTax,
  ensureMetrics,
  ensurePlan,
  createCustomer,
  fundWallet,
  createSubscription,
  poll,
} from "./lago-setup.ts";
import { PLANS, PROFILES, PREPAID_WALLET, TAX, USAGE_SEED, METRICS, type PlanKey } from "./scenario.ts";
import { billingPeriodClosingOn, generateUsage, summarizeUsage, type UsageEvent } from "./usage.ts";
import { expectedInvoice, type ExpectedInvoice, type UsageTotals } from "./pricing.ts";
import { normalizeInvoice, diffInvoice, type ActualInvoice, type InvoiceDiff } from "./compare.ts";
import { renderReport } from "./report.ts";

export type CaseResult = {
  profile: string;
  profileName: string;
  plan: PlanKey;
  planName: string;
  usage: UsageTotals;
  expected: ExpectedInvoice;
  actual: ActualInvoice;
  diffs: InvoiceDiff[];
  creditPurchase: number; // 前払いで先に支払った額(税込)
  cashOut: number; // 当月の支払総額 = クレジット購入 + 請求書の請求額
  walletRemaining: number | null;
  invoiceNumber: string;
};

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} がありません。lago/.env を確認してください`);
  return value;
}

async function waitForUsage(
  lago: LagoClient,
  customerId: string,
  subscriptionId: string,
  usage: UsageTotals,
): Promise<void> {
  let last = "";
  try {
    await poll(
      `利用量の集計 (${subscriptionId})`,
      async () => {
        const res = await lago.get<any>(
          `/customers/${customerId}/current_usage?external_subscription_id=${subscriptionId}`,
        );
        const units = (code: string) =>
          Number(res.customer_usage.charges_usage.find((c: any) => c.billable_metric.code === code)?.units ?? 0);
        const api = units(METRICS.apiCalls.code);
        const tok = units(METRICS.tokens.code);
        last = `API ${api}/${usage.apiCalls}, トークン ${tok}/${usage.tokens}`;
        return api === usage.apiCalls && tok === usage.tokens;
      },
      { timeoutMs: 300_000, intervalMs: 3000 },
    );
  } catch (e) {
    throw new Error(`${(e as Error).message} — 最後の観測値: ${last}`);
  }
}

async function runCase(
  lago: LagoClient,
  runId: string,
  profile: (typeof PROFILES)[number],
  planKey: PlanKey,
  events: UsageEvent[],
  startAt: Date,
): Promise<CaseResult> {
  const plan = PLANS[planKey];
  const id = `${runId}-${profile.code}-${planKey}`;
  const usage = summarizeUsage(events);

  await createCustomer(lago, id, `${profile.name} × ${plan.name}`);
  let walletId: string | null = null;
  let creditPurchase = 0;
  if (planKey === "prepaid") {
    const funded = await fundWallet(lago, id, PREPAID_WALLET);
    walletId = funded.walletId;
    creditPurchase = Number(funded.purchaseInvoice.total_amount_cents);
  }
  await createSubscription(lago, { customerId: id, subscriptionId: id, planCode: plan.code, startAt });

  await sendEvents(lago, id, events);
  await waitForUsage(lago, id, id, usage);
  log(`${id}: イベント ${events.length} 件の集計を確認`);

  // 期間最終日に解約 → 1期間分の最終請求書が即時発行される
  await lago.del(`/subscriptions/${id}`);
  const invoice = await poll(
    `請求書の確定 (${id})`,
    async () => {
      const res = await lago.get<any>(`/invoices?external_customer_id=${id}&invoice_type=subscription`);
      const found = res.invoices?.find((i: any) => i.status === "finalized");
      return found ? (await lago.get<any>(`/invoices/${found.lago_id}`)).invoice : null;
    },
    { timeoutMs: 180_000 },
  );

  const walletBalance = walletId ? PREPAID_WALLET.paidCredits + PREPAID_WALLET.grantedCredits : 0;
  const expected = expectedInvoice(plan, usage, { taxRate: TAX.rate, walletBalance });
  const actual = normalizeInvoice(invoice);
  const walletRemaining = walletId
    ? await poll(`ウォレット残高の更新 (${id})`, async () => {
        const { wallet } = await lago.get<any>(`/wallets/${walletId}`);
        const balance = Number(wallet.balance_cents);
        // 消費の反映は非同期。請求書の充当額と整合するまで待つ
        return balance === walletBalance - actual.prepaidApplied ? { balance } : null;
      }).then((r) => r.balance)
    : null;

  return {
    profile: profile.code,
    profileName: profile.name,
    plan: planKey,
    planName: plan.name,
    usage,
    expected,
    actual,
    diffs: diffInvoice(expected, actual),
    creditPurchase,
    cashOut: creditPurchase + actual.amountDue,
    walletRemaining,
    invoiceNumber: invoice.number,
  };
}

async function main(): Promise<void> {
  const lago = createLagoClient({ baseUrl: requireEnv("LAGO_API_URL"), apiKey: requireEnv("LAGO_ORG_API_KEY") });
  const period = billingPeriodClosingOn(new Date());
  const runId = `r${new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12)}`;
  log(`実行ID ${runId} / 請求期間 ${period.start.toISOString().slice(0, 10)} 〜 今日`);

  await ensureTax(lago);
  const metricIds = await ensureMetrics(lago);
  for (const plan of Object.values(PLANS)) await ensurePlan(lago, plan, metricIds);
  log("メトリクス・税・3プランを準備");

  const results: CaseResult[] = [];
  for (const profile of PROFILES) {
    // 同じ利用データを3プランすべてに流す
    const events = generateUsage(profile, period, USAGE_SEED);
    const batch = await Promise.all(
      (Object.keys(PLANS) as PlanKey[]).map((planKey) =>
        runCase(lago, runId, profile, planKey, events, period.start),
      ),
    );
    results.push(...batch);
  }

  await mkdir("out", { recursive: true });
  await writeFile("out/result.json", JSON.stringify({ runId, period, results }, null, 2));
  const report = renderReport(runId, results);
  await writeFile("out/report.md", report);
  console.log(`\n${report}`);

  const mismatches = results.filter((r) => r.diffs.length > 0).length;
  log(mismatches === 0 ? "全ケースで期待値と一致" : `期待値と不一致: ${mismatches} ケース (out/report.md 参照)`);
}

main().catch((e) => {
  console.error(`\n失敗: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
