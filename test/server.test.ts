import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.ts";

let dir: string;
let withResult: { server: Server; url: string };
let withoutResult: { server: Server; url: string };

async function start(resultPath: string) {
  const server = createServer(createApp({ resultPath, pagePath: join(dir, "index.html") }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}` };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "poc-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>t</title>");
  await writeFile(join(dir, "result.json"), JSON.stringify({ runId: "r1", results: [] }));
  withResult = await start(join(dir, "result.json"));
  withoutResult = await start(join(dir, "missing.json"));
});
after(async () => {
  withResult.server.close();
  withoutResult.server.close();
  await rm(dir, { recursive: true, force: true });
});

test("サーバー: / は画面のHTMLを返す", async () => {
  const res = await fetch(withResult.url + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /<title>t<\/title>/);
});

test("サーバー: /api/scenario はプラン定義と税率を返す", async () => {
  const body = await (await fetch(withResult.url + "/api/scenario")).json();
  assert.equal(body.tax.rate, 10);
  assert.deepEqual(body.plans.map((p: any) => p.key), ["flat", "payg", "prepaid"]);
  assert.equal(body.profiles.length, 3);
});

test("サーバー: /api/quote は3プランの見積もりを返す", async () => {
  const body = await (await fetch(withResult.url + "/api/quote?apiCalls=200&tokens=0")).json();
  assert.equal(body.quotes.length, 3);
  assert.equal(body.cheapest, "payg");
});

test("サーバー: /api/quote の不正な入力は 400 と理由を返す", async () => {
  const res = await fetch(withResult.url + "/api/quote?apiCalls=-5&tokens=0");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /apiCalls/);
});

test("サーバー: /api/curve は曲線を返し、不正な入力は 400", async () => {
  const ok = await (await fetch(withResult.url + "/api/curve?tokensPerCall=1000&maxCalls=1000&points=5")).json();
  assert.equal(ok.curve.length, 5);
  assert.equal((await fetch(withResult.url + "/api/curve?tokensPerCall=1000&maxCalls=0&points=5")).status, 400);
  assert.equal((await fetch(withResult.url + "/api/curve?tokensPerCall=1000&maxCalls=1000&points=99999")).status, 400);
});

test("サーバー: /api/result は保存済みの実行結果を返す", async () => {
  const body = await (await fetch(withResult.url + "/api/result")).json();
  assert.equal(body.runId, "r1");
});

test("サーバー: 実行結果が無ければ 404 と案内を返す(落ちない)", async () => {
  const res = await fetch(withoutResult.url + "/api/result");
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /npm run simulate/);
});

test("サーバー: 未知のパスは 404、GET 以外は 405", async () => {
  assert.equal((await fetch(withResult.url + "/../package.json")).status, 404);
  assert.equal((await fetch(withResult.url + "/api/quote", { method: "POST" })).status, 405);
});
