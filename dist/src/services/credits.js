import { supabase } from "../config/supabase.js";
import { getPlanKeyFromProductId, getPageLimitForProduct, } from "../utils/product-utils.js";
/**
 * Grant subscription pages using database function
 */
export async function grantSubscriptionPages(userId, productId, periodStart, periodEnd) {
    const pageLimit = getPageLimitForProduct(productId);
    const planKey = getPlanKeyFromProductId(productId);
    // Create subscription grant record
    const { data: grantData, error: grantError } = await supabase.rpc("create_subscription_grant", {
        p_user_id: userId,
        p_plan_key: planKey,
        p_pages_granted: pageLimit,
        p_period_start: periodStart.toISOString(),
        p_period_end: periodEnd.toISOString(),
    });
    console.log("🔍 create_subscription_grant data:", grantData);
    console.log("🔍 create_subscription_grant error:", grantError);
    if (grantError) {
        console.error("❌ Error granting subscription pages:", grantError);
        throw new Error(`Failed to grant subscription pages: ${grantError.message}`);
    }
    console.log(`✅ Granted ${pageLimit} pages to user ${userId} for plan ${planKey}`);
}
/**
 * Reset subscription pages when plan expires
 * Sets pages_used back to 0 for new subscription period
 */
export async function resetSubscriptionPages(userId) {
    const { error: updateError } = await supabase
        .from("user_subscriptions")
        .update({ pages_used: 0 })
        .eq("user_id", userId);
    if (updateError) {
        console.error("❌ Error resetting subscription pages:", updateError);
        throw new Error(`Failed to reset subscription pages: ${updateError.message}`);
    }
    console.log(`✅ Reset subscription pages (pages_used) to 0 for user ${userId}`);
}
