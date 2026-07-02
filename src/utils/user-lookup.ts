import { supabase } from "../config/supabase.js";

/**
 * Prepare subscription ownership by identifying the correct user and cleaning up old records if needed.
 * This function should be used by webhook handlers to ensure proper ownership transfer.
 *
 * @param transactionInfo Transaction info from Apple
 * @returns userId or null if not found
 */
export async function prepareSubscriptionOwnership(
  transactionInfo: any,
): Promise<string | null> {
  // First, identify the correct owner
  const userId = await getUserIdFromTransaction(transactionInfo);
  
  if (!userId || !transactionInfo.originalTransactionId) {
    return userId;
  }

  // Check if this original_transaction_id is linked to a different user
  const { data: existingSub, error: checkError } = await supabase
    .from("user_subscriptions")
    .select("user_id, status, period_end")
    .eq("original_transaction_id", transactionInfo.originalTransactionId)
    .single();

  if (checkError && checkError.code !== "PGRST116") {
    console.error("❌ Error checking existing subscription:", checkError);
    return userId;
  }

  // If subscription exists for different user, clean it up
  if (existingSub && existingSub.user_id !== userId) {
    const isExpired = new Date(existingSub.period_end) < new Date();
    const isExpiredStatus = existingSub.status === "expired" || existingSub.status === "cancelled";

    if (isExpired || isExpiredStatus) {
      console.log("🗑️ Cleaning up expired subscription from old user:", {
        oldUserId: existingSub.user_id,
        newUserId: userId,
        originalTransactionId: transactionInfo.originalTransactionId,
      });

      const { error: deleteError } = await supabase
        .from("user_subscriptions")
        .delete()
        .eq("user_id", existingSub.user_id);

      if (deleteError) {
        console.error("❌ Error deleting old subscription:", deleteError);
      } else {
        console.log("✅ Old subscription cleaned up successfully");
      }
    } else {
      console.warn("⚠️ Active subscription exists for different user - no cleanup performed:", {
        existingUserId: existingSub.user_id,
        newUserId: userId,
      });
    }
  }

  return userId;
}

/**
 * Lookup user ID from transaction info (read-only, no mutations)
 *
 * Priority (UPDATED for transfer support AND re-subscription after expiration):
 * 1. appAccountToken (if subscription expired or new purchase)
 * 2. originalTransactionId lookup in user_subscriptions table (for active subscriptions/renewals)
 * 3. transactionId lookup in subscription_events table
 *
 * @param transactionInfo Transaction info from Apple
 * @returns userId or null if not found
 */
export async function getUserIdFromTransaction(
  transactionInfo: any,
): Promise<string | null> {
  // Priority 1: Check if there's an existing subscription by originalTransactionId
  if (transactionInfo.originalTransactionId) {
    const { data: subscription, error } = await supabase
      .from("user_subscriptions")
      .select("user_id, app_account_token, status, period_end")
      .eq("original_transaction_id", transactionInfo.originalTransactionId)
      .eq("provider", "apple")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!error && subscription?.user_id) {
      // Check if subscription is expired
      const isExpired = new Date(subscription.period_end) < new Date();
      const isExpiredStatus = subscription.status === "expired" || 
                              subscription.status === "cancelled";
      
      // If expired AND appAccountToken is different, this is a NEW purchase by different user
      if ((isExpired || isExpiredStatus) && 
          transactionInfo.appAccountToken && 
          transactionInfo.appAccountToken !== subscription.user_id) {
        console.log(
          "✅ Expired subscription found, but appAccountToken indicates new purchaser:",
          transactionInfo.appAccountToken,
          "old owner:",
          subscription.user_id,
        );
        // Use appAccountToken for new purchase
        return transactionInfo.appAccountToken;
      }
      
      // Check if subscription was transferred (appAccountToken doesn't match DB)
      const wasTransferred = 
        transactionInfo.appAccountToken && 
        transactionInfo.appAccountToken !== subscription.user_id;
      
      if (wasTransferred) {
        console.log(
          "✅ User identified via originalTransactionId (subscription was transferred):",
          subscription.user_id,
          "(current owner), original purchaser:",
          transactionInfo.appAccountToken,
        );
      } else {
        console.log(
          "✅ User identified via originalTransactionId lookup:",
          subscription.user_id,
        );
      }
      
      return subscription.user_id;
    }
  }

  // Priority 2: Use appAccountToken if available (fallback for new subscriptions)
  if (transactionInfo.appAccountToken) {
    console.log(
      "✅ User identified via appAccountToken:",
      transactionInfo.appAccountToken,
    );
    return transactionInfo.appAccountToken;
  }

  console.warn("⚠️ No originalTransactionId or appAccountToken found, attempting event lookup...");

  // Priority 3: Lookup by transactionId in subscription_events
  // This helps for renewals where we might have processed the original purchase
  if (transactionInfo.transactionId) {
    const { data: event, error } = await supabase
      .from("subscription_events")
      .select("user_id")
      .eq("provider", "apple")
      .or(
        `raw_payload->>transactionId.eq.${transactionInfo.transactionId},raw_payload->transactionInfo->>transactionId.eq.${transactionInfo.transactionId}`,
      )
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!error && event?.user_id) {
      console.log(
        "✅ User identified via transactionId lookup in events:",
        event.user_id,
      );
      return event.user_id;
    }
  }

  console.error("❌ Unable to identify user from transaction:", {
    hasAppAccountToken: !!transactionInfo.appAccountToken,
    hasOriginalTransactionId: !!transactionInfo.originalTransactionId,
    hasTransactionId: !!transactionInfo.transactionId,
    productId: transactionInfo.productId,
  });

  return null;
}
