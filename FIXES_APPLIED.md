> ⚠️ **Outdated:** This document was written when the app used a page/quota
> system (`page_limit` / `pages_used`) and Lovla branding. That quota system
> has since been **removed** (Embryly has no page limits) and the app was
> rebranded to Embryly. Treat the page/quota details below as historical only.

# Fixes Applied to Restore Purchase Flow

## Issues Found & Fixed

### ❌ Issue 1: No Expiration Check
**Problem**: Restore purchase didn't validate if subscription was still active

**Fix**: Added expiration check in `/restore-purchase`
```typescript
// Check if subscription is expired
const now = new Date();
const expiresDate = new Date(txInfo.expiresDate);

if (expiresDate < now) {
  return res.status(410).json({
    success: false,
    code: "SUBSCRIPTION_EXPIRED",
    message: "This subscription has expired",
    expiresDate: txInfo.expiresDate,
  });
}
```

**Location**: `src/routes/validate-purchase.ts` line ~442

---

### ❌ Issue 2: Granted Fresh Quota on Transfer
**Problem**: `transferSubscription()` called `grantSubscriptionPages()` which gave the new user fresh quota, even though they're taking over an existing subscription period

**Fix**: 
1. Preserved `pages_used` from old subscription
2. Removed `grantSubscriptionPages()` call
3. Used DELETE + INSERT instead of UPDATE (since `user_id` is primary key)

**Before**:
```typescript
// Update subscription to new user
await supabase.from("user_subscriptions").update({
  user_id: toUserId, // Can't change primary key!
  // ...
});

// Grant NEW pages (wrong!)
await grantSubscriptionPages(toUserId, ...);
```

**After**:
```typescript
// Get current usage
const { data: currentSub } = await supabase
  .from("user_subscriptions")
  .select("pages_used, last_granted_at")
  .eq("original_transaction_id", txInfo.originalTransactionId)
  .single();

// Delete old record
await supabase.from("user_subscriptions")
  .delete()
  .eq("user_id", fromUserId);

// Create new record with preserved usage
await supabase.from("user_subscriptions").insert({
  user_id: toUserId,
  pages_used: currentSub.pages_used, // Preserve!
  last_granted_at: currentSub.last_granted_at, // Preserve!
  // ...
});

// DO NOT call grantSubscriptionPages()
```

**Location**: `src/routes/validate-purchase.ts` `transferSubscription()` function

---

### 🚨 Issue 3.5: Duplicate Check Blocked Transfers (CRITICAL!)
**Problem**: 
- Both `processTransaction()` and `processTransactionForRestore()` checked if transaction was already processed
- Check looked for ANY existing event with that transactionId
- Didn't check if event belonged to current user
- **This completely blocked transfers!**

**Example**:
```typescript
// User A subscribes
subscription_events: [
  { user_id: "user_a_id", transactionId: "123" }
]

// User B tries to restore (transfer)
const existingEvent = await checkIfProcessed("123"); // Finds User A's event!
if (existingEvent) {
  return "already processed"; // ❌ BLOCKS TRANSFER!
}
```

**Fix**: Check if transaction processed FOR CURRENT USER only

**Before**:
```typescript
const { data: existingEvent } = await supabase
  .from("subscription_events")
  .select("id")
  .eq("provider", "apple")
  .or(`raw_payload->>transactionId.eq.${txInfo.transactionId}...`)
  .single();

if (existingEvent) {
  return "already processed"; // ❌ Blocks transfer
}
```

**After**:
```typescript
const { data: existingEvent } = await supabase
  .from("subscription_events")
  .select("id, user_id")
  .eq("provider", "apple")
  .eq("user_id", actualUserId) // ✅ Only check current user
  .or(`raw_payload->>transactionId.eq.${txInfo.transactionId}...`)
  .single();

if (existingEvent) {
  return "already processed"; // ✅ Only blocks if THIS user already processed it
}
```

**Location**: 
- `src/routes/validate-purchase.ts` `processTransaction()` function (line ~233)
- `src/routes/validate-purchase.ts` `processTransactionForRestore()` function (line ~538)

---

### ⚠️ Issue 4: Renewals Would Break After Transfer
**Problem**: 
- Apple's renewal webhooks contain the **original** `appAccountToken` (never changes)
- After transfer, we update `app_account_token` in DB to new user
- `getUserIdFromTransaction()` checked `appAccountToken` FIRST
- This would apply renewals to the **original owner** instead of **current owner**

**Fix**: Changed priority order in `getUserIdFromTransaction()`

**Before**:
```typescript
// Priority 1: appAccountToken (from webhook - never changes)
if (transactionInfo.appAccountToken) {
  return transactionInfo.appAccountToken; // Returns original owner!
}

// Priority 2: originalTransactionId lookup
// (never reached if appAccountToken exists)
```

**After**:
```typescript
// Priority 1: originalTransactionId lookup (source of truth)
if (transactionInfo.originalTransactionId) {
  const { data: subscription } = await supabase
    .from("user_subscriptions")
    .select("user_id")
    .eq("original_transaction_id", transactionInfo.originalTransactionId)
    .single();
  
  if (subscription) {
    return subscription.user_id; // Returns CURRENT owner!
  }
}

// Priority 2: appAccountToken (fallback for new subscriptions)
if (transactionInfo.appAccountToken) {
  return transactionInfo.appAccountToken;
}
```

**Location**: `src/utils/user-lookup.ts` `getUserIdFromTransaction()` function

---

## Summary of Changes

### Files Modified:

1. **`src/routes/validate-purchase.ts`**
   - Added expiration check in `/restore-purchase`
   - Modified `transferSubscription()` to preserve `pages_used`
   - Changed from UPDATE to DELETE + INSERT pattern
   - Removed `grantSubscriptionPages()` call from transfer
   - Modified `processTransactionForRestore()` to conditionally grant pages:
     - ✅ Grant if new subscription (first time linking)
     - ✅ Grant if new period (last_granted_at < purchaseDate)
     - ❌ Don't grant if same period (preserve existing usage)
   - **CRITICAL FIX**: Fixed duplicate transaction check to be user-specific:
     - ✅ Only blocks if transaction already processed FOR CURRENT USER
     - ✅ Allows transfer if transaction processed for DIFFERENT USER

2. **`src/utils/user-lookup.ts`**
   - Reordered priority: `originalTransactionId` lookup BEFORE `appAccountToken`
   - Added transfer detection logging
   - Updated documentation comments

3. **`SUBSCRIPTION_TRANSFER_FLOW.md`**
   - Added "Quota Preservation" section
   - Added "How Renewals Work After Transfer" section
   - Added comprehensive testing scenarios

---

## When Pages Are Granted

### `processTransactionForRestore()` Logic:

```typescript
// Check if user already has subscription
const existingSub = await getExistingSubscription(userId);

const shouldGrantPages = 
  !existingSub ||  // New subscription
  (existingSub.last_granted_at < txInfo.purchaseDate); // New period

if (shouldGrantPages) {
  await grantSubscriptionPages(...); // Grant fresh quota
} else {
  // Preserve existing pages_used (same period restore)
}
```

### Examples:

**Case 1: New Subscription (First Time Restore)**
```
User A restores for first time
├─ No existing subscription in DB
├─ shouldGrantPages = true
└─ Grant 100 pages ✅
```

**Case 2: Same User, Same Period (Re-restore)**
```
User A subscribed on Jan 1 (used 30 pages)
User A logs out and back in on Jan 15
User A restores
├─ Existing subscription found
├─ last_granted_at = Jan 1
├─ txInfo.purchaseDate = Jan 1 (same)
├─ shouldGrantPages = false
└─ Preserve 30 pages used ✅
```

**Case 3: Renewal Period (New Period Restore)**
```
User A subscribed on Jan 1
Subscription renewed on Feb 1
User A restores on Feb 5
├─ Existing subscription found
├─ last_granted_at = Jan 1
├─ txInfo.purchaseDate = Feb 1 (newer)
├─ shouldGrantPages = true
└─ Grant fresh 100 pages ✅
```

## How It Works Now

### Scenario: User A → User B Transfer + Renewal

```
Day 1: User A subscribes
├─ Subscription created
│  ├─ user_id: "user_a_id"
│  ├─ app_account_token: "user_a_id"
│  ├─ pages_used: 0
│  └─ page_limit: 100
├─ User A uses 30 pages
│  └─ pages_used: 30

Day 15: Transfer to User B
├─ User B restores purchase
├─ Server detects: subscription belongs to User A
├─ User B confirms transfer
├─ Server executes transfer:
│  ├─ DELETE old record (user_id: "user_a_id")
│  └─ INSERT new record:
│     ├─ user_id: "user_b_id"
│     ├─ app_account_token: "user_b_id" (updated!)
│     ├─ pages_used: 30 (preserved!)
│     └─ page_limit: 100
├─ Result: User B has 70 pages remaining

Day 30: Subscription renews
├─ Apple sends webhook
│  └─ appAccountToken: "user_a_id" (original, never changes)
├─ getUserIdFromTransaction() called:
│  ├─ Step 1: Lookup by originalTransactionId
│  │  └─ Returns: "user_b_id" (current owner)
│  ├─ Step 2: Detects transfer
│  │  └─ Log: "Subscription was transferred"
│  └─ Returns: "user_b_id"
├─ Renewal applied to User B ✅
│  ├─ pages_used: 0 (reset for new period)
│  └─ page_limit: 100 (fresh quota)
└─ User A gets nothing (correct!)
```

---

## Testing Checklist

- [ ] **Expired Subscription**: Restore returns "SUBSCRIPTION_EXPIRED"
- [ ] **Quota Preservation**: Transfer preserves `pages_used` from old account
- [ ] **No Fresh Quota on Transfer**: New user doesn't get fresh pages
- [ ] **Renewal After Transfer**: Renewal applies to current owner, not original
- [ ] **Transfer Detection**: Logs show "subscription was transferred"
- [ ] **Same User Restore**: Works without transfer prompt
- [ ] **Different User Restore**: Prompts for transfer confirmation

---

## Database Considerations

Make sure your `user_subscriptions` table allows:
- Deleting records by `user_id`
- Inserting new records with same `original_transaction_id`
- `user_id` is PRIMARY KEY
- `original_transaction_id` is UNIQUE

```sql
-- Example schema
CREATE TABLE user_subscriptions (
  user_id TEXT PRIMARY KEY,
  original_transaction_id TEXT UNIQUE NOT NULL,
  app_account_token TEXT,
  pages_used INTEGER DEFAULT 0,
  page_limit INTEGER,
  last_granted_at TIMESTAMP,
  -- ... other fields
);
```

---

## API Response Changes

### `/restore-purchase` - New Error Response

**Expired Subscription**:
```json
{
  "success": false,
  "code": "SUBSCRIPTION_EXPIRED",
  "message": "This subscription has expired",
  "expiresDate": "2024-01-15T10:30:00.000Z"
}
```

### `/restore-purchase` - Transfer Success Response

**After Transfer**:
```json
{
  "success": true,
  "transferred": true,
  "userId": "user_b_id",
  "previousUserId": "user_a_id",
  "pagesUsed": 30,
  "pageLimit": 100,
  "planKey": "premium",
  "subscription": { ... }
}
```

Note the `pagesUsed` field showing preserved usage!
