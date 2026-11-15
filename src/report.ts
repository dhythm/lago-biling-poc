// 比較結果を Markdown にする。
import type { CaseResult } from "./main.ts";

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

export function renderReport(runId: string, results: CaseResult[]): string {
  const lines: string[] = [`# Lago 請求シミュレーション結果 (${runId})`, ""];
  const profiles = [...new Set(results.map((r) => r.profile))];

  lines.push("## 当月の支払総額(税込)", "");
  lines.push("| 顧客 | API呼び出し | トークン | 月額固定 | 従量課金 | 前払いクレジット | 最安 |");
  lines.push("|---|--:|--:|--:|--:|--:|---|");
  for (const p of profiles) {
    const rows = results.filter((r) => r.profile === p);
    const by = (k: string) => rows.find((r) => r.plan === k)!;
    const cheapest = [...rows].sort((a, b) => a.cashOut - b.cashOut)[0];
    const prepaid = by("prepaid");
    lines.push(
      `| ${rows[0].profileName} | ${rows[0].usage.apiCalls.toLocaleString()} | ${rows[0].usage.tokens.toLocaleString()} | ${yen(by("flat").cashOut)} | ${yen(by("payg").cashOut)} | ${yen(prepaid.cashOut)} (残高 ${yen(prepaid.walletRemaining ?? 0)}) | ${cheapest.planName} |`,
    );
  }

  lines.push("", "## 請求書の内訳と期待値との照合", "");
  lines.push("| 顧客 | プラン | 請求書 | 基本料 | API料金 | トークン料金 | 小計 | 税 | 税込合計 | クレジット充当 | 請求額 | 期待値と |");
  lines.push("|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|---|");
  for (const r of results) {
    const a = r.actual;
    const verdict =
      r.diffs.length === 0
        ? "一致"
        : r.diffs.map((d) => `${d.field}: 期待 ${d.expected} / 実際 ${d.actual}`).join("<br>");
    lines.push(
      `| ${r.profileName} | ${r.planName} | ${r.invoiceNumber} | ${yen(a.baseFee)} | ${yen(a.fees.apiCalls)} | ${yen(a.fees.tokens)} | ${yen(a.subtotal)} | ${yen(a.tax)} | ${yen(a.total)} | ${yen(a.prepaidApplied)} | ${yen(a.amountDue)} | ${verdict} |`,
    );
  }
  return lines.join("\n") + "\n";
}
