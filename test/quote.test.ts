import { test } from "node:test";
import assert from "node:assert/strict";
import { quotePlans, cheapest, costCurve, parseUsageQuery } from "../src/quote.ts";

test("見積もり: 3プランを固定の順(月額固定・従量課金・前払い)で返す", () => {
  const q = quotePlans({ apiCalls: 200, tokens: 227_935 });
  assert.deepEqual(q.map((x) => x.plan), ["flat", "payg", "prepaid"]);
});

test("見積もり: Lago 実測と同じ支払総額になる(ライト)", () => {
  const [flat, payg, prepaid] = quotePlans({ apiCalls: 200, tokens: 227_935 });
  assert.equal(flat.cashOut, 33_000);
  assert.equal(payg.cashOut, 2_640);
  assert.equal(prepaid.cashOut, 20_000); // 購入額のみ。請求は残高で相殺
  assert.equal(prepaid.creditPurchase, 20_000);
  assert.equal(prepaid.walletRemaining, 19_360);
  assert.equal(flat.walletRemaining, null);
});

test("見積もり: Lago 実測と同じ支払総額になる(ヘビー)", () => {
  const [flat, payg, prepaid] = quotePlans({ apiCalls: 6_001, tokens: 12_050_270 });
  assert.equal(flat.cashOut, 33_000);
  assert.equal(payg.cashOut, 64_818);
  assert.equal(prepaid.cashOut, 62_818);
  assert.equal(prepaid.walletRemaining, 0);
});

test("最安: 支払総額が最小のプラン。同額なら先に並ぶ方", () => {
  assert.equal(cheapest(quotePlans({ apiCalls: 200, tokens: 0 })).plan, "payg");
  assert.equal(cheapest(quotePlans({ apiCalls: 1_500, tokens: 2_395_168 })).plan, "prepaid");
  assert.equal(cheapest(quotePlans({ apiCalls: 6_001, tokens: 12_050_270 })).plan, "flat");
});

test("曲線: 0 から最大件数まで等間隔に、各点の3プラン支払総額を返す", () => {
  const curve = costCurve({ tokensPerCall: 1_000, maxCalls: 1_000, points: 5 });
  assert.deepEqual(curve.map((p) => p.apiCalls), [0, 250, 500, 750, 1000]);
  assert.deepEqual(curve[0], { apiCalls: 0, tokens: 0, flat: 33_000, payg: 0, prepaid: 20_000 });
  assert.equal(curve[4].tokens, 1_000_000);
  assert.equal(curve[4].payg, quotePlans({ apiCalls: 1000, tokens: 1_000_000 })[1].cashOut);
});

test("曲線: 点数が不正ならエラー", () => {
  assert.throws(() => costCurve({ tokensPerCall: 1, maxCalls: 10, points: 1 }), /points/);
});

test("入力検証: 数値の文字列を非負整数として読む", () => {
  assert.deepEqual(parseUsageQuery(new URLSearchParams("apiCalls=10&tokens=20")), { apiCalls: 10, tokens: 20 });
});

test("入力検証: 欠落・負数・小数・非数・過大な値は項目名つきでエラー", () => {
  for (const q of ["tokens=1", "apiCalls=-1&tokens=1", "apiCalls=1.5&tokens=1", "apiCalls=abc&tokens=1", "apiCalls=1&tokens=1e99"]) {
    assert.throws(() => parseUsageQuery(new URLSearchParams(q)), /apiCalls|tokens/, q);
  }
});
