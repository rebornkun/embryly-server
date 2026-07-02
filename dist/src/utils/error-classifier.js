/**
 * Classify errors as retryable (transient) or non-retryable (permanent)
 
 * Retryable errors are typically:
 * - Database connection issues
 * - Network timeouts
 * - Temporary service unavailability
 *
 * Non-retryable errors are typically:
 * - Invalid data/missing required fields
 * - Business logic errors
 * - Authentication/authorization failures
 * - Data validation errors
 */
export function isRetryableError(error) {
    const errorMessage = error?.message?.toLowerCase() || "";
    const errorCode = error?.code?.toLowerCase() || "";
    // Database connection/timeout errors (retryable)
    if (errorMessage.includes("connection") ||
        errorMessage.includes("timeout") ||
        errorMessage.includes("econnrefused") ||
        errorMessage.includes("enotfound") ||
        errorMessage.includes("etimedout") ||
        errorCode.includes("timeout") ||
        errorCode.includes("connection")) {
        return true;
    }
    // Supabase specific retryable errors
    if (errorCode === "pgrst116" || // Not found (might be transient)
        errorMessage.includes("network") ||
        errorMessage.includes("fetch")) {
        // PGRST116 is "not found" - usually not retryable, but context matters
        // For now, we'll consider network/fetch errors retryable
        return errorMessage.includes("network") || errorMessage.includes("fetch");
    }
    // Permanent errors (non-retryable)
    if (errorMessage.includes("missing") ||
        errorMessage.includes("invalid") ||
        errorMessage.includes("not found") ||
        errorMessage.includes("duplicate") ||
        errorMessage.includes("already exists") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("forbidden") ||
        errorMessage.includes("validation")) {
        return false;
    }
    // Default: assume non-retryable for safety
    // It's safer to log and manually review than risk duplicate processing
    return false;
}
/**
 * Get error classification details
 */
export function classifyError(error) {
    const isRetryable = isRetryableError(error);
    return {
        isRetryable,
        category: isRetryable ? "transient" : "permanent",
        reason: isRetryable
            ? "Transient error - may succeed on retry"
            : "Permanent error - requires manual review",
    };
}
