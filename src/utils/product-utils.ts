/**
 * Product configuration mapping
 * Maps product IDs to subscription plans
 */
interface ProductConfig {
  planKey: string;
  type: "subscription";
}

// Exact product ID mappings (add your actual product IDs here)
const PRODUCT_MAP: Record<string, ProductConfig> = {
  // Weekly subscription
  embrylyproweekly: {
    planKey: "weekly",
    type: "subscription",
  },
  // Weekly intro offer
  embrylyproweeklyintro: {
    planKey: "weekly",
    type: "subscription",
  },
  // Monthly subscription
  embrylypromonthly: {
    planKey: "monthly",
    type: "subscription",
  },
  // Yearly subscription
  embrylyproyearly: {
    planKey: "yearly",
    type: "subscription",
  },
  // Yearly free trial
  embrylyproyearlytrial: {
    planKey: "yearly",
    type: "subscription",
  },
};

/**
 * Fallback patterns for product ID matching
 * Used when exact product ID is not in PRODUCT_MAP
 */
const SUBSCRIPTION_PATTERNS = [
  { pattern: /\bweekly\b/i, planKey: "weekly" },
  { pattern: /\bmonthly\b/i, planKey: "monthly" },
  { pattern: /\byearly\b/i, planKey: "yearly" },
  { pattern: /\bannual\b/i, planKey: "yearly" },
];

/**
 * Get plan key from product ID
 */
export function getPlanKeyFromProductId(productId: string): string {
  // Try exact match first
  const exactMatch = PRODUCT_MAP[productId];
  if (exactMatch) {
    return exactMatch.planKey;
  }

  // Fallback to pattern matching with word boundaries
  for (const { pattern, planKey } of SUBSCRIPTION_PATTERNS) {
    if (pattern.test(productId)) {
      return planKey;
    }
  }

  console.warn(`⚠️ Unknown product ID: ${productId} - returning "unknown"`);
  return "unknown";
}

/**
 * Check if a product is valid subscription
 */
export function isValidSubscription(productId: string): boolean {
  // Try exact match first
  const exactMatch = PRODUCT_MAP[productId];
  if (exactMatch) {
    return exactMatch.type === "subscription";
  }

  // Fallback: Check if it matches subscription patterns
  for (const { pattern } of SUBSCRIPTION_PATTERNS) {
    if (pattern.test(productId)) {
      return true;
    }
  }

  return false;
}
