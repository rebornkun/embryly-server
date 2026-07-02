import { supabase } from "../config/supabase.js";
import { prepareSubscriptionOwnership } from "../utils/user-lookup.js";
/**
 * Handle failed to renew (DID_FAIL_TO_RENEW)
 */
export async function handleFailedToRenew(transactionInfo, renewalInfo) {
    console.log("❌ Failed to renew:", transactionInfo.productId);
    const userId = await prepareSubscriptionOwnership(transactionInfo);
    if (!userId) {
        console.error("❌ Cannot identify user - no appAccountToken or fallback lookup failed");
        throw new Error("Unable to identify user for failed renewal");
    }
    const { autoRenewStatus, isInBillingRetryPeriod, expirationIntent } = renewalInfo;
    console.log("Payment failed during renewal:", {
        autoRenewStatus,
        isInBillingRetryPeriod,
        expirationIntent,
    });
    // Get current subscription to get retry count
    const { data: currentSubscription, error: fetchError } = await supabase
        .from("user_subscriptions")
        .select("retry_count")
        .eq("user_id", userId)
        .single();
    if (fetchError && fetchError.code !== "PGRST116") {
        // PGRST116 is "not found" which might be okay for new subscriptions
        console.error("❌ Error fetching current subscription:", fetchError);
        throw new Error(`Failed to fetch current subscription: ${fetchError.message}`);
    }
    if (isInBillingRetryPeriod) {
        // Apple is retrying payment
        console.log("Apple is retrying payment...");
        // Update subscription status but don't revoke access
        const { error: updateError } = await supabase
            .from("user_subscriptions")
            .update({
            status: "retry_payment", // Custom status for retry
            auto_renew: true, // Still trying to renew
            last_payment_attempt: new Date().toISOString(),
            retry_count: (currentSubscription?.retry_count || 0) + 1,
        })
            .eq("user_id", userId);
        if (updateError) {
            console.error("❌ Error updating subscription for retry:", updateError);
            throw new Error(`Failed to update subscription for retry: ${updateError.message}`);
        }
        // Log payment retry event for audit trail
        const { error: retryEventError } = await supabase
            .from("subscription_events")
            .insert({
            user_id: userId,
            provider: "apple",
            event_type: "payment_retry",
            plan_key: transactionInfo.productId
                ? transactionInfo.productId.split(".").pop() || "unknown"
                : "unknown",
            product_id: transactionInfo.productId,
            raw_payload: {
                transactionInfo,
                renewalInfo,
                notificationType: "DID_FAIL_TO_RENEW",
                retryCount: (currentSubscription?.retry_count || 0) + 1,
                isInBillingRetryPeriod,
            },
        });
        if (retryEventError) {
            console.error("❌ Error creating payment retry event:", retryEventError);
            // Don't throw - event logging shouldn't block the main flow
        }
        // Optional: Notify user about payment issue
        // await notifyUserPaymentIssue(transactionInfo.appAccountToken);
    }
    else {
        // Apple has given up retrying
        console.log("Apple has stopped retrying payment");
        // Update subscription status
        const { error: updateError } = await supabase
            .from("user_subscriptions")
            .update({
            status: "expired",
            auto_renew: false,
            expired_at: new Date().toISOString(),
        })
            .eq("user_id", userId);
        if (updateError) {
            console.error("❌ Error updating subscription to expired:", updateError);
            throw new Error(`Failed to update subscription to expired: ${updateError.message}`);
        }
        // Log payment failure event
        const { error: failureEventError } = await supabase
            .from("subscription_events")
            .insert({
            user_id: userId,
            provider: "apple",
            event_type: "payment_failed",
            plan_key: transactionInfo.productId
                ? transactionInfo.productId.split(".").pop() || "unknown"
                : "unknown",
            product_id: transactionInfo.productId,
            raw_payload: {
                transactionInfo,
                renewalInfo,
                notificationType: "DID_FAIL_TO_RENEW",
                expirationIntent,
                finalRetryCount: currentSubscription?.retry_count || 0,
            },
        });
        if (failureEventError) {
            console.error("❌ Error creating payment failure event:", failureEventError);
            // Don't throw - event logging shouldn't block the main flow
        }
        // Revoke user access
    }
    console.log("✅ Failed renewal processed successfully");
}
