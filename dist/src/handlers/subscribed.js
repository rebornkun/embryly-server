import { supabase } from "../config/supabase.js";
import { getPlanKeyFromProductId } from "../utils/product-utils.js";
import { prepareSubscriptionOwnership } from "../utils/user-lookup.js";
/**
 * Handle initial subscription (SUBSCRIBED)
 */
export async function handleSubscribed(transactionInfo, renewalInfo) {
    console.log("🎉 New subscription:", transactionInfo.productId);
    const userId = await prepareSubscriptionOwnership(transactionInfo);
    if (!userId) {
        console.error("❌ Cannot identify user - no appAccountToken or fallback lookup failed");
        throw new Error("Unable to identify user for subscription");
    }
    console.log("👤 User ID:", userId);
    // Check if this transaction has already been processed
    // This prevents duplicate processing if both app validation and webhook fire
    const { data: existingEvent, error: checkError } = await supabase
        .from("subscription_events")
        .select("id")
        .eq("provider", "apple")
        .eq("user_id", userId)
        .or(`raw_payload->>transactionId.eq.${transactionInfo.transactionId},raw_payload->transactionInfo->>transactionId.eq.${transactionInfo.transactionId}`)
        .single();
    if (checkError && checkError.code !== "PGRST116") {
        console.error("❌ Error checking existing transaction:", checkError);
        throw new Error(`Failed to check existing transaction: ${checkError.message}`);
    }
    if (existingEvent) {
        console.log("⚠️ Transaction already processed:", transactionInfo.transactionId);
        // Still update subscription status (in case it changed) but don't grant credits again
        // await supabase
        //   .from("user_subscriptions")
        //   .update({
        //     status: "active",
        //     auto_renew: renewalInfo.autoRenewStatus === 1,
        //     period_end: new Date(transactionInfo.expiresDate).toISOString(),
        //   })
        //   .eq("user_id", userId);
        console.log("✅ Subscription status updated (credits already granted)");
        return;
    }
    let status = "active";
    // Checking if it's from free trial
    if (transactionInfo?.offerDiscountType === "FREE_TRIAL") {
        status = "free_trial";
    }
    const planKey = getPlanKeyFromProductId(transactionInfo.productId);
    // Create/update user subscription (cleanup already handled by prepareSubscriptionOwnership)
    const { data, error } = await supabase.from("user_subscriptions").upsert({
        user_id: userId,
        provider: "apple",
        plan_key: planKey,
        status: status,
        product_id: transactionInfo.productId,
        entitlement_key: null,
        auto_renew: renewalInfo.autoRenewStatus === 1,
        period_start: new Date(transactionInfo.purchaseDate).toISOString(),
        period_end: new Date(transactionInfo.expiresDate).toISOString(),
        last_granted_at: new Date(transactionInfo.purchaseDate).toISOString(),
        transaction_id: transactionInfo.transactionId,
        original_transaction_id: transactionInfo.originalTransactionId,
        app_account_token: transactionInfo.appAccountToken,
        retry_count: 0,
        last_payment_attempt: null,
        expired_at: null,
    }, { onConflict: "user_id" });
    console.log("🔍 user_subscriptions data:", data);
    console.log("🔍 user_subscriptions error:", error);
    if (error) {
        console.error("❌ Error updating user subscription:", error);
        throw new Error(`Failed to update user subscription: ${error.message}`);
    }
    // Create subscription event
    const { data: subscriptionEventData, error: subscriptionEventError } = await supabase.from("subscription_events").insert({
        user_id: userId,
        provider: "apple",
        event_type: "purchase",
        plan_key: planKey,
        product_id: transactionInfo.productId,
        entitlement_key: null,
        period_start: new Date(transactionInfo.purchaseDate).toISOString(),
        period_end: new Date(transactionInfo.expiresDate).toISOString(),
        auto_renew: renewalInfo.autoRenewStatus === 1,
        raw_payload: {
            transactionInfo,
            renewalInfo,
            notificationType: "SUBSCRIBED",
        },
    });
    console.log("🔍 subscription_events data:", subscriptionEventData);
    console.log("🔍 subscription_events error:", subscriptionEventError);
    if (subscriptionEventError) {
        console.error("❌ Error creating subscription event:", subscriptionEventError);
        throw new Error(`Failed to create subscription event: ${subscriptionEventError.message}`);
    }
    console.log("✅ Subscription processed successfully");
}
