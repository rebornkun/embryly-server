import { Router } from "express";
import { verifier, bundleId, environment } from "../config/apple.js";
import { supabase } from "../config/supabase.js";
import { getPlanKeyFromProductId, isValidSubscription, } from "../utils/product-utils.js";
import { AppStoreServerAPIClient, Order, ProductType, GetTransactionHistoryVersion, ReceiptUtility, } from "@apple/app-store-server-library";
import fs from "fs";
const router = Router();
// Initialize API client for validate-purchase
let apiClient = null;
try {
    const issuerId = process.env.APPLE_ISSUER_ID;
    const keyId = process.env.APPLE_KEY_ID;
    if (!issuerId || !keyId) {
        console.log("⚠️ Missing APPLE_ISSUER_ID or APPLE_KEY_ID - API client disabled");
    }
    else {
        let encodedKey = null;
        // Try environment variable first (for Vercel/production)
        if (process.env.APPLE_PRIVATE_KEY) {
            encodedKey = process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n");
            console.log("✅ Using private key from environment variable");
        }
        // Fall back to file (for local development)
        else {
            const privateKeyPath = process.env.APPLE_PRIVATE_KEY_PATH || "./certs/SubscriptionKey.p8";
            if (fs.existsSync(privateKeyPath)) {
                encodedKey = fs.readFileSync(privateKeyPath, "utf-8");
                console.log("✅ Using private key from file:", privateKeyPath);
            }
        }
        if (encodedKey) {
            apiClient = new AppStoreServerAPIClient(encodedKey, keyId, issuerId, bundleId, environment);
            console.log("✅ API Client initialized for validate-purchase");
        }
        else {
            console.log("⚠️ No private key found - API client disabled");
        }
    }
}
catch (error) {
    console.log("⚠️ API client initialization failed:", error.message);
}
/**
 * Validate and process a purchase from the app
 * Uses AppStoreServerAPIClient to fetch transaction history
 */
router.post("/validate-purchase", async (req, res) => {
    try {
        const { appReceipt, signedTransaction, userId } = req.body;
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Missing userId",
            });
        }
        // Prefer appReceipt + API client approach
        if (appReceipt && apiClient) {
            console.log("🔍 Using transaction history API for user:", userId);
            // Extract transaction ID from app receipt
            const receiptUtil = new ReceiptUtility();
            const transactionId = receiptUtil.extractTransactionIdFromAppReceipt(appReceipt);
            if (!transactionId) {
                return res.status(400).json({
                    success: false,
                    message: "Could not extract transaction ID from receipt",
                });
            }
            console.log("📜 Fetching transaction history for:", transactionId);
            // Fetch all auto-renewable subscription transactions
            const transactionHistoryRequest = {
                sort: Order.DESCENDING,
                revoked: false,
                productTypes: [ProductType.AUTO_RENEWABLE],
            };
            let allTransactions = [];
            let response = await apiClient.getTransactionHistory(transactionId, null, transactionHistoryRequest, GetTransactionHistoryVersion.V2);
            if (response.signedTransactions) {
                allTransactions = allTransactions.concat(response.signedTransactions);
            }
            // Fetch additional pages if needed
            while (response.hasMore) {
                response = await apiClient.getTransactionHistory(transactionId, response.revision || null, transactionHistoryRequest, GetTransactionHistoryVersion.V2);
                if (response.signedTransactions) {
                    allTransactions = allTransactions.concat(response.signedTransactions);
                }
            }
            console.log(`📊 Found ${allTransactions.length} transactions`);
            if (allTransactions.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "No active subscriptions found",
                });
            }
            // Decode the most recent transaction (first in DESCENDING order)
            if (!verifier) {
                return res.status(500).json({
                    success: false,
                    message: "Verifier not configured",
                });
            }
            const txInfo = await verifier.verifyAndDecodeTransaction(allTransactions[0]);
            if (!txInfo) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid transaction",
                });
            }
            // Continue with existing validation logic...
            console.log("✅ Transaction verified:", {
                transactionId: txInfo.transactionId,
                productId: txInfo.productId,
                appAccountToken: txInfo.appAccountToken,
            });
            // Use txInfo for the rest of the flow
            return await processTransaction(txInfo, userId, res);
        }
        // Fallback: use single signed transaction if provided
        if (signedTransaction && verifier) {
            console.log("🔍 Using single transaction verification for user:", userId);
            const txInfo = await verifier.verifyAndDecodeTransaction(signedTransaction);
            if (!txInfo) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid transaction",
                });
            }
            return await processTransaction(txInfo, userId, res);
        }
        return res.status(400).json({
            success: false,
            message: "Missing appReceipt or signedTransaction",
        });
    }
    catch (error) {
        console.error("❌ Error validating purchase:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Validation failed",
        });
    }
});
/**
 * Process a validated transaction
 */
async function processTransaction(txInfo, userId, res) {
    try {
        // Check if the purchase belongs to a different account
        // appAccountToken is set at purchase time and identifies who initiated the purchase
        // if (txInfo.appAccountToken && txInfo.appAccountToken !== userId) {
        //   console.warn("⚠️ Purchase belongs to different account:", {
        //     currentUserId: userId,
        //     purchaseOwnerId: txInfo.appAccountToken,
        //   });
        //   // Don't auto-apply to wrong account - guide user instead
        //   return res.status(400).json({
        //     success: false,
        //     code: "ACCOUNT_MISMATCH",
        //     message: "This purchase belongs to a different account",
        //     hint: "Please sign in with the account that made this purchase, or use 'Restore Purchases'",
        //     purchaseOwnerId: txInfo.appAccountToken, // So app can show which account
        //   });
        // }
        console.log("🔍 txInfo:", txInfo);
        // Use the userId from request (should match appAccountToken if set)
        const actualUserId = userId;
        // ✅ ADD THIS: Check transaction state
        if (txInfo.transactionReason &&
            (txInfo.transactionReason !== "PURCHASE" ||
                txInfo.transactionReason !== "PURCHASED")) {
            console.log("⏭️ Skipping non-purchased transaction:", {
                transactionId: txInfo.transactionId,
                state: txInfo.transactionReason,
                userId: actualUserId,
            });
            return res.json({
                success: true,
                skipped: true,
                message: `Transaction not completed (state: ${txInfo.transactionReason})`,
            });
        }
        // Check if transaction has already been processed
        // For /validate-purchase: We check ALL users because appAccountToken already validated above
        // If appAccountToken is missing (shouldn't happen), we need global check as safety net
        const { data: existingEvent, error: checkError } = await supabase
            .from("subscription_events")
            .select("id, user_id")
            .eq("provider", "apple")
            .or(`raw_payload->>transactionId.eq.${txInfo.transactionId},raw_payload->transactionInfo->>transactionId.eq.${txInfo.transactionId}`)
            .single();
        if (checkError && checkError.code !== "PGRST116") {
            console.error("❌ Error checking existing transaction:", checkError);
            return res.status(500).json({
                success: false,
                message: "Failed to check transaction status",
            });
        }
        if (existingEvent) {
            console.log("⚠️ Transaction already processed for this user:", txInfo.transactionId);
            // Return success but indicate it was already processed
            const subscriptionInfo = await getSubscriptionInfo(actualUserId);
            return res.json({
                success: true,
                alreadyProcessed: true,
                message: "Transaction already processed",
                userId: actualUserId,
                subscription: subscriptionInfo,
            });
        }
        // Check if this subscription (by original_transaction_id) is already linked to a DIFFERENT user
        const { data: existingSub, error: subCheckError } = await supabase
            .from("user_subscriptions")
            .select("user_id, status, period_end") // ✅ CHANGED: Added status and period_end
            .eq("original_transaction_id", txInfo.originalTransactionId)
            .single();
        if (subCheckError && subCheckError.code !== "PGRST116") {
            console.error("❌ Error checking existing subscription:", subCheckError);
        }
        if (existingSub && existingSub.user_id !== actualUserId) {
            // ✅ NEW: Check if subscription is still active
            const isExpired = new Date(existingSub.period_end) < new Date();
            const isActive = (existingSub.status === "active" ||
                existingSub.status === "free_trial") &&
                !isExpired;
            if (isActive) {
                // Only block if subscription is ACTIVE
                console.warn("⚠️ Active subscription linked to different account:", {
                    currentUserId: actualUserId,
                    existingOwnerId: existingSub.user_id,
                    originalTransactionId: txInfo.originalTransactionId,
                    status: existingSub.status,
                    periodEnd: existingSub.period_end,
                });
                return res.status(403).json({
                    success: false,
                    blockedByOtherAccount: true,
                    code: "SUBSCRIPTION_LINKED_TO_OTHER_ACCOUNT",
                    message: "This subscription is linked to another Embryly account. Please log in to that account to access your subscription.",
                });
            }
            // ✅ If expired, delete the old record to avoid unique constraint conflict
            if (isExpired) {
                console.log("🗑️ Deleting expired subscription record for new purchase:", {
                    expiredUserId: existingSub.user_id,
                    newUserId: actualUserId,
                    originalTransactionId: txInfo.originalTransactionId,
                    expiredAt: existingSub.period_end,
                });
                const { error: deleteError } = await supabase
                    .from("user_subscriptions")
                    .delete()
                    .eq("user_id", existingSub.user_id)
                    .eq("original_transaction_id", txInfo.originalTransactionId);
                if (deleteError) {
                    console.error("❌ Error deleting expired subscription:", deleteError);
                    return res.status(500).json({
                        success: false,
                        message: "Failed to clean up expired subscription",
                    });
                }
                console.log("✅ Expired subscription record deleted");
            }
        }
        // Validate product is a subscription
        if (!isValidSubscription(txInfo.productId)) {
            return res.status(400).json({
                success: false,
                message: "Unknown or invalid product",
            });
        }
        // Process subscription purchase
        const planKey = getPlanKeyFromProductId(txInfo.productId);
        // Create/update subscription
        const subscriptionStatus = getSubscriptionStatus(txInfo);
        const { error: upsertError } = await supabase
            .from("user_subscriptions")
            .upsert({
            user_id: actualUserId,
            provider: "apple",
            plan_key: planKey,
            status: subscriptionStatus,
            product_id: txInfo.productId,
            entitlement_key: null,
            auto_renew: true,
            period_start: new Date(txInfo.purchaseDate).toISOString(),
            period_end: new Date(txInfo.expiresDate).toISOString(),
            last_granted_at: new Date(txInfo.purchaseDate).toISOString(),
            transaction_id: txInfo.transactionId,
            original_transaction_id: txInfo.originalTransactionId,
            app_account_token: actualUserId,
            retry_count: 0,
            last_payment_attempt: null,
            expired_at: null,
        }, { onConflict: "user_id" });
        if (upsertError) {
            console.error("❌ Error creating subscription:", upsertError);
            return res.status(500).json({
                success: false,
                message: "Failed to create subscription",
            });
        }
        // Create subscription event
        const { error: insertError } = await supabase
            .from("subscription_events")
            .insert({
            user_id: actualUserId,
            provider: "apple",
            event_type: "purchase",
            plan_key: planKey,
            product_id: txInfo.productId,
            entitlement_key: null,
            period_start: new Date(txInfo.purchaseDate).toISOString(),
            period_end: new Date(txInfo.expiresDate).toISOString(),
            auto_renew: true,
            raw_payload: {
                transactionInfo: txInfo,
                source: "app_validation",
                requestedUserId: userId,
            },
        });
        if (insertError) {
            console.error("❌ Error creating subscription event:", insertError);
        }
        // Get subscription info
        const subscriptionInfo = await getSubscriptionInfo(actualUserId);
        console.log(`✅ Subscription purchase processed: ${planKey} for user ${actualUserId}`);
        return res.json({
            success: true,
            type: "subscription",
            userId: actualUserId,
            planKey,
            productId: txInfo.productId,
            transactionId: txInfo.transactionId,
            expiresDate: txInfo.expiresDate,
            subscription: subscriptionInfo,
        });
    }
    catch (error) {
        console.error("❌ Error processing transaction:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Transaction processing failed",
        });
    }
}
/**
 * Determine subscription status from transaction info
 */
function getSubscriptionStatus(txInfo) {
    // Check if it's a free trial
    if (txInfo?.offerDiscountType === "FREE_TRIAL") {
        return "free_trial";
    }
    // Check if subscription is in grace period
    // (Apple gives grace period for billing issues)
    if (txInfo?.isInBillingRetryPeriod) {
        return "grace_period";
    }
    // Default to active
    return "active";
}
/**
 * Get user subscription info
 */
async function getSubscriptionInfo(userId) {
    const { data, error } = await supabase.rpc("get_subscription_info", {
        check_user_id: userId,
    });
    if (error) {
        console.error("❌ Error fetching subscription info:", error);
        return {
            has_subscription: false,
        };
    }
    return data || { has_subscription: false };
}
/**
 * Restore purchases for a user
 * Call this when user taps "Restore Purchases"
 *
 * This endpoint handles subscriptions - consumables cannot be restored
 * (they are one-time purchases that are consumed immediately)
 *
 * IMPORTANT: This endpoint allows subscription transfer between accounts
 * based on Apple ID ownership. The appAccountToken check is bypassed here.
 */
router.post("/restore-purchase", async (req, res) => {
    try {
        const { signedTransaction, userId, platform, allowTransfer } = req.body;
        if (!userId || !signedTransaction) {
            return res.status(400).json({
                success: false,
                message: "Missing userId or signedTransaction",
            });
        }
        // Verify the transaction with Apple
        const txInfo = await verifier.verifyAndDecodeTransaction(signedTransaction);
        console.log("🔍 Apple transaction info from restore:", txInfo);
        if (!txInfo) {
            return res
                .status(400)
                .json({ success: false, message: "Invalid transaction" });
        }
        // Check if subscription is expired
        const now = new Date();
        const expiresDate = new Date(txInfo.expiresDate);
        if (expiresDate < now) {
            return res.status(404).json({
                success: false,
                code: "NO_ACTIVE_SUBSCRIPTION",
                message: "No active subscription found",
                hint: "Subscribe to access premium features",
                expiresDate: txInfo.expiresDate,
            });
        }
        // Check if this subscription is already linked to a DIFFERENT user
        const { data: existingSub } = await supabase
            .from("user_subscriptions")
            .select("user_id, status, last_granted_at")
            .eq("original_transaction_id", txInfo.originalTransactionId)
            .single();
        if (existingSub && existingSub.user_id !== userId) {
            // Subscription belongs to another account
            if (!allowTransfer) {
                // First call - inform user about the conflict
                return res.status(409).json({
                    success: false,
                    requiresTransferConfirmation: true,
                    code: "SUBSCRIPTION_LINKED_TO_OTHER_ACCOUNT",
                    message: "This subscription is linked to another Embryly account.",
                    hint: "Do you want to transfer this subscription to your current account?",
                    previousUserId: existingSub.user_id,
                    currentUserId: userId,
                });
            }
            // User confirmed transfer - proceed with transfer
            console.log("🔄 Transferring subscription:", {
                from: existingSub.user_id,
                to: userId,
                originalTransactionId: txInfo.originalTransactionId,
            });
            // Transfer subscription to new user
            return await transferSubscription(txInfo, existingSub.user_id, userId, res);
        }
        // If subscription already exists for this user, just return it
        if (existingSub && existingSub.user_id === userId) {
            console.log("✅ Subscription already exists for this user:", {
                userId,
                originalTransactionId: txInfo.originalTransactionId,
            });
            const subscriptionInfo = await getSubscriptionInfo(userId);
            return res.json({
                success: true,
                alreadyRestored: true,
                message: "Subscription already restored",
                userId,
                subscription: subscriptionInfo,
            });
        }
        // No existing record - proceed with linking
        // Skip appAccountToken check for restore flow
        return await processTransactionForRestore(txInfo, userId, res);
    }
    catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});
/**
 * Process transaction for restore flow (bypasses appAccountToken check)
 */
async function processTransactionForRestore(txInfo, userId, res) {
    try {
        // Skip appAccountToken validation for restore flow
        // Use originalTransactionId ownership from database instead
        const actualUserId = userId;
        // Check if transaction has already been processed FOR THIS USER
        // Important: Don't block if processed for different user (allows transfers)
        const { data: existingEvent, error: checkError } = await supabase
            .from("subscription_events")
            .select("id, user_id")
            .eq("provider", "apple")
            .eq("user_id", actualUserId) // Only check for current user
            .or(`raw_payload->>transactionId.eq.${txInfo.transactionId},raw_payload->transactionInfo->>transactionId.eq.${txInfo.transactionId}`)
            .single();
        if (checkError && checkError.code !== "PGRST116") {
            console.error("❌ Error checking existing transaction:", checkError);
            return res.status(500).json({
                success: false,
                message: "Failed to check transaction status",
            });
        }
        if (existingEvent) {
            console.log("⚠️ Transaction already processed for this user:", txInfo.transactionId);
            const subscriptionInfo = await getSubscriptionInfo(actualUserId);
            return res.json({
                success: true,
                alreadyProcessed: true,
                message: "Transaction already processed",
                userId: actualUserId,
                subscription: subscriptionInfo,
            });
        }
        // Validate product is a subscription
        if (!isValidSubscription(txInfo.productId)) {
            return res.status(400).json({
                success: false,
                message: "Unknown or invalid product",
            });
        }
        // Process subscription purchase
        const planKey = getPlanKeyFromProductId(txInfo.productId);
        // Create/update subscription
        const subscriptionStatus = getSubscriptionStatus(txInfo);
        const { error: upsertError } = await supabase
            .from("user_subscriptions")
            .upsert({
            user_id: actualUserId,
            provider: "apple",
            plan_key: planKey,
            status: subscriptionStatus,
            product_id: txInfo.productId,
            entitlement_key: null,
            auto_renew: true,
            period_start: new Date(txInfo.purchaseDate).toISOString(),
            period_end: new Date(txInfo.expiresDate).toISOString(),
            last_granted_at: new Date(txInfo.purchaseDate).toISOString(),
            transaction_id: txInfo.transactionId,
            original_transaction_id: txInfo.originalTransactionId,
            app_account_token: actualUserId, // Update to current user
            retry_count: 0,
            last_payment_attempt: null,
            expired_at: null,
        }, { onConflict: "user_id" });
        if (upsertError) {
            console.error("❌ Error creating subscription:", upsertError);
            return res.status(500).json({
                success: false,
                message: "Failed to create subscription",
            });
        }
        // Create subscription event
        const { error: insertError } = await supabase
            .from("subscription_events")
            .insert({
            user_id: actualUserId,
            provider: "apple",
            event_type: "purchase", // Use "purchase" not "restore" (DB constraint)
            plan_key: planKey,
            product_id: txInfo.productId,
            entitlement_key: null,
            period_start: new Date(txInfo.purchaseDate).toISOString(),
            period_end: new Date(txInfo.expiresDate).toISOString(),
            auto_renew: true,
            raw_payload: {
                transactionInfo: txInfo,
                source: "restore_purchase", // Source indicates it's a restore
            },
        });
        if (insertError) {
            console.error("❌ Error creating subscription event:", insertError);
        }
        const subscriptionInfo = await getSubscriptionInfo(actualUserId);
        console.log(`✅ Subscription restored: ${planKey} for user ${actualUserId}`);
        return res.json({
            success: true,
            type: "subscription",
            userId: actualUserId,
            planKey,
            productId: txInfo.productId,
            transactionId: txInfo.transactionId,
            expiresDate: txInfo.expiresDate,
            subscription: subscriptionInfo,
        });
    }
    catch (error) {
        console.error("❌ Error processing restore transaction:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Restore processing failed",
        });
    }
}
/**
 * Transfer subscription from one user to another
 */
async function transferSubscription(txInfo, fromUserId, toUserId, res) {
    try {
        console.log("🔄 Starting subscription transfer:", {
            from: fromUserId,
            to: toUserId,
            originalTransactionId: txInfo.originalTransactionId,
        });
        const planKey = getPlanKeyFromProductId(txInfo.productId);
        // Get current subscription data
        const { data: currentSub, error: fetchError } = await supabase
            .from("user_subscriptions")
            .select("last_granted_at, user_id")
            .eq("original_transaction_id", txInfo.originalTransactionId)
            .single();
        if (fetchError && fetchError.code !== "PGRST116") {
            // PGRST116 = not found, which is OK for new subscriptions
            console.error("❌ Error fetching current subscription:", fetchError);
            return res.status(500).json({
                success: false,
                message: "Failed to fetch subscription data",
            });
        }
        // Verify the subscription belongs to fromUserId
        if (currentSub && currentSub.user_id !== fromUserId) {
            console.error("❌ Subscription doesn't belong to fromUserId:", {
                expected: fromUserId,
                actual: currentSub.user_id,
            });
            return res.status(400).json({
                success: false,
                message: "Subscription ownership mismatch",
            });
        }
        // Delete old subscription record (since user_id is primary key)
        // Use fromUserId to ensure we're deleting the right one
        const { error: deleteError } = await supabase
            .from("user_subscriptions")
            .delete()
            .eq("user_id", fromUserId);
        if (deleteError) {
            console.error("❌ Error deleting old subscription:", deleteError);
            return res.status(500).json({
                success: false,
                message: "Failed to delete old subscription",
            });
        }
        console.log("✅ Deleted old subscription for user:", fromUserId);
        // Check if toUserId already has a subscription (shouldn't happen, but safety check)
        const { data: existingToSub } = await supabase
            .from("user_subscriptions")
            .select("user_id, original_transaction_id")
            .eq("user_id", toUserId)
            .single();
        if (existingToSub) {
            console.warn("⚠️ Target user already has a subscription:", {
                userId: toUserId,
                existingOriginalTransactionId: existingToSub.original_transaction_id,
                newOriginalTransactionId: txInfo.originalTransactionId,
            });
            // If it's the same subscription, just return success
            if (existingToSub.original_transaction_id === txInfo.originalTransactionId) {
                console.log("✅ Subscription already transferred to this user");
                const subscriptionInfo = await getSubscriptionInfo(toUserId);
                return res.json({
                    success: true,
                    transferred: true,
                    alreadyTransferred: true,
                    userId: toUserId,
                    subscription: subscriptionInfo,
                });
            }
            // Different subscription - need to delete old one first
            console.log("🗑️ Deleting old subscription for target user");
            await supabase
                .from("user_subscriptions")
                .delete()
                .eq("user_id", toUserId);
        }
        // Create new subscription record for new user
        const subscriptionStatus = getSubscriptionStatus(txInfo);
        const { error: insertError } = await supabase
            .from("user_subscriptions")
            .insert({
            user_id: toUserId,
            provider: "apple",
            plan_key: planKey,
            status: subscriptionStatus,
            product_id: txInfo.productId,
            entitlement_key: null,
            auto_renew: true,
            period_start: new Date(txInfo.purchaseDate).toISOString(),
            period_end: new Date(txInfo.expiresDate).toISOString(),
            last_granted_at: currentSub?.last_granted_at ||
                new Date(txInfo.purchaseDate).toISOString(),
            transaction_id: txInfo.transactionId,
            original_transaction_id: txInfo.originalTransactionId,
            app_account_token: toUserId, // Update for future renewals
            retry_count: 0,
            last_payment_attempt: null,
            expired_at: null,
        });
        if (insertError) {
            console.error("❌ Error creating new subscription:", insertError);
            return res.status(500).json({
                success: false,
                message: "Failed to transfer subscription",
                error: insertError.message,
            });
        }
        // Log transfer event
        const { error: eventError } = await supabase
            .from("subscription_events")
            .insert({
            user_id: toUserId,
            provider: "apple",
            event_type: "purchase", // Use "purchase" not "transfer" (DB constraint)
            plan_key: planKey,
            product_id: txInfo.productId,
            entitlement_key: null,
            period_start: new Date(txInfo.purchaseDate).toISOString(),
            period_end: new Date(txInfo.expiresDate).toISOString(),
            auto_renew: true,
            raw_payload: {
                transactionInfo: txInfo,
                source: "subscription_transfer", // Source indicates it's a transfer
                fromUserId,
                toUserId,
            },
        });
        if (eventError) {
            console.error("❌ Error logging transfer event:", eventError);
        }
        const subscriptionInfo = await getSubscriptionInfo(toUserId);
        console.log(`✅ Subscription transferred from ${fromUserId} to ${toUserId}`);
        return res.json({
            success: true,
            transferred: true,
            type: "subscription",
            userId: toUserId,
            previousUserId: fromUserId,
            planKey,
            productId: txInfo.productId,
            transactionId: txInfo.transactionId,
            expiresDate: txInfo.expiresDate,
            subscription: subscriptionInfo,
        });
    }
    catch (error) {
        console.error("❌ Error during subscription transfer:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Transfer failed",
        });
    }
}
/**
 * Check if a subscription (by originalTransactionId) exists and who owns it.
 * Used during restore to determine if subscription belongs to current user or another account.
 */
router.post("/check-subscription-ownership", async (req, res) => {
    try {
        const { originalTransactionId, userId } = req.body;
        if (!originalTransactionId || !userId) {
            return res.status(400).json({
                success: false,
                exists: false,
                isOwnedByCurrentUser: false,
                isOwnedByOther: false,
                message: "Missing originalTransactionId or userId",
            });
        }
        // Query subscription by original_transaction_id
        const { data: subscription, error } = await supabase
            .from("user_subscriptions")
            .select("user_id, status")
            .eq("original_transaction_id", originalTransactionId)
            .eq("provider", "apple")
            .order("created_at", { ascending: false }) // Get most recent
            .limit(1)
            .single();
        console.log("🔍 subscription:", subscription);
        console.log("🔍 error:", error);
        if (error || !subscription) {
            // No subscription found - it's new/restorable
            return res.json({
                success: true,
                exists: false,
                isOwnedByCurrentUser: false,
                isOwnedByOther: false,
            });
        }
        const isOwnedByCurrentUser = subscription.user_id === userId;
        return res.json({
            success: true,
            exists: true,
            isOwnedByCurrentUser,
            isOwnedByOther: !isOwnedByCurrentUser,
            ownerId: isOwnedByCurrentUser ? undefined : subscription.user_id,
            status: subscription.status,
        });
    }
    catch (error) {
        console.error("❌ Error checking subscription ownership:", error);
        return res.status(500).json({
            success: false,
            exists: false,
            isOwnedByCurrentUser: false,
            isOwnedByOther: false,
            message: error.message || "Failed to check ownership",
        });
    }
});
export default router;
