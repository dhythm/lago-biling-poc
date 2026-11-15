// 利用イベントの送信。Lago のバッチ API は1件でも重複があるとバッチ全体を 422 で拒否するため、
// 再実行・リトライ時は重複分を除いて送り直す。
import { chunk, isLagoApiError, type LagoClient } from "./lago-client.ts";
import type { UsageEvent } from "./usage.ts";

const BATCH_SIZE = 100; // Lago のバッチ上限

/** 422 の原因が transaction_id の重複だけなら、その位置を返す。それ以外は null。 */
export function duplicateEventIndexes(errorBody: string): number[] | null {
  let details: unknown;
  try {
    details = JSON.parse(errorBody)?.error_details;
  } catch {
    return null;
  }
  if (!details || typeof details !== "object") return null;
  const entries = Object.entries(details as Record<string, Record<string, string[]>>);
  if (entries.length === 0) return null;
  const onlyDuplicates = entries.every(([index, errors]) => {
    const fields = Object.entries(errors ?? {});
    return (
      /^\d+$/.test(index) &&
      fields.length === 1 &&
      fields[0][0] === "transaction_id" &&
      fields[0][1].every((code) => code === "value_already_exist")
    );
  });
  return onlyDuplicates ? entries.map(([index]) => Number(index)) : null;
}

export async function sendEvents(lago: LagoClient, subscriptionId: string, events: UsageEvent[]): Promise<void> {
  const toPayload = (e: UsageEvent) => ({
    // 契約ごとに一意かつ決定的なので、同じデータを送り直しても二重計上されない
    transaction_id: `${subscriptionId}:${e.id}`,
    external_subscription_id: subscriptionId,
    code: e.code,
    timestamp: e.timestamp,
    properties: e.properties,
  });
  for (const batch of chunk(events.map(toPayload), BATCH_SIZE)) {
    try {
      await lago.post("/events/batch", { events: batch });
    } catch (e) {
      const duplicates = isLagoApiError(e) && e.status === 422 ? duplicateEventIndexes(e.body) : null;
      if (!duplicates) throw e;
      const skip = new Set(duplicates);
      const rest = batch.filter((_, i) => !skip.has(i));
      if (rest.length > 0) await lago.post("/events/batch", { events: rest });
    }
  }
}
