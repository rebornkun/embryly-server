import { supabase } from "../config/supabase.js";
import { getPlanKeyFromProductId } from "../utils/product-utils.js";
import { prepareSubscriptionOwnership } from "../utils/user-lookup.js";

/**
 * Handle subscription renewal (DID_RENEW)
 */
export async function handleRenewal(transactionInfo: any, renewalInfo: any) {
  console.log("🔄 Subscription renewed:", transactionInfo.productId);

  const userId = await prepareSubscriptionOwnership(transactionInfo);

  if (!userId) {
    console.error(
      "❌ Cannot identify user - no appAccountToken or fallback lookup failed",
    );
    throw new Error("Unable to identify user for renewal");
  }

  // Check if this renewal has already been processed
  const { data: existingEvent, error: checkError } = await supabase
    .from("subscription_events")
    .select("id")
    .eq("provider", "apple")
    .eq("user_id", userId)
    .eq("event_type", "renewal")
    .or(
      `raw_payload->>transactionId.eq.${transactionInfo.transactionId},raw_payload->transactionInfo->>transactionId.eq.${transactionInfo.transactionId}`,
    )
    .single();

  if (checkError && checkError.code !== "PGRST116") {
    console.error("❌ Error checking existing renewal:", checkError);
    throw new Error(`Failed to check existing renewal: ${checkError.message}`);
  }

  if (existingEvent) {
    console.log("⚠️ Renewal already processed:", transactionInfo.transactionId);
    return;
  }

  const periodStart = new Date(transactionInfo.purchaseDate);
  const expiresDate = new Date(transactionInfo.expiresDate);

  // Update subscription
  const { error: updateError } = await supabase
    .from("user_subscriptions")
    .update({
      status: "active",
      period_end: expiresDate.toISOString(),
      last_granted_at: periodStart.toISOString(),
      auto_renew: renewalInfo.autoRenewStatus === 1,
      retry_count: 0,
      last_payment_attempt: null,
      expired_at: null,
    })
    .eq("user_id", userId);

  if (updateError) {
    console.error("❌ Error updating subscription for renewal:", updateError);
    throw new Error(
      `Failed to update subscription for renewal: ${updateError.message}`,
    );
  }

  const planKey = getPlanKeyFromProductId(transactionInfo.productId);

  // Create renewal event
  const { error: insertError } = await supabase
    .from("subscription_events")
    .insert({
      user_id: userId,
      provider: "apple",
      event_type: "renewal",
      plan_key: planKey,
      product_id: transactionInfo.productId,
      entitlement_key: null,
      period_start: periodStart.toISOString(),
      period_end: expiresDate.toISOString(),
      auto_renew: renewalInfo.autoRenewStatus === 1,
      raw_payload: {
        transactionInfo,
        renewalInfo,
        notificationType: "DID_RENEW",
      },
    });

  if (insertError) {
    console.error("❌ Error creating renewal event:", insertError);
    throw new Error(`Failed to create renewal event: ${insertError.message}`);
  }

  console.log("✅ Renewal processed successfully");
}
