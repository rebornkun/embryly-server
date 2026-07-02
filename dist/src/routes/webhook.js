import { Router } from "express";
import { verifier } from "../config/apple.js";
import * as handlers from "../handlers/index.js";
import { logPendingPayment } from "../utils/payment-logger.js";
import { classifyError } from "../utils/error-classifier.js";
const router = Router();
router.post("/webhook", async (req, res) => {
    let notificationType = null;
    let txInfo = null;
    let renewalInfo = null;
    try {
        console.log("📱 Received App Store notification");
        const { signedPayload } = req.body;
        if (!signedPayload) {
            console.error("❌ Missing signedPayload in webhook request");
            // Always return 200 to Apple even for invalid requests
            return res.status(200).json({
                status: "error",
                message: "Missing signedPayload",
            });
        }
        console.log("🔍 signedPayload:", signedPayload);
        if (!verifier) {
            console.error("❌ Verifier not configured");
            return res.status(200).json({
                status: "error",
                message: "Verifier not found",
            });
        }
        // Use Apple's verifier
        console.log("✅ Using Apple's verifier");
        const { notificationType: decodedNotificationType, data } = await verifier.verifyAndDecodeNotification(signedPayload);
        notificationType = decodedNotificationType;
        console.log("🔍 notificationType:", notificationType);
        console.log("🔍 data:", data);
        // Decode transaction info (always present)
        txInfo = await verifier.verifyAndDecodeTransaction(data.signedTransactionInfo);
        // For subscription notifications, decode renewal info
        if (!data.signedRenewalInfo) {
            console.warn("⚠️ No renewal info for subscription notification");
            return res.status(200).json({
                status: "error",
                message: "Missing renewal info for subscription",
            });
        }
        renewalInfo = await verifier.verifyAndDecodeRenewalInfo(data.signedRenewalInfo);
        console.log("🔄 Processing notification:", {
            type: notificationType,
            txInfo,
            renewalInfo,
        });
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
        }
        res.status(200).json({ status: "success" });
    }
    catch (error) {
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
