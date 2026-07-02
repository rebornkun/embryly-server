import { supabase } from "../config/supabase.js";
import { getPlanKeyFromProductId } from "../utils/product-utils.js";
import { prepareSubscriptionOwnership } from "../utils/user-lookup.js";
/**
 * Handle subscription expiration (EXPIRED)
 */
export async function handleExpired(transactionInfo, renewalInfo) {
    console.log("⏰ Subscription expired:", transactionInfo.productId);
    const { expirationIntent, autoRenewStatus, isInBillingRetryPeriod } = renewalInfo;
    const userId = await prepareSubscriptionOwnership(transactionInfo);
    if (!userId) {
        console.error("❌ Cannot identify user - no appAccountToken or fallback lookup failed");
        throw new Error("Unable to identify user for expiration");
    }
    if (autoRenewStatus === 1 && isInBillingRetryPeriod) {
        // This is a failed transaction, not a cancellation
        console.log("Payment failed, Apple is retrying");
        // Don't revoke access yet
        return;
    }
    // Update subscription status to expired
    // Only update if not in billing retry period (already checked above)
    const { error: updateError } = await supabase
        .from("user_subscriptions")
        .update({
        status: "expired",
        auto_renew: false, // Subscription expired, so auto_renew is false
        expired_at: new Date().toISOString(),
    })
        .eq("user_id", userId);
    if (updateError) {
        console.error("❌ Error updating subscription status to expired:", updateError);
        throw new Error(`Failed to update subscription status: ${updateError.message}`);
    }
    // Handle expiration reasons
    switch (expirationIntent) {
        case 1: // User cancelled
            console.log("User cancelled subscription");
            break;
        case 2: // Payment failed (BILLING_RETRY)
            // This expiration happens after DID_FAIL_TO_RENEW when retries stop
            console.log("Payment failed - already handled in DID_FAIL_TO_RENEW");
            break;
        case 3: // Price increase
            console.log("Price increase not accepted");
            break;
        case 4: // Product not available
            console.log("Product no longer available");
            break;
        case 5: // Unknown error
            console.log("Unknown expiration reason");
            break;
    }
    // Create expiration event
    const { error: insertError } = await supabase
        .from("subscription_events")
        .insert({
        user_id: userId,
        provider: "apple",
        event_type: "expired",
        plan_key: getPlanKeyFromProductId(transactionInfo.productId),
        product_id: transactionInfo.productId,
        raw_payload: {
            transactionInfo,
            renewalInfo,
            notificationType: "EXPIRED",
        },
    });
    if (insertError) {
        console.error("❌ Error creating expiration event:", insertError);
        throw new Error(`Failed to create expiration event: ${insertError.message}`);
    }
    console.log("✅ Expiration processed successfully");
}
