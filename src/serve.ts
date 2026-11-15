// 比較画面を起動する。自分の PC からだけ見えるよう 127.0.0.1 で待ち受ける。
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT が不正です: ${process.env.PORT}`);
  process.exit(1);
}
const root = new URL("..", import.meta.url);
const server = createServer(
  createApp({
    resultPath: fileURLToPath(new URL("out/result.json", root)),
    pagePath: fileURLToPath(new URL("web/index.html", root)),
  }),
);
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `ポート ${port} は使用中です。PORT=別の番号 で指定してください` : e);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`比較画面: http://localhost:${port}`));
