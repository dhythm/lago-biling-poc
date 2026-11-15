// 比較画面用のローカルサーバー。Lago にも外部にも接続しない(保存済みの結果とローカル計算だけを返す)。
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { quotePlans, cheapest, costCurve, parseUsageQuery } from "./quote.ts";
import { PLANS, PROFILES, PREPAID_WALLET, TAX, CURRENCY } from "./scenario.ts";

export type AppConfig = { resultPath: string; pagePath: string };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const isNotFound = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

export function createApp(config: AppConfig) {
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET") return sendJson(res, 405, { error: "GET のみ対応しています" });
    const url = new URL(req.url ?? "/", "http://localhost");

    switch (url.pathname) {
      case "/": {
        const html = await readFile(config.pagePath);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(html);
        return;
      }
      case "/api/scenario":
        return sendJson(res, 200, {
          currency: CURRENCY,
          tax: TAX,
          wallet: PREPAID_WALLET,
          plans: (["flat", "payg", "prepaid"] as const).map((key) => ({ key, ...PLANS[key] })),
          profiles: PROFILES,
        });
      case "/api/quote": {
        let usage;
        try {
          usage = parseUsageQuery(url.searchParams);
        } catch (e) {
          return sendJson(res, 400, { error: (e as Error).message });
        }
        const quotes = quotePlans(usage);
        return sendJson(res, 200, { usage, quotes, cheapest: cheapest(quotes).plan });
      }
      case "/api/curve": {
        const num = (name: string) => Number(url.searchParams.get(name) ?? NaN);
        try {
          const curve = costCurve({
            tokensPerCall: num("tokensPerCall"),
            maxCalls: num("maxCalls"),
            points: num("points"),
          });
          return sendJson(res, 200, { curve });
        } catch (e) {
          return sendJson(res, 400, { error: (e as Error).message });
        }
      }
      case "/api/result":
        try {
          return sendJson(res, 200, JSON.parse(await readFile(config.resultPath, "utf8")));
        } catch (e) {
          if (isNotFound(e)) {
            return sendJson(res, 404, {
              error: "Lago の実行結果がまだありません。npm run simulate を実行すると表示されます",
            });
          }
          throw e;
        }
      default:
        return sendJson(res, 404, { error: "見つかりません" });
    }
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((e) => {
      console.error(`リクエスト処理に失敗: ${req.method} ${req.url}`, e);
      if (!res.headersSent) sendJson(res, 500, { error: "サーバー内部でエラーが発生しました" });
      else res.end();
    });
  };
}
