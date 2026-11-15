import { test } from "node:test";
import assert from "node:assert/strict";
import { generateUsage, summarizeUsage, billingPeriodClosingOn, type UsageProfile } from "../src/usage.ts";

const profile: UsageProfile = { code: "standard", name: "標準", apiCalls: 1500, avgTokensPerCall: 1500 };
const period = billingPeriodClosingOn(new Date("2026-11-15T13:00:00Z"));

test("請求期間: 今日が期間の最終日になる(契約日 = 1か月前の翌日 0時UTC)", () => {
  assert.equal(period.start.toISOString(), "2026-10-16T00:00:00.000Z");
  assert.equal(period.usageEnd.toISOString(), "2026-11-15T00:00:00.000Z");
  assert.equal(period.usageDays, 30);
});

test("請求期間: 月またぎでも翌日基準で1か月さかのぼる", () => {
  const p = billingPeriodClosingOn(new Date("2026-04-30T05:00:00Z"));
  assert.equal(p.start.toISOString(), "2026-04-01T00:00:00.000Z");
});

test("請求期間: 前月に契約日が存在しない日はエラー", () => {
  assert.throws(() => billingPeriodClosingOn(new Date("2026-03-29T00:00:00Z")), /請求期間/);
});

test("利用データ: 同じシードなら完全に同じデータになる", () => {
  assert.deepEqual(generateUsage(profile, period, 42), generateUsage(profile, period, 42));
});

test("利用データ: API呼び出しイベント数はプロファイルの件数と一致", () => {
  const s = summarizeUsage(generateUsage(profile, period, 42));
  assert.equal(s.apiCalls, 1500);
});

test("利用データ: トークンは日次集計イベントで、合計は呼び出し数×平均の近傍", () => {
  const events = generateUsage(profile, period, 42);
  const tokenEvents = events.filter((e) => e.code === "ai_tokens");
  assert.ok(tokenEvents.length <= period.usageDays);
  const s = summarizeUsage(events);
  assert.ok(s.tokens > 1500 * 1500 * 0.7 && s.tokens < 1500 * 1500 * 1.3, `tokens=${s.tokens}`);
});

test("利用データ: すべてのタイムスタンプが請求期間内", () => {
  for (const e of generateUsage(profile, period, 42)) {
    assert.ok(e.timestamp >= period.start.getTime() / 1000 && e.timestamp < period.usageEnd.getTime() / 1000);
  }
});

test("利用データ: イベントIDは一意で、再生成しても同じ(冪等送信できる)", () => {
  const events = generateUsage(profile, period, 42);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
});
