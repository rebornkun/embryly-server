import { supabase } from "../config/supabase.js";

/**
 * Durable record of every App Store notification (table: payment_events).
 * Vercel keeps logs for one day; this keeps the raw payload and the outcome
 * so failures can be found and replayed later. Never throws: losing an audit
 * row must not stop a payment from being processed.
 */

type Received = {
  signedPayload: string;
  notificationUUID?: string | null;
  notificationType?: string | null;
  subtype?: string | null;
  environment?: string | null;
  txInfo?: any;
  renewalInfo?: any;
};

export async function recordPaymentEvent(event: Received): Promise<string | null> {
  const row = {
    source: "apple_webhook",
    notification_uuid: event.notificationUUID ?? null,
    notification_type: event.notificationType ?? null,
    subtype: event.subtype ?? null,
    environment: event.environment ?? null,
    user_id: isUuid(event.txInfo?.appAccountToken) ? event.txInfo.appAccountToken : null,
    original_transaction_id: event.txInfo?.originalTransactionId ?? null,
    transaction_id: event.txInfo?.transactionId ?? null,
    product_id: event.txInfo?.productId ?? null,
    signed_payload: event.signedPayload,
    decoded: { txInfo: event.txInfo ?? null, renewalInfo: event.renewalInfo ?? null },
    status: "received",
    error: null,
    processed_at: null,
  };
  try {
    if (row.notification_uuid) {
      // Apple retries with the same notificationUUID: count the attempt.
      const { data: existing } = await supabase
        .from("payment_events")
        .select("id, attempts")
        .eq("notification_uuid", row.notification_uuid)
        .maybeSingle();
      if (existing) {
        await supabase
          .from("payment_events")
          .update({ ...row, attempts: (existing.attempts ?? 1) + 1 })
          .eq("id", existing.id);
        return existing.id;
      }
    }
    const { data, error } = await supabase
      .from("payment_events")
      .insert(row)
      .select("id")
      .single();
    if (error) {
      console.error("payment_events insert failed:", error.message);
      return null;
    }
    return data.id;
  } catch (error: any) {
    console.error("payment_events insert failed:", error?.message);
    return null;
  }
}

export async function finishPaymentEvent(
  id: string | null,
  status: "processed" | "failed" | "ignored",
  error?: string,
) {
  if (!id) return;
  try {
    const { error: updateError } = await supabase
      .from("payment_events")
      .update({ status, error: error ?? null, processed_at: new Date().toISOString() })
      .eq("id", id);
    if (updateError) console.error("payment_events update failed:", updateError.message);
  } catch (e: any) {
    console.error("payment_events update failed:", e?.message);
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
