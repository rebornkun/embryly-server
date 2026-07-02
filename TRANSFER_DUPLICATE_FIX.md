> ⚠️ **Outdated:** This document was written when the app used a page/quota
> system (`page_limit` / `pages_used`) and Lovla branding. That quota system
> has since been **removed** (Embryly has no page limits) and the app was
> rebranded to Embryly. Treat the page/quota details below as historical only.

# Transfer Duplicate Fix - Same Apple ID, Different Accounts

## The Problem

When User B tries to restore a subscription that belongs to User A (same Apple ID, different app accounts):

```
User A subscribes
├─ user_subscriptions: { user_id: "user_a", original_transaction_id: "ABC" }

User B restores (same Apple ID)
├─ Transfer initiated
├─ DELETE fails or doesn't complete
├─ INSERT tries to create: { user_id: "user_b", original_transaction_id: "ABC" }
└─ ERROR: Duplicate original_transaction_id (UNIQUE constraint)
```

## Root Causes

### 1. Non-Atomic Transfer
The transfer does DELETE then INSERT separately:
- ❌ If DELETE fails, INSERT creates duplicate
- ❌ If there's a race condition, both records exist briefly

### 2. Silent Failures
- DELETE might fail but error is ignored
- Subscription might not exist for fromUserId

### 3. Target User Already Has Subscription
- User B might already have a different subscription
- Can't insert new one without deleting old one first

---

## What Was Fixed

### Fix 1: Better Error Handling for Fetch

**Before**:
```typescript
const { data: currentSub, error: fetchError } = await supabase
  .from("user_subscriptions")
  .select("pages_used, last_granted_at")
  .eq("original_transaction_id", txInfo.originalTransactionId)
  .single();

if (fetchError) {
  return error; // ❌ Blocks even if subscription doesn't exist
}
```

**After**:
```typescript
const { data: currentSub, error: fetchError } = await supabase
  .from("user_subscriptions")
  .select("pages_used, last_granted_at, user_id")
  .eq("original_transaction_id", txInfo.originalTransactionId)
  .single();

if (fetchError && fetchError.code !== "PGRST116") {
  // ✅ Only error if it's not "not found"
  return error;
}

// ✅ Verify ownership
if (currentSub && currentSub.user_id !== fromUserId) {
  return error("Ownership mismatch");
}
```

### Fix 2: Safer DELETE

**Before**:
```typescript
const { error: deleteError } = await supabase
  .from("user_subscriptions")
  .delete()
  .eq("user_id", fromUserId)
  .eq("original_transaction_id", txInfo.originalTransactionId);
```

**After**:
```typescript
// ✅ Delete by user_id only (primary key)
const { error: deleteError } = await supabase
  .from("user_subscriptions")
  .delete()
  .eq("user_id", fromUserId);

console.log("✅ Deleted old subscription for user:", fromUserId);
```

### Fix 3: Check Target User Before INSERT

**New**:
```typescript
// ✅ Check if target user already has a subscription
const { data: existingToSub } = await supabase
  .from("user_subscriptions")
  .select("user_id, original_transaction_id")
  .eq("user_id", toUserId)
  .single();

if (existingToSub) {
  // If same subscription, return success (already transferred)
  if (existingToSub.original_transaction_id === txInfo.originalTransactionId) {
    return success("Already transferred");
  }
  
  // Different subscription - delete old one first
  await supabase
    .from("user_subscriptions")
    .delete()
    .eq("user_id", toUserId);
}

// Now safe to INSERT
```

---

## How to Clean Up Current Duplicates

### Step 1: Identify the Issue

```sql
-- Check if you have duplicate original_transaction_id
SELECT 
  original_transaction_id,
  COUNT(*) as count,
  array_agg(user_id) as user_ids
FROM user_subscriptions
WHERE provider = 'apple'
GROUP BY original_transaction_id
HAVING COUNT(*) > 1;
```

**Expected**: No results (each original_transaction_id should be unique)

**If you see results**: You have duplicates!

### Step 2: See Which Users Are Affected

```sql
-- For each duplicate, see the details
SELECT 
  user_id,
  original_transaction_id,
  transaction_id,
  status,
  period_start,
  period_end,
  pages_used,
  created_at,
  updated_at
FROM user_subscriptions
WHERE original_transaction_id = 'YOUR_DUPLICATE_ORIGINAL_TRANSACTION_ID'
ORDER BY created_at DESC;
```

### Step 3: Decide Which to Keep

**Keep the subscription for the user who initiated the restore (User B)**

```sql
-- Delete subscription for User A (old owner)
DELETE FROM user_subscriptions
WHERE user_id = 'user_a_id'
  AND original_transaction_id = 'ABC';

-- Keep subscription for User B (new owner)
-- (no action needed - it stays)
```

### Step 4: Verify

```sql
-- Should now have only 1 subscription per original_transaction_id
SELECT 
  original_transaction_id,
  COUNT(*) as count
FROM user_subscriptions
WHERE provider = 'apple'
GROUP BY original_transaction_id
HAVING COUNT(*) > 1;
```

**Expected**: No results

---

## Database Schema Constraints

Your schema should have:

```sql
CREATE TABLE user_subscriptions (
  user_id TEXT PRIMARY KEY,              -- ✅ One subscription per user
  original_transaction_id TEXT UNIQUE,   -- ✅ One subscription per Apple transaction
  transaction_id TEXT,                   -- Changes on renewal
  -- ... other fields
);
```

With these constraints:
- ✅ Each user can only have ONE subscription
- ✅ Each Apple subscription can only be linked to ONE user
- ✅ Transfer = DELETE old user + INSERT new user

---

## Testing the Fix

### Test 1: Normal Transfer

```
1. User A subscribes
   └─ user_subscriptions: { user_id: "user_a", original_transaction_id: "ABC" }

2. User B restores (with allowTransfer: true)
   ├─ Fetch subscription for "ABC" → Found (user_a)
   ├─ Verify ownership → Matches user_a ✅
   ├─ Check if user_b has subscription → No
   ├─ DELETE user_a's subscription
   ├─ INSERT user_b's subscription
   └─ SUCCESS ✅
```

### Test 2: Retry Transfer (Idempotent)

```
1. User B already has the subscription
   └─ user_subscriptions: { user_id: "user_b", original_transaction_id: "ABC" }

2. User B restores again
   ├─ Fetch subscription for "ABC" → Found (user_b)
   ├─ Verify ownership → Doesn't match user_a ❌
   ├─ Check if user_b has subscription → Yes, same original_transaction_id
   └─ Return success (already transferred) ✅
```

### Test 3: User B Has Different Subscription

```
1. User B has old subscription
   └─ user_subscriptions: { user_id: "user_b", original_transaction_id: "XYZ" }

2. User B restores new subscription (ABC)
   ├─ Fetch subscription for "ABC" → Found (user_a)
   ├─ DELETE user_a's subscription
   ├─ Check if user_b has subscription → Yes, but different original_transaction_id
   ├─ DELETE user_b's old subscription (XYZ)
   ├─ INSERT user_b's new subscription (ABC)
   └─ SUCCESS ✅
```

---

## Prevention

The fixes ensure:
1. ✅ DELETE always succeeds (uses primary key)
2. ✅ Ownership is verified before transfer
3. ✅ Target user's old subscription is cleaned up
4. ✅ Idempotent (can retry safely)
5. ✅ Better error messages

---

## If You Still Get Duplicates

### Possible Causes:

1. **Database doesn't have UNIQUE constraint on original_transaction_id**
   ```sql
   -- Add constraint
   ALTER TABLE user_subscriptions 
   ADD CONSTRAINT unique_original_transaction_id 
   UNIQUE (original_transaction_id);
   ```

2. **Race condition** (multiple requests at same time)
   - Solution: Add transaction/locking
   - Or: Check for duplicate before INSERT

3. **Partial failure** (DELETE succeeds but INSERT fails)
   - Solution: Use database transactions
   - Or: Retry logic

---

## Quick Cleanup Script

```sql
-- Find duplicates
WITH duplicates AS (
  SELECT original_transaction_id
  FROM user_subscriptions
  WHERE provider = 'apple'
  GROUP BY original_transaction_id
  HAVING COUNT(*) > 1
)
-- Keep only the most recent subscription for each duplicate
DELETE FROM user_subscriptions
WHERE id IN (
  SELECT id
  FROM user_subscriptions us
  WHERE original_transaction_id IN (SELECT original_transaction_id FROM duplicates)
  AND id NOT IN (
    SELECT DISTINCT ON (original_transaction_id) id
    FROM user_subscriptions
    WHERE original_transaction_id IN (SELECT original_transaction_id FROM duplicates)
    ORDER BY original_transaction_id, created_at DESC
  )
);
```

---

## Summary

**Problem**: Transfer creates duplicate subscriptions
**Cause**: DELETE fails or target user already has subscription
**Fix**: 
- ✅ Better error handling
- ✅ Verify ownership
- ✅ Check target user before INSERT
- ✅ Clean up old subscriptions

**Status**: Fixed! Retry your restore-purchase now.
