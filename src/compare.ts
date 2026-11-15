// Lago の請求書を期待値と同じ形に正規化し、差分を取る(純粋関数)。
import type { ExpectedInvoice, MetricKey } from "./pricing.ts";
import { METRICS } from "./scenario.ts";

export type ActualInvoice = Omit<ExpectedInvoice, "walletRemaining"> & { units: Record<MetricKey, number> };
export type InvoiceDiff = { field: string; expected: number; actual: number };

export function normalizeInvoice(invoice: any): ActualInvoice {
  const fees: any[] = invoice.fees ?? [];
  const subscriptionFee = fees.find((f) => f.item?.type === "subscription");
  const chargeFee = (code: string) => fees.find((f) => f.item?.type === "charge" && f.item?.code === code);
  const api = chargeFee(METRICS.apiCalls.code);
  const tok = chargeFee(METRICS.tokens.code);
  if (!subscriptionFee || !api || !tok) {
    throw new Error(
      `請求書に必要な明細がありません (基本料:${!!subscriptionFee} API:${!!api} トークン:${!!tok})`,
    );
  }
  return {
    baseFee: Number(subscriptionFee.amount_cents),
    fees: { apiCalls: Number(api.amount_cents), tokens: Number(tok.amount_cents) },
    units: { apiCalls: Number(api.units), tokens: Number(tok.units) },
    subtotal: Number(invoice.fees_amount_cents),
    tax: Number(invoice.taxes_amount_cents),
    total: Number(invoice.sub_total_including_taxes_amount_cents),
    prepaidApplied: Number(invoice.prepaid_credit_amount_cents),
    amountDue: Number(invoice.total_amount_cents),
  };
}

export function diffInvoice(expected: ExpectedInvoice, actual: ActualInvoice): InvoiceDiff[] {
  const pairs: Array<[string, number, number]> = [
    ["baseFee", expected.baseFee, actual.baseFee],
    ["fees.apiCalls", expected.fees.apiCalls, actual.fees.apiCalls],
    ["fees.tokens", expected.fees.tokens, actual.fees.tokens],
    ["subtotal", expected.subtotal, actual.subtotal],
    ["tax", expected.tax, actual.tax],
    ["total", expected.total, actual.total],
    ["prepaidApplied", expected.prepaidApplied, actual.prepaidApplied],
    ["amountDue", expected.amountDue, actual.amountDue],
  ];
  return pairs.filter(([, e, a]) => e !== a).map(([field, e, a]) => ({ field, expected: e, actual: a }));
}
