> ⚠️ **Outdated:** This document was written when the app used a page/quota
> system (`page_limit` / `pages_used`) and Lovla branding. That quota system
> has since been **removed** (Embryly has no page limits) and the app was
> rebranded to Embryly. Treat the page/quota details below as historical only.

# Subscription Transfer Flow

## Overview

This document explains how subscription ownership is validated and how the transfer flow works when users restore purchases.

## Ownership Validation: Two Different Approaches

### 1. `appAccountToken` (Immutable)
- **Set by**: Apple at purchase time
- **Value**: Your app's user ID at the moment of purchase
- **Can change?**: ❌ NO - It's permanently embedded in the transaction
- **Used in**: `/validate-purchase` endpoint (new purchases)

### 2. `originalTransactionId` (Mutable in your DB)
- **Set by**: Apple (unique identifier for the subscription)
- **Value**: Links to `user_id` in your `user_subscriptions` table
- **Can change?**: ✅ YES - You can update which user_id it's linked to
- **Used in**: `/restore-purchase` endpoint (restoring purchases)

## The Problem

When you check **both** `appAccountToken` AND `originalTransactionId`, you create a conflict:

```typescript
// This blocks transfers because appAccountToken never changes
if (txInfo.appAccountToken && txInfo.appAccountToken !== userId) {
  return error("Purchase belongs to different account");
}

// This could allow transfers by updating user_id in DB
if (existingSub && existingSub.user_id !== userId) {
  // But appAccountToken check above already blocked it!
}
```

## The Solution

### For New Purchases (`/validate-purchase`)
✅ **Use `appAccountToken`** - Strict validation
- Prevents account mismatch during purchase
- User must be logged into the correct account

### For Restore Purchases (`/restore-purchase`)
✅ **Use `originalTransactionId` only** - Allow transfers
- Bypasses `appAccountToken` check
- Allows subscription to follow the Apple ID
- Updates `user_id` in database to new user

## Transfer Flow

### Scenario: User A subscribes, logs out, User B restores

1. **User A subscribes**
   - `appAccountToken` = "user_a_id"
   - `originalTransactionId` = "1000000123456789"
   - DB: `user_subscriptions.user_id` = "user_a_id"

2. **User A logs out, User B logs in** (same device/Apple ID)

3. **User B taps "Restore Purchases"**
   - App calls `/restore-purchase` with `userId: "user_b_id"`
   - Server finds subscription linked to "user_a_id"
   - Server returns:
     ```json
     {
       "requiresTransferConfirmation": true,
       "message": "This subscription is linked to another account",
       "hint": "Do you want to transfer this subscription to your current account?"
     }
     ```

4. **User B confirms transfer**
   - App calls `/restore-purchase` again with `allowTransfer: true`
   - Server transfers subscription:
     - Updates `user_subscriptions.user_id` from "user_a_id" to "user_b_id"
     - Updates `user_subscriptions.app_account_token` to "user_b_id"
     - Grants pages to User B
     - Logs transfer event
   - Returns success

5. **Result**
   - User B now owns the subscription
   - User A loses access (subscription follows the Apple ID)

## API Changes

### `/restore-purchase` Endpoint

**New Request Body:**
```typescript
{
  signedTransaction: string;
  userId: string;
  platform?: string;
  allowTransfer?: boolean; // NEW: Set to true to confirm transfer
}
```

**New Response (when transfer needed):**
```typescript
{
  success: false,
  requiresTransferConfirmation: true,
  code: "SUBSCRIPTION_LINKED_TO_OTHER_ACCOUNT",
  message: "This subscription is linked to another Embryly account.",
  hint: "Do you want to transfer this subscription to your current account?",
  previousUserId: "user_a_id",
  currentUserId: "user_b_id"
}
```

**Response (after transfer):**
```typescript
{
  success: true,
  transferred: true,
  userId: "user_b_id",
  previousUserId: "user_a_id",
  planKey: "premium",
  subscription: { ... }
}
```

## App Implementation Example

```typescript
// User taps "Restore Purchases"
async function restorePurchases() {
  const receipt = await getLatestReceipt();
  
  // First attempt
  const response = await fetch('/restore-purchase', {
    method: 'POST',
    body: JSON.stringify({
      signedTransaction: receipt,
      userId: currentUserId,
    })
  });
  
  const data = await response.json();
  
  if (data.requiresTransferConfirmation) {
    // Show alert to user
    const confirmed = await showAlert({
      title: "Transfer Subscription?",
      message: data.message,
      buttons: ["Cancel", "Transfer"]
    });
    
    if (confirmed) {
      // Second attempt with transfer confirmation
      const transferResponse = await fetch('/restore-purchase', {
        method: 'POST',
        body: JSON.stringify({
          signedTransaction: receipt,
          userId: currentUserId,
          allowTransfer: true, // User confirmed
        })
      });
      
      const transferData = await transferResponse.json();
      if (transferData.success) {
        showSuccess("Subscription transferred successfully!");
      }
    }
  } else if (data.success) {
    showSuccess("Subscription restored!");
  }
}
```

## Important Notes

1. **Apple's Perspective**: Apple doesn't care about your app's user accounts. The subscription belongs to the Apple ID. This transfer flow respects that.

2. **Security**: The transfer only happens if:
   - The Apple ID actually owns the subscription (verified by Apple's receipt)
   - The subscription is not expired
   - The user explicitly confirms the transfer (`allowTransfer: true`)

3. **One-Way Transfer**: Once transferred, User A loses access. To prevent abuse, you could:
   - Limit transfers (e.g., once per month)
   - Notify the previous user via email
   - Log all transfers for audit

4. **Quota Preservation**: When transferring, the subscription's `pages_used` is preserved:
   - If User A used 50/100 pages
   - Transfer to User B
   - User B gets 50/100 pages remaining (not a fresh 100)
   - This prevents abuse (transfer to get fresh quota)

5. **Webhooks & Renewals**: 
   - Apple's webhooks contain the **original** `appAccountToken` (never changes)
   - After transfer, we update `app_account_token` in our DB to the new user
   - `getUserIdFromTransaction()` now prioritizes `originalTransactionId` lookup over `appAccountToken`
   - This ensures renewals are applied to the **current owner**, not the original purchaser

6. **Expiration Check**: Restore purchase validates that `expiresDate > now()` before allowing restore/transfer

## Database Schema

Make sure your `user_subscriptions` table has:

```sql
CREATE TABLE user_subscriptions (
  user_id TEXT PRIMARY KEY,           -- Current owner (can change)
  original_transaction_id TEXT UNIQUE, -- Apple's identifier (never changes)
  app_account_token TEXT,             -- Original purchaser (can be updated)
  -- ... other fields
);
```

## How Renewals Work After Transfer

### The Problem
When Apple sends a renewal webhook, it includes the **original** `appAccountToken` from when the subscription was first purchased. If we transferred the subscription to a new user, we need to apply the renewal to the **current owner**, not the original purchaser.

### The Solution

1. **During Transfer**: We update `app_account_token` in the database to the new user
   ```sql
   UPDATE user_subscriptions 
   SET app_account_token = 'user_b_id'
   WHERE original_transaction_id = '1000000123456789'
   ```

2. **During Renewal Webhook**: `getUserIdFromTransaction()` prioritizes database lookup
   ```typescript
   // Step 1: Look up by originalTransactionId (finds current owner)
   const subscription = await db.query(
     "SELECT user_id FROM user_subscriptions WHERE original_transaction_id = ?"
   );
   // Returns: user_b_id (current owner)
   
   // Step 2: Compare with appAccountToken from webhook
   if (transactionInfo.appAccountToken !== subscription.user_id) {
     console.log("Subscription was transferred");
   }
   
   // Step 3: Use subscription.user_id (current owner) for renewal
   await applyRenewal(subscription.user_id); // user_b_id gets the renewal
   ```

3. **Result**: Renewal is applied to User B (current owner), not User A (original purchaser)

### Example Timeline

```
Day 1: User A subscribes
  - appAccountToken in webhook: "user_a_id"
  - DB: user_id = "user_a_id", app_account_token = "user_a_id"
  - Renewal applied to: User A ✅

Day 15: User A transfers to User B
  - DB: user_id = "user_b_id", app_account_token = "user_b_id"
  
Day 30: Subscription renews (Apple sends webhook)
  - appAccountToken in webhook: "user_a_id" (original, never changes)
  - getUserIdFromTransaction() looks up originalTransactionId
  - DB returns: user_id = "user_b_id" (current owner)
  - Renewal applied to: User B ✅ (correct!)
```

## Testing

1. **Test Account Mismatch (Purchase)**:
   - User A subscribes
   - User A logs out
   - User B logs in
   - User B tries to purchase → Should be blocked by `appAccountToken` check

2. **Test Transfer (Restore)**:
   - User A subscribes (gets 100 pages, uses 30)
   - User A logs out
   - User B logs in
   - User B restores → Should prompt for transfer
   - User B confirms → Should transfer successfully with 70 pages remaining

3. **Test Same User Restore**:
   - User A subscribes
   - User A logs out and back in
   - User A restores → Should restore without transfer prompt

4. **Test Expired Subscription Restore**:
   - User A subscribes
   - Wait for subscription to expire
   - User A tries to restore → Should return "SUBSCRIPTION_EXPIRED" error

5. **Test Renewal After Transfer** (Critical!):
   - User A subscribes
   - Transfer to User B
   - Wait for renewal (or simulate webhook)
   - Renewal should apply to User B, not User A
   - Verify: User B gets fresh quota, User A does not

6. **Test Quota Preservation**:
   - User A subscribes (100 pages)
   - User A uses 60 pages (40 remaining)
   - Transfer to User B
   - Verify: User B has 40 pages remaining, not 100
