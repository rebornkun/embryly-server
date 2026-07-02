import { Router } from "express";
import { verifier } from "../config/apple.js";
import { supabase } from "../config/supabase.js";
import { getCreditsForProduct } from "../utils/product-utils.js";
import { creditWalletForConsumable } from "../services/credits.js";
const router = Router();
router.post("/verify-consumable", async (req, res) => {
    try {
        // React Native IAP v12.13.0 provides:
        // - transactionId: unique transaction identifier
        // - productId: product identifier
        // - transactionDate: purchase timestamp (milliseconds)
        // - transactionReceipt: app receipt (base64) - NOT a transaction JWT
        // Note: transactionReceipt in v12 is the full app receipt, not a signed transaction
        // For verification, we use transactionId for duplicate prevention
        // Apple will send ONE_TIME_CHARGE webhook which provides full verification
        const { signedTransactionInfo, // Not available in v12, but included for future compatibility
        userId, productId, transactionId, transactionDate, transactionReceipt, // Store for reference but not used for verification in v12
         } = req.body;
        if (!userId || !productId || !transactionId) {
            return res.status(400).json({
                error: "Missing required fields",
                required: ["userId", "productId", "transactionId"],
                note: "transactionDate and transactionReceipt are optional",
                version: "React Native IAP v12.13.0",
            });
        }
        console.log("🛒 Verifying consumable purchase (RN IAP v12):", {
            userId,
            productId,
            transactionId,
            transactionDate,
            hasTransactionReceipt: !!transactionReceipt,
            hasSignedTransactionInfo: !!signedTransactionInfo,
        });
        let verifiedTransactionInfo = null;
        // Try to verify if signedTransactionInfo is provided (newer RN IAP)
        if (signedTransactionInfo && verifier) {
            try {
                console.log("✅ Attempting to verify signedTransactionInfo");
                verifiedTransactionInfo = await verifier.verifyAndDecodeTransaction(signedTransactionInfo);
                // Verify product ID matches
                if (verifiedTransactionInfo.productId !== productId) {
                    return res.status(400).json({
                        error: "Product ID mismatch",
                        received: productId,
                        verified: verifiedTransactionInfo.productId,
                    });
                }
                // Verify transaction ID matches
                if (verifiedTransactionInfo.transactionId !== transactionId) {
                    return res.status(400).json({
                        error: "Transaction ID mismatch",
                        received: transactionId,
                        verified: verifiedTransactionInfo.transactionId,
                    });
                }
                console.log("✅ Transaction verified with signedTransactionInfo");
            }
            catch (verifyError) {
                console.warn("⚠️ Could not verify signedTransactionInfo:", verifyError.message);
                // Continue without verification - will rely on webhook verification
            }
        }
        // Check if transaction has already been processed (using subscription_events)
        const { data: existingEvent } = await supabase
            .from("subscription_events")
            .select("id")
            .eq("provider", "apple")
            .eq("event_type", "consumable_purchase")
            .eq("raw_payload->>transactionId", transactionId)
            .single();
        if (existingEvent) {
            return res.status(409).json({
                error: "Transaction already processed",
                transactionId: transactionId,
                message: "This consumable has already been granted",
            });
        }
        // Get credits for this consumable product
        const credits = getCreditsForProduct(productId);
        // Parse transaction date (from React Native IAP timestamp in milliseconds)
        const purchaseDate = transactionDate
            ? new Date(transactionDate)
            : new Date();
        // Credit wallet using credit_wallet RPC (type='topup' for rollover behavior)
        await creditWalletForConsumable(userId, credits, transactionId, transactionId, // For consumables, originalTransactionId is same as transactionId
        productId, purchaseDate);
        // Create purchase event to track the transaction
        // Note: Apple will send ONE_TIME_CHARGE webhook which will also process this
        // This creates a record immediately for better UX
        await supabase.from("subscription_events").insert({
            user_id: userId,
            provider: "apple",
            event_type: "consumable_purchase",
            plan_key: "consumable",
            product_id: productId,
            entitlement_key: "consumable_credits",
            raw_payload: {
                transactionId,
                productId,
                transactionDate: purchaseDate.toISOString(),
                creditsGranted: credits,
                verified: !!verifiedTransactionInfo,
                source: "frontend_verification",
                verifiedTransactionInfo: verifiedTransactionInfo || null,
                // Store transactionReceipt for reference (v12 format)
                transactionReceipt: transactionReceipt || null,
                rnIapVersion: "12.13.0",
            },
        });
        console.log(`✅ Consumable processed: ${credits} credits granted to user ${userId} (transactionId: ${transactionId})`);
        res.status(200).json({
            success: true,
            transactionId: transactionId,
            creditsGranted: credits,
            verified: !!verifiedTransactionInfo,
            message: `Successfully granted ${credits} credits`,
            note: verifiedTransactionInfo
                ? "Transaction verified with Apple"
                : "Transaction will be verified via Apple webhook",
        });
    }
    catch (error) {
        console.error("❌ Error verifying consumable:", error);
        res.status(500).json({
            error: "Failed to verify consumable purchase",
            message: error.message,
        });
    }
});
export default router;
