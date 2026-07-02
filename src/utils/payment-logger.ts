import { supabase } from "../config/supabase.js";

interface PendingPaymentLog {
  notificationType: string;
  transactionInfo: any;
  renewalInfo?: any;
  error: string;
  errorStack?: string;
  isRetryable?: boolean;
  errorCategory?: "transient" | "permanent" | "unknown";
}

/**
 * Log pending/failed payments for tracking and later processing
 */
export async function logPendingPayment(log: PendingPaymentLog) {
  const userId = log.transactionInfo?.appAccountToken;
  const transactionId = log.transactionInfo?.transactionId;

  console.error("📝 Logging pending payment:", {
    userId,
    transactionId,
    notificationType: log.notificationType,
    error: log.error,
  });

  try {
    // Log to subscription_events table with a special event type
    const { error: insertError } = await supabase
      .from("subscription_events")
      .insert({
        user_id: userId || null,
        provider: "apple",
        event_type: "payment_pending", // Special event type for tracking
        plan_key: log.transactionInfo?.productId
          ? log.transactionInfo.productId.split(".").pop() || "unknown"
          : "unknown",
        product_id: log.transactionInfo?.productId || null,
        entitlement_key: "pending_processing",
        raw_payload: {
          notificationType: log.notificationType,
          transactionInfo: log.transactionInfo,
          renewalInfo: log.renewalInfo,
          error: log.error,
          errorStack: log.errorStack,
          loggedAt: new Date().toISOString(),
          status: log.isRetryable ? "retryable" : "pending",
          isRetryable: log.isRetryable ?? false,
          errorCategory: log.errorCategory ?? "unknown",
        },
      });

    if (insertError) {
      console.error("❌ Failed to log pending payment:", insertError);
      // Fallback to console logging if database insert fails
      console.error("📋 Pending Payment Details:", {
        userId,
        transactionId,
        notificationType: log.notificationType,
        transactionInfo: log.transactionInfo,
        renewalInfo: log.renewalInfo,
        error: log.error,
        errorStack: log.errorStack,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.log("✅ Pending payment logged successfully");
    }
  } catch (error: any) {
    console.error("❌ Exception while logging pending payment:", error);
    // Fallback to console logging
    console.error("📋 Pending Payment Details (Fallback):", {
      userId,
      transactionId,
      notificationType: log.notificationType,
      transactionInfo: log.transactionInfo,
      renewalInfo: log.renewalInfo,
      error: log.error,
      errorStack: log.errorStack,
      timestamp: new Date().toISOString(),
    });
  }
}
