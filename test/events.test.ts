import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicateEventIndexes, sendEvents } from "../src/events.ts";
import { lagoApiError, type LagoClient } from "../src/lago-client.ts";
import type { UsageEvent } from "../src/usage.ts";

const dupBody = (...idx: number[]) =>
  JSON.stringify({
    status: 422,
    code: "validation_errors",
    error_details: Object.fromEntries(idx.map((i) => [i, { transaction_id: ["value_already_exist"] }])),
  });

test("重複判定: 重複だけが理由の422なら該当インデックスを返す", () => {
  assert.deepEqual(duplicateEventIndexes(dupBody(0, 2)), [0, 2]);
});

test("重複判定: 重複以外のエラーが混ざっていたら null(握りつぶさない)", () => {
  const body = JSON.stringify({ error_details: { 0: { transaction_id: ["value_already_exist"] }, 1: { code: ["value_is_mandatory"] } } });
  assert.equal(duplicateEventIndexes(body), null);
  assert.equal(duplicateEventIndexes("not json"), null);
  assert.equal(duplicateEventIndexes(JSON.stringify({ error_details: {} })), null);
});

const events: UsageEvent[] = [0, 1, 2].map((i) => ({ id: `e${i}`, code: "api_calls", timestamp: 100 + i, properties: {} }));

function fakeLago(handler: (body: any) => void): { lago: LagoClient; sent: string[][] } {
  const sent: string[][] = [];
  const lago = {
    post: async (_path: string, body: any) => {
      sent.push(body.events.map((e: any) => e.transaction_id));
      handler(body);
      return {};
    },
  } as unknown as LagoClient;
  return { lago, sent };
}

test("送信: 契約IDつきの決定的な transaction_id で送る", async () => {
  const { lago, sent } = fakeLago(() => {});
  await sendEvents(lago, "sub1", events);
  assert.deepEqual(sent, [["sub1:e0", "sub1:e1", "sub1:e2"]]);
});

test("送信: 一部が登録済みで422になったら、未登録分だけ再送する", async () => {
  let first = true;
  const { lago, sent } = fakeLago(() => {
    if (first) {
      first = false;
      throw lagoApiError("POST", "/events/batch", 422, dupBody(1));
    }
  });
  await sendEvents(lago, "sub1", events);
  assert.deepEqual(sent[1], ["sub1:e0", "sub1:e2"]);
});

test("送信: 全件が登録済みなら再送せず成功扱い", async () => {
  const { lago, sent } = fakeLago(() => {
    throw lagoApiError("POST", "/events/batch", 422, dupBody(0, 1, 2));
  });
  await sendEvents(lago, "sub1", events);
  assert.equal(sent.length, 1);
});

test("送信: 重複以外の422はそのままエラー", async () => {
  const { lago } = fakeLago(() => {
    throw lagoApiError("POST", "/events/batch", 422, JSON.stringify({ error_details: { 0: { code: ["value_is_mandatory"] } } }));
  });
  await assert.rejects(sendEvents(lago, "sub1", events), /HTTP 422/);
});
