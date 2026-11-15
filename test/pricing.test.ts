import { test } from "node:test";
import assert from "node:assert/strict";
import {
  graduatedAmount,
  packageAmount,
  roundCurrency,
  expectedInvoice,
  type PlanSpec,
} from "../src/pricing.ts";

const ranges = [
  { from: 0, to: 1000, perUnit: 12, flat: 0 },
  { from: 1001, to: 4000, perUnit: 8, flat: 0 },
  { from: 4001, to: null, perUnit: 4.5, flat: 0 },
];

test("段階料金: 利用ゼロなら0円", () => {
  assert.equal(graduatedAmount(0, ranges), 0);
});

test("段階料金: 第1段のみ", () => {
  assert.equal(graduatedAmount(200, ranges), 2400);
});

test("段階料金: 境界ちょうど(1000件)は第1段単価のみ", () => {
  assert.equal(graduatedAmount(1000, ranges), 12000);
});

test("段階料金: 境界を1件超えると超過分だけ第2段単価", () => {
  assert.equal(graduatedAmount(1001, ranges), 12008);
});

test("段階料金: 3段すべてにまたがる", () => {
  // 1000*12 + 3000*8 + 2001*4.5
  assert.equal(graduatedAmount(6001, ranges), 12000 + 24000 + 9004.5);
});

test("段階料金: 段ごとの固定額は到達した段だけ加算", () => {
  const withFlat = [
    { from: 0, to: 10, perUnit: 1, flat: 100 },
    { from: 11, to: null, perUnit: 1, flat: 500 },
  ];
  assert.equal(graduatedAmount(5, withFlat), 105);
  assert.equal(graduatedAmount(11, withFlat), 100 + 10 + 500 + 1);
});

const pkg = { amount: 120, packageSize: 100_000, freeUnits: 500_000 };

test("パッケージ料金: 無料枠内は0円", () => {
  assert.equal(packageAmount(500_000, pkg), 0);
});

test("パッケージ料金: 無料枠を1超えたら1パッケージ分", () => {
  assert.equal(packageAmount(500_001, pkg), 120);
});

test("パッケージ料金: 端数は切り上げでパッケージ数を数える", () => {
  // (2_350_000 - 500_000) / 100_000 = 18.5 -> 19
  assert.equal(packageAmount(2_350_000, pkg), 19 * 120);
});

test("通貨丸め: JPYは整数に四捨五入", () => {
  assert.equal(roundCurrency(9004.5), 9005);
  assert.equal(roundCurrency(9004.49), 9004);
});

const payg: PlanSpec = {
  code: "payg",
  name: "従量課金",
  baseAmount: 0,
  charges: {
    apiCalls: { model: "graduated", ranges },
    tokens: { model: "package", ...pkg },
  },
};
const flat: PlanSpec = {
  code: "flat",
  name: "月額固定",
  baseAmount: 30000,
  charges: {
    apiCalls: { model: "standard", perUnit: 0 },
    tokens: { model: "standard", perUnit: 0 },
  },
};

test("請求書: 月額固定は利用量に関係なく基本料+税", () => {
  const inv = expectedInvoice(flat, { apiCalls: 6001, tokens: 12_000_000 }, { taxRate: 10, walletBalance: 0 });
  assert.equal(inv.subtotal, 30000);
  assert.equal(inv.tax, 3000);
  assert.equal(inv.total, 33000);
  assert.equal(inv.amountDue, 33000);
});

test("請求書: 従量課金は料金項目ごとに丸めてから合算し税を乗せる", () => {
  const inv = expectedInvoice(payg, { apiCalls: 6001, tokens: 2_350_000 }, { taxRate: 10, walletBalance: 0 });
  assert.equal(inv.fees.apiCalls, 45005);
  assert.equal(inv.fees.tokens, 2280);
  assert.equal(inv.subtotal, 47285);
  assert.equal(inv.tax, 4729); // 4728.5 -> 四捨五入
  assert.equal(inv.total, 52014);
});

test("請求書: 前払い残高が税込合計を上回れば請求0、残高が減る", () => {
  const inv = expectedInvoice(payg, { apiCalls: 200, tokens: 0 }, { taxRate: 10, walletBalance: 22000 });
  assert.equal(inv.total, 2640);
  assert.equal(inv.prepaidApplied, 2640);
  assert.equal(inv.amountDue, 0);
  assert.equal(inv.walletRemaining, 19360);
});

test("請求書: 前払い残高を使い切ったら超過分だけ請求", () => {
  const inv = expectedInvoice(payg, { apiCalls: 6001, tokens: 2_350_000 }, { taxRate: 10, walletBalance: 22000 });
  assert.equal(inv.prepaidApplied, 22000);
  assert.equal(inv.amountDue, 52014 - 22000);
  assert.equal(inv.walletRemaining, 0);
});

test("請求書: 負の利用量は不正としてエラー", () => {
  assert.throws(() => expectedInvoice(payg, { apiCalls: -1, tokens: 0 }, { taxRate: 10, walletBalance: 0 }), /利用量/);
});
