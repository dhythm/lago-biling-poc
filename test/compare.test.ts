import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInvoice, diffInvoice } from "../src/compare.ts";
import type { ExpectedInvoice } from "../src/pricing.ts";

const lagoInvoice = {
  fees_amount_cents: 47285,
  taxes_amount_cents: 4729,
  sub_total_including_taxes_amount_cents: 52014,
  prepaid_credit_amount_cents: 22000,
  total_amount_cents: 30014,
  fees: [
    { item: { type: "subscription", code: "poc_prepaid_credits" }, units: "1.0", amount_cents: 0 },
    { item: { type: "charge", code: "api_calls" }, units: "6001.0", amount_cents: 45005 },
    { item: { type: "charge", code: "ai_tokens" }, units: "2350000.0", amount_cents: 2280 },
  ],
};
const expected: ExpectedInvoice = {
  baseFee: 0,
  fees: { apiCalls: 45005, tokens: 2280 },
  subtotal: 47285,
  tax: 4729,
  total: 52014,
  prepaidApplied: 22000,
  amountDue: 30014,
  walletRemaining: 0,
};

test("正規化: Lagoの請求書JSONを比較用の形に変換する", () => {
  const n = normalizeInvoice(lagoInvoice);
  assert.deepEqual(n, {
    baseFee: 0,
    fees: { apiCalls: 45005, tokens: 2280 },
    units: { apiCalls: 6001, tokens: 2_350_000 },
    subtotal: 47285,
    tax: 4729,
    total: 52014,
    prepaidApplied: 22000,
    amountDue: 30014,
  });
});

test("正規化: 料金明細が欠けていたら黙って0にせずエラー", () => {
  assert.throws(() => normalizeInvoice({ ...lagoInvoice, fees: [] }), /明細/);
});

test("差分: 一致していれば空", () => {
  assert.deepEqual(diffInvoice(expected, normalizeInvoice(lagoInvoice)), []);
});

test("差分: 食い違う項目だけを期待値・実際値つきで返す", () => {
  const actual = { ...normalizeInvoice(lagoInvoice), tax: 4728, total: 52013, amountDue: 30013 };
  assert.deepEqual(diffInvoice(expected, actual), [
    { field: "tax", expected: 4729, actual: 4728 },
    { field: "total", expected: 52014, actual: 52013 },
    { field: "amountDue", expected: 30014, actual: 30013 },
  ]);
});
