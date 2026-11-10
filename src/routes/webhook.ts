import { Router } from "express";
import { verifier } from "../config/apple.js";
import * as handlers from "../handlers/index.js";
import { logPendingPayment } from "../utils/payment-logger.js";
import { classifyError } from "../utils/error-classifier.js";
import { finishPaymentEvent, recordPaymentEvent } from "../utils/payment-events.js";

const router = Router();

router.post("/webhook", async (req, res) => {
  let notificationType: string | null = null;
  let txInfo: any = null;
  let renewalInfo: any = null;
  let eventId: string | null = null;
  const signedPayload: string | undefined = req.body?.signedPayload;

  try {
    console.log("📱 Received App Store notification");

    if (!signedPayload) {
      console.error("❌ Missing signedPayload in webhook request");
      // Always return 200 to Apple even for invalid requests
      return res.status(200).json({
        status: "error",
        message: "Missing signedPayload",
      });
    }

    if (!verifier) {
      console.error("❌ Verifier not configured");
      return res.status(200).json({
        status: "error",
        message: "Verifier not found",
      });
    }

    const notification = await verifier.verifyAndDecodeNotification(signedPayload);
    const data: any = notification.data;
    notificationType = notification.notificationType ?? null;

    // Decode transaction info (always present)
    txInfo = await verifier.verifyAndDecodeTransaction(
      data.signedTransactionInfo,
    );

    // For subscription notifications, decode renewal info
    if (data.signedRenewalInfo) {
      renewalInfo = await verifier.verifyAndDecodeRenewalInfo(
        data.signedRenewalInfo,
      );
    }

    // Stored before processing: the full payload survives even if a handler
    // fails, and Vercel's one-day log window doesn't matter.
    eventId = await recordPaymentEvent({
      signedPayload,
      notificationUUID: notification.notificationUUID,
      notificationType,
      subtype: notification.subtype ?? null,
      environment: data.environment ?? null,
      txInfo,
      renewalInfo,
    });

    console.log("📱 App Store notification:", {
      type: notificationType,
      subtype: notification.subtype ?? null,
      productId: txInfo?.productId,
      originalTransactionId: txInfo?.originalTransactionId,
      userId: txInfo?.appAccountToken,
    });

    if (!renewalInfo) {
      console.warn("⚠️ No renewal info for subscription notification");
      await finishPaymentEvent(eventId, "ignored", "Missing renewal info");
      return res.status(200).json({
        status: "error",
        message: "Missing renewal info for subscription",
      });
    }

    // Handle different notification types
    switch (notificationType) {
      case "SUBSCRIBED":
        await handlers.handleSubscribed(txInfo, renewalInfo);
        break;
      case "DID_RENEW":
        await handlers.handleRenewal(txInfo, renewalInfo);
        break;
      case "EXPIRED":
        await handlers.handleExpired(txInfo, renewalInfo);
        break;
      case "REFUND":
        await handlers.handleRefund(txInfo, renewalInfo);
        break;
      case "DID_FAIL_TO_RENEW":
        await handlers.handleFailedToRenew(txInfo, renewalInfo);
        break;
      case "DID_CHANGE_RENEWAL_STATUS":
        await handlers.handleDidChangeRenewalStatus(txInfo, renewalInfo);
        break;
      default:
        console.log("ℹ️ Unhandled notification type:", notificationType);
        await finishPaymentEvent(eventId, "ignored");
        return res.status(200).json({ status: "success" });
    }

    await finishPaymentEvent(eventId, "processed");
    res.status(200).json({ status: "success" });
  } catch (error: any) {
    // Classify error to determine if it's retryable
    const errorClassification = classifyError(error);

    console.error("❌ Error processing notification:", {
      error: error.message,
      stack: error.stack,
      notificationType,
      transactionId: txInfo?.transactionId,
      userId: txInfo?.appAccountToken,
      isRetryable: errorClassification.isRetryable,
      category: errorClassification.category,
    });

    // Verification can fail before the row exists: keep the raw payload anyway.
    if (!eventId && signedPayload) {
      eventId = await recordPaymentEvent({ signedPayload, notificationType, txInfo, renewalInfo });
    }
    await finishPaymentEvent(eventId, "failed", error?.message ?? String(error));

    // Always log errors for tracking (regardless of retryability)
    if (txInfo) {
      await logPendingPayment({
        notificationType: notificationType || "UNKNOWN",
        transactionInfo: txInfo,
        renewalInfo,
        error: error.message,
        errorStack: error.stack,
        isRetryable: errorClassification.isRetryable,
        errorCategory: errorClassification.category,
      });
    }

    // For retryable errors, return 500 so Apple retries
    // For non-retryable errors, return 200 to prevent duplicate processing
    if (errorClassification.isRetryable) {
      console.log("🔄 Returning 500 - Apple will retry this notification");
      return res.status(500).json({
        status: "error",
        message: "Temporary error - will retry",
        retryable: true,
      });
    }

    // Non-retryable error - acknowledge receipt to prevent retries
    console.log("⚠️ Returning 200 - Error logged for manual review");
    return res.status(200).json({
      status: "error",
      message: "Error processing notification (logged for review)",
      retryable: false,
    });
  }
});

export default router;
