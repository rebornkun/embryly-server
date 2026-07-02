import { supabase } from "../config/supabase.js";
import { getCreditsForProduct } from "../utils/product-utils.js";
import { creditWalletForConsumable } from "../services/credits.js";
import { getUserIdFromTransaction } from "../utils/user-lookup.js";
/**
 * Handle one-time purchase (ONE_TIME_CHARGE)
 */
export async function handleOneTimeCharge(transactionInfo) {
    console.log("💰 One-time charge:", transactionInfo.productId);
    const userId = await getUserIdFromTransaction(transactionInfo);
    if (!userId) {
        console.error("❌ Cannot identify user - no appAccountToken or fallback lookup failed");
        throw new Error("Unable to identify user for one-time charge");
    }
    // Check if transaction has already been processed
    const { data: existingEvent, error: checkError } = await supabase
        .from("subscription_events")
        .select("id")
        .eq("provider", "apple")
        .eq("event_type", "consumable_purchase")
        .eq("raw_payload->>transactionId", transactionInfo.transactionId)
        .single();
    if (checkError && checkError.code !== "PGRST116") {
        // PGRST116 is "not found" which is expected for new transactions
        console.error("❌ Error checking existing transaction:", checkError);
        throw new Error(`Failed to check existing transaction: ${checkError.message}`);
    }
    if (existingEvent) {
        console.log("⚠️ Transaction already processed:", transactionInfo.transactionId);
        return;
    }
    // Get credits for this product
    const credits = getCreditsForProduct(transactionInfo.productId);
    // Credit wallet using credit_wallet RPC (type='topup' for rollover behavior)
    // Note: originalTransactionId may be null for one-time purchases
    await creditWalletForConsumable(userId, credits, transactionInfo.transactionId, transactionInfo.originalTransactionId || transactionInfo.transactionId, transactionInfo.productId, new Date(transactionInfo.purchaseDate));
    // Create purchase event to track the transaction
    const { error: insertError } = await supabase
        .from("subscription_events")
        .insert({
        user_id: userId,
        provider: "apple",
        event_type: "consumable_purchase",
        plan_key: "consumable",
        product_id: transactionInfo.productId,
        entitlement_key: "consumable_credits",
        raw_payload: {
            transactionInfo,
            creditsGranted: credits,
            transactionId: transactionInfo.transactionId,
            notificationType: "ONE_TIME_CHARGE",
        },
    });
    if (insertError) {
        console.error("❌ Error creating consumable purchase event:", insertError);
        throw new Error(`Failed to create consumable purchase event: ${insertError.message}`);
    }
    console.log(`✅ One-time charge processed: ${credits} credits granted to user ${userId}`);
}
