import { test } from "node:test";
import assert from "node:assert/strict";
import { createLagoClient, isLagoApiError, chunk } from "../src/lago-client.ts";

function fakeFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("想定外の呼び出し");
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  };
  return { fn: fn as typeof fetch, calls };
}
const base = { baseUrl: "http://lago.test", apiKey: "k", retryDelayMs: 0 };

test("クライアント: Bearer認証とJSONボディを付けて /api/v1 配下を呼ぶ", async () => {
  const f = fakeFetch([{ status: 200, body: { ok: true } }]);
  const lago = createLagoClient({ ...base, fetch: f.fn });
  assert.deepEqual(await lago.post("/plans", { plan: { code: "a" } }), { ok: true });
  assert.equal(f.calls[0].url, "http://lago.test/api/v1/plans");
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Bearer k");
  assert.equal(f.calls[0].init.body, '{"plan":{"code":"a"}}');
});

test("クライアント: 4xx はリトライせず、ステータスと本文を持つエラーにする", async () => {
  const f = fakeFetch([{ status: 422, body: { error_details: { code: ["value_already_exist"] } } }]);
  const lago = createLagoClient({ ...base, fetch: f.fn });
  await assert.rejects(lago.post("/plans", {}), (e: unknown) => {
    assert.ok(isLagoApiError(e));
    assert.equal(e.status, 422);
    assert.match(e.message, /value_already_exist/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("クライアント: 5xx・429・通信エラーはリトライして成功を返す", async () => {
  const f = fakeFetch([{ status: 503 }, { status: 429 }, new TypeError("fetch failed"), { status: 200, body: { ok: 1 } }]);
  const lago = createLagoClient({ ...base, fetch: f.fn });
  assert.deepEqual(await lago.get("/x"), { ok: 1 });
  assert.equal(f.calls.length, 4);
});

test("クライアント: リトライ上限を超えたら最後のエラーを投げる", async () => {
  const f = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
  const lago = createLagoClient({ ...base, fetch: f.fn, maxAttempts: 3 });
  await assert.rejects(lago.get("/x"), isLagoApiError);
});

test("クライアント: 404 は getOrNull なら null", async () => {
  const f = fakeFetch([{ status: 404, body: { error: "Not Found" } }]);
  const lago = createLagoClient({ ...base, fetch: f.fn });
  assert.equal(await lago.getOrNull("/plans/none"), null);
});

test("chunk: 指定サイズで分割する", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => chunk([1], 0));
});
