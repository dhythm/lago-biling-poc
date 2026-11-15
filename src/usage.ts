// 顧客の利用データ(シード付きで決定的に生成)。全プランに同じデータを流す。
import type { UsageTotals } from "./pricing.ts";

export type UsageProfile = { code: string; name: string; apiCalls: number; avgTokensPerCall: number };
/** start: 契約開始(=期間開始)。usageEnd: 利用データを生成する範囲の終わり(排他的、今日0時UTC)。 */
export type BillingPeriod = { start: Date; usageEnd: Date; usageDays: number };
export type UsageEvent = {
  id: string;
  code: "api_calls" | "ai_tokens";
  timestamp: number; // UNIX秒
  properties: Record<string, string | number>;
};

const DAY_MS = 86_400_000;

/**
 * `today`(UTC)が最終日になる月次(契約日基準)の請求期間を返す。
 * 今日サブスクリプションを解約すれば、ちょうど1期間分の最終請求書になる。
 */
export function billingPeriodClosingOn(today: Date): BillingPeriod {
  const usageEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const tomorrow = new Date(usageEnd.getTime() + DAY_MS);
  const start = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() - 1, tomorrow.getUTCDate()));
  if (start.getUTCDate() !== tomorrow.getUTCDate()) {
    throw new Error(
      `請求期間を作れません: 前月に ${tomorrow.getUTCDate()} 日がありません。別の日に実行してください`,
    );
  }
  return { start, usageEnd, usageDays: Math.round((usageEnd.getTime() - start.getTime()) / DAY_MS) };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateUsage(profile: UsageProfile, period: BillingPeriod, seed: number): UsageEvent[] {
  const rand = mulberry32(seed);
  const startSec = period.start.getTime() / 1000;

  // 平日は多く、週末は少ない。日ごとにゆらぎも入れる。
  const weights = Array.from({ length: period.usageDays }, (_, i) => {
    const dow = new Date(period.start.getTime() + i * DAY_MS).getUTCDay();
    return (dow === 0 || dow === 6 ? 0.35 : 1) * (0.6 + rand() * 0.8);
  });
  const cumulative: number[] = [];
  weights.reduce((acc, w, i) => (cumulative[i] = acc + w), 0);
  const totalWeight = cumulative[cumulative.length - 1];

  const events: UsageEvent[] = [];
  const tokensPerDay = new Array<number>(period.usageDays).fill(0);

  for (let i = 0; i < profile.apiCalls; i++) {
    const pick = rand() * totalWeight;
    const day = cumulative.findIndex((c) => pick < c);
    // 日次トークン集計(23:59:00)より前に収まるよう、その日の 0:00〜23:58:59
    const secondOfDay = Math.floor(rand() * (86_400 - 60));
    tokensPerDay[day] += Math.round(profile.avgTokensPerCall * (0.5 + rand()));
    events.push({
      id: `${profile.code}-s${seed}-call-${i}`,
      code: "api_calls",
      timestamp: startSec + day * 86_400 + secondOfDay,
      properties: { endpoint: rand() < 0.7 ? "/v1/chat" : "/v1/embed" },
    });
  }

  tokensPerDay.forEach((tokens, day) => {
    if (tokens === 0) return;
    events.push({
      id: `${profile.code}-s${seed}-tokens-d${day}`,
      code: "ai_tokens",
      timestamp: startSec + day * 86_400 + 86_400 - 60,
      properties: { tokens },
    });
  });

  return events.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

export function summarizeUsage(events: UsageEvent[]): UsageTotals {
  let apiCalls = 0;
  let tokens = 0;
  for (const e of events) {
    if (e.code === "api_calls") apiCalls += 1;
    else tokens += Number(e.properties.tokens);
  }
  return { apiCalls, tokens };
}
