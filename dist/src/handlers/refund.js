import { supabase } from "../config/supabase.js";
import { getPlanKeyFromProductId } from "../utils/product-utils.js";
import { prepareSubscriptionOwnership } from "../utils/user-lookup.js";
/**
 * Handle refund (REFUND)
 */
export async function handleRefund(transactionInfo, renewalInfo) {
    console.log("💰 Refund processed:", transactionInfo.productId);
    const userId = await prepareSubscriptionOwnership(transactionInfo);
    if (!userId) {
        console.error("❌ Cannot identify user - no appAccountToken or fallback lookup failed");
        throw new Error("Unable to identify user for refund");
    }
    // Check if this is the user's current active subscription
    const { data: currentSubscription, error: fetchError } = await supabase
        .from("user_subscriptions")
        .select("original_transaction_id, status, product_id")
        .eq("user_id", userId)
        .single();
    if (fetchError && fetchError.code !== "PGRST116") {
        console.error("❌ Error fetching current subscription:", fetchError);
        throw new Error(`Failed to fetch current subscription: ${fetchError.message}`);
    }
    // Only update subscription status if this refund is for the current subscription
    const isCurrentSubscription = currentSubscription &&
        (currentSubscription.original_transaction_id ===
            transactionInfo.originalTransactionId ||
            currentSubscription.product_id === transactionInfo.productId);
    if (isCurrentSubscription) {
        console.log("🔍 Refund is for current subscription - updating status");
        // Update subscription status to refunded
        const { error: updateError } = await supabase
            .from("user_subscriptions")
            .update({
            status: "refunded",
            updated_at: new Date().toISOString(),
        })
            .eq("user_id", userId);
        if (updateError) {
            console.error("❌ Error updating subscription status to refunded:", updateError);
            throw new Error(`Failed to update subscription status: ${updateError.message}`);
        }
    }
    else {
        console.log("ℹ️ Refund is for a past/different subscription - skipping status update");
    }
    // Create refund event
    const { error: insertError } = await supabase
        .from("subscription_events")
        .insert({
        user_id: userId,
        provider: "apple",
        event_type: "refund",
        plan_key: getPlanKeyFromProductId(transactionInfo.productId),
        product_id: transactionInfo.productId,
        raw_payload: {
            transactionInfo,
            renewalInfo,
            notificationType: "REFUND",
        },
    });
    if (insertError) {
        console.error("❌ Error creating refund event:", insertError);
        throw new Error(`Failed to create refund event: ${insertError.message}`);
    }
    console.log("✅ Refund processed successfully");
}
