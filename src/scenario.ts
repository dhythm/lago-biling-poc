// 検証シナリオの定義。ここを書き換えれば料金体系・顧客像を変えて再実行できる。
import type { PlanSpec, ChargeSpec } from "./pricing.ts";
import type { UsageProfile } from "./usage.ts";

export const CURRENCY = "JPY";
export const TAX = { code: "jp_consumption_tax", name: "消費税", rate: 10 };
export const USAGE_SEED = 20261115;

export const METRICS = {
  apiCalls: { code: "api_calls", name: "API呼び出し", aggregation: "count_agg" as const },
  tokens: { code: "ai_tokens", name: "AIトークン", aggregation: "sum_agg" as const, field: "tokens" },
};

// 従量単価: API呼び出しは3段階の段階料金(小数単価あり)、トークンは無料枠つきパッケージ料金
const usageCharges: Record<"apiCalls" | "tokens", ChargeSpec> = {
  apiCalls: {
    model: "graduated",
    ranges: [
      { from: 0, to: 1000, perUnit: 12, flat: 0 },
      { from: 1001, to: 4000, perUnit: 8, flat: 0 },
      { from: 4001, to: null, perUnit: 4.5, flat: 0 },
    ],
  },
  tokens: { model: "package", amount: 120, packageSize: 100_000, freeUnits: 500_000 },
};

export type PlanKey = "flat" | "payg" | "prepaid";

export const PLANS: Record<PlanKey, PlanSpec> = {
  flat: {
    code: "poc_flat_monthly",
    name: "月額固定",
    baseAmount: 30_000,
    // 単価0円の料金として登録し、請求書に利用量だけは載せる
    charges: { apiCalls: { model: "standard", perUnit: 0 }, tokens: { model: "standard", perUnit: 0 } },
  },
  payg: { code: "poc_pay_as_you_go", name: "従量課金", baseAmount: 0, charges: usageCharges },
  // 単価は従量課金と同一。違いは前払いクレジット(ウォレット)の有無だけ
  prepaid: { code: "poc_prepaid_credits", name: "前払いクレジット", baseAmount: 0, charges: usageCharges },
};

/** 前払い: 20,000円分を購入すると 10% (2,000円分) のボーナスが付く。1クレジット = 1円。 */
export const PREPAID_WALLET = { paidCredits: 20_000, grantedCredits: 2_000 };

export const PROFILES: UsageProfile[] = [
  { code: "light", name: "ライト", apiCalls: 200, avgTokensPerCall: 1_200 },
  { code: "standard", name: "スタンダード", apiCalls: 1_500, avgTokensPerCall: 1_600 },
  { code: "heavy", name: "ヘビー", apiCalls: 6_001, avgTokensPerCall: 2_000 },
];
