import { supabase } from "../config/supabase.js";
import { prepareSubscriptionOwnership } from "../utils/user-lookup.js";

/**
 * Handle renewal status change (DID_CHANGE_RENEWAL_STATUS)
 */
export async function handleDidChangeRenewalStatus(
  transactionInfo: any,
  renewalInfo: any,
) {
  console.log(" Did change renewal status:", transactionInfo.productId);
  const userId = await prepareSubscriptionOwnership(transactionInfo);
  if (!userId) {
    console.error(
      " Cannot identify user - no appAccountToken or fallback lookup failed",
    );
    throw new Error("Unable to identify user for renewal status change");
  }

  const { autoRenewStatus, expirationIntent } = renewalInfo;

  if (autoRenewStatus === 0) {
    // User cancelled auto-renewal
    console.log("User cancelled auto-renewal");
    // Update database but don't revoke access yet
    const { data: userSubscriptionsData, error: userSubscriptionsError } =
      await supabase
        .from("user_subscriptions")
        .update({
          auto_renew: false,
          status: "active", // Still active until period expires
        })
        .eq("user_id", userId);

    console.log("🔍 user_subscriptions data:", userSubscriptionsData);
    console.log("🔍 user_subscriptions error:", userSubscriptionsError);

    if (userSubscriptionsError) {
      console.error(
        "❌ Error updating subscription auto-renew status:",
        userSubscriptionsError,
      );
      throw new Error(
        `Failed to update subscription auto-renew status: ${userSubscriptionsError.message}`,
      );
    }

    // Log auto-renewal cancellation event
    const { error: cancelEventError } = await supabase
      .from("subscription_events")
      .insert({
        user_id: userId,
        provider: "apple",
        event_type: "auto_renew_disabled",
        plan_key: transactionInfo.productId
          ? transactionInfo.productId.split(".").pop() || "unknown"
          : "unknown",
        product_id: transactionInfo.productId,
        auto_renew: false,
        raw_payload: {
          transactionInfo,
          renewalInfo,
          notificationType: "DID_CHANGE_RENEWAL_STATUS",
          expirationIntent,
        },
      });

    if (cancelEventError) {
      console.error(
        "❌ Error creating auto-renew disabled event:",
        cancelEventError,
      );
      // Don't throw - event logging shouldn't block the main flow
    }
  } else if (autoRenewStatus === 1) {
    // User re-enabled auto-renewal
    console.log("User re-enabled auto-renewal");
    const { data: userSubscriptionsData, error: userSubscriptionsError } =
      await supabase
        .from("user_subscriptions")
        .update({
          auto_renew: true,
          status: "active",
        })
        .eq("user_id", userId);

    console.log(" user_subscriptions data:", userSubscriptionsData);
    console.log(" user_subscriptions error:", userSubscriptionsError);

    if (userSubscriptionsError) {
      console.error(
        " Error updating subscription auto-renew status:",
        userSubscriptionsError,
      );
      throw new Error(
        `Failed to update subscription auto-renew status: ${userSubscriptionsError.message}`,
      );
    }

    // Log auto-renewal re-enabled event
    const { error: enableEventError } = await supabase
      .from("subscription_events")
      .insert({
        user_id: userId,
        provider: "apple",
        event_type: "auto_renew_enabled",
        plan_key: transactionInfo.productId
          ? transactionInfo.productId.split(".").pop() || "unknown"
          : "unknown",
        product_id: transactionInfo.productId,
        auto_renew: true,
        raw_payload: {
          transactionInfo,
          renewalInfo,
          notificationType: "DID_CHANGE_RENEWAL_STATUS",
        },
      });

    if (enableEventError) {
      console.error(
        " Error creating auto-renew enabled event:",
        enableEventError,
      );
      // Don't throw - event logging shouldn't block the main flow
    }
  }

  console.log(" Renewal status change processed successfully");
}
