> ⚠️ **Outdated:** This document was written when the app used a page/quota
> system (`page_limit` / `pages_used`) and Lovla branding. That quota system
> has since been **removed** (Embryly has no page limits) and the app was
> rebranded to Embryly. Treat the page/quota details below as historical only.

# Complete Fix Guide - Duplicate Subscriptions

## THE ROOT CAUSE

Your database schema is **MISSING** a critical constraint:

```sql
-- ❌ CURRENT SCHEMA (Missing UNIQUE constraint)
CREATE TABLE user_subscriptions (
  user_id uuid PRIMARY KEY,              -- ✅ One subscription per user
  original_transaction_id text NULL,     -- ❌ NOT UNIQUE! Multiple users can have same value!
  -- ...
);
```

**This allows multiple users to have the same `original_transaction_id`**, which is causing duplicates!

---

## Why This Happens

### Scenario:
```
1. User A subscribes
   └─ { user_id: "user_a", original_transaction_id: "ABC" }

2. User B restores (same Apple ID)
   └─ Code tries to create: { user_id: "user_b", original_transaction_id: "ABC" }

3. Database says: "OK!" (because no UNIQUE constraint)
   └─ Now you have DUPLICATE subscriptions with same original_transaction_id ❌
```

### What SHOULD happen:
```
1. User A subscribes
   └─ { user_id: "user_a", original_transaction_id: "ABC" }

2. User B restores (same Apple ID)
   └─ Code tries to create: { user_id: "user_b", original_transaction_id: "ABC" }

3. Database says: "ERROR! Duplicate original_transaction_id" 
   └─ Code handles error and does proper transfer (DELETE user_a, INSERT user_b) ✅
```

---

## THE FIX (3 Steps)

### Step 1: Clean Up Existing Duplicates

Run this SQL to find duplicates:

```sql
-- Find all duplicates
SELECT 
  original_transaction_id,
  COUNT(*) as count,
  array_agg(user_id::text ORDER BY created_at DESC) as user_ids,
  array_agg(created_at ORDER BY created_at DESC) as dates
FROM user_subscriptions
WHERE original_transaction_id IS NOT NULL
GROUP BY original_transaction_id
HAVING COUNT(*) > 1;
```

**For each duplicate**, decide which to keep:
- Keep the **most recent** one (latest `created_at`)
- OR keep the one for the **current logged-in user**

```sql
-- Delete all but the most recent for each original_transaction_id
DELETE FROM user_subscriptions
WHERE user_id IN (
  SELECT user_id
  FROM (
    SELECT 
      user_id,
      original_transaction_id,
      ROW_NUMBER() OVER (
        PARTITION BY original_transaction_id 
        ORDER BY created_at DESC
      ) as rn
    FROM user_subscriptions
    WHERE original_transaction_id IS NOT NULL
  ) ranked
  WHERE rn > 1  -- Delete all except the first (most recent)
);
```

### Step 2: Add UNIQUE Constraint

```sql
-- Add UNIQUE constraint to prevent future duplicates
ALTER TABLE user_subscriptions
ADD CONSTRAINT unique_original_transaction_id 
UNIQUE (original_transaction_id);

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_subs_original_transaction_id 
ON user_subscriptions(original_transaction_id) 
WHERE original_transaction_id IS NOT NULL;
```

### Step 3: Verify

```sql
-- Should return 0 rows (no duplicates)
SELECT 
  original_transaction_id,
  COUNT(*) as count
FROM user_subscriptions
WHERE original_transaction_id IS NOT NULL
GROUP BY original_transaction_id
HAVING COUNT(*) > 1;

-- Check constraint exists
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'user_subscriptions'::regclass
  AND conname = 'unique_original_transaction_id';
```

---

## How The Code Will Work After Fix

### Before (Without UNIQUE Constraint):

```typescript
// User B restores
await supabase.from("user_subscriptions").insert({
  user_id: "user_b",
  original_transaction_id: "ABC"  // Same as User A's
});
// ❌ SUCCESS - Creates duplicate!
```

### After (With UNIQUE Constraint):

```typescript
// User B restores
const { error } = await supabase.from("user_subscriptions").insert({
  user_id: "user_b",
  original_transaction_id: "ABC"  // Same as User A's
});

if (error) {
  // ✅ ERROR: duplicate key value violates unique constraint
  // Code detects this and does proper transfer:
  // 1. DELETE user_a's subscription
  // 2. INSERT user_b's subscription
}
```

---

## Understanding Your Current Duplicates

You said both subscriptions have:
- ✅ Same `original_transaction_id`
- ✅ Same `transaction_id`
- ❌ Different `user_id`

This means:
1. **First restore** created subscription for User A
2. **Second restore** created subscription for User B
3. **No transfer happened** because database allowed the duplicate

---

## Manual Cleanup (If You Know Which User to Keep)

### Option A: Keep User A's subscription
```sql
DELETE FROM user_subscriptions
WHERE user_id = 'user_b_id'
  AND original_transaction_id = 'ABC';
```

### Option B: Keep User B's subscription (Transfer)
```sql
DELETE FROM user_subscriptions
WHERE user_id = 'user_a_id'
  AND original_transaction_id = 'ABC';
```

### Option C: Keep the most recent
```sql
-- See which is more recent
SELECT user_id, created_at, updated_at
FROM user_subscriptions
WHERE original_transaction_id = 'ABC'
ORDER BY created_at DESC;

-- Delete the older one
DELETE FROM user_subscriptions
WHERE user_id = 'OLDER_USER_ID'
  AND original_transaction_id = 'ABC';
```

---

## Why The Code Didn't Catch This

The current code assumes `original_transaction_id` is UNIQUE:

```typescript
// Line 480-484: Checks if subscription exists
const { data: existingSub } = await supabase
  .from("user_subscriptions")
  .select("user_id, status, pages_used, last_granted_at")
  .eq("original_transaction_id", txInfo.originalTransactionId)
  .single();  // ❌ .single() assumes only 1 result!
```

**Problem**: If there are duplicates, `.single()` might:
- Return the first one
- Return an error
- Return unpredictable results

**After adding UNIQUE constraint**: This won't be an issue because duplicates can't exist!

---

## Prevention (Already in Code)

The code already has checks, but they only work AFTER the UNIQUE constraint is added:

1. **Line 518-532**: Checks if subscription already exists for user
2. **Line 486-515**: Handles transfer if subscription belongs to different user
3. **Line 755-793**: Transfer function does DELETE + INSERT

But without the UNIQUE constraint, the database allows duplicates to slip through!

---

## Testing After Fix

### Test 1: Try to create duplicate manually
```sql
-- Should FAIL with unique constraint violation
INSERT INTO user_subscriptions (
  user_id, 
  original_transaction_id,
  provider,
  plan_key,
  status,
  period_start,
  period_end,
  page_limit
) VALUES (
  'test_user_2',
  'ABC',  -- Same as existing
  'apple',
  'premium',
  'active',
  NOW(),
  NOW() + INTERVAL '1 month',
  100
);
```

Expected: `ERROR: duplicate key value violates unique constraint "unique_original_transaction_id"`

### Test 2: Restore purchase flow
```
1. User A subscribes
2. User B restores
3. Should prompt for transfer
4. User B confirms
5. Should DELETE user_a, INSERT user_b
6. No duplicates!
```

---

## Files Created

1. **`FIX_SCHEMA_AND_DUPLICATES.sql`** - Complete SQL script to:
   - Find duplicates
   - Clean up duplicates
   - Add UNIQUE constraint
   - Verify fix

---

## Summary

**Problem**: Database allows duplicate `original_transaction_id`
**Cause**: Missing UNIQUE constraint in schema
**Fix**: 
1. Clean up existing duplicates
2. Add UNIQUE constraint
3. Code will automatically handle transfers correctly

**Run the SQL script now to fix the schema!** 🎉

---

## Quick Fix Commands

```sql
-- 1. Find your duplicates
SELECT original_transaction_id, COUNT(*), array_agg(user_id::text)
FROM user_subscriptions
WHERE original_transaction_id IS NOT NULL
GROUP BY original_transaction_id
HAVING COUNT(*) > 1;

-- 2. Delete duplicates (keeps most recent)
DELETE FROM user_subscriptions
WHERE user_id IN (
  SELECT user_id FROM (
    SELECT user_id, ROW_NUMBER() OVER (
      PARTITION BY original_transaction_id 
      ORDER BY created_at DESC
    ) as rn
    FROM user_subscriptions
    WHERE original_transaction_id IS NOT NULL
  ) ranked WHERE rn > 1
);

-- 3. Add constraint
ALTER TABLE user_subscriptions
ADD CONSTRAINT unique_original_transaction_id 
UNIQUE (original_transaction_id);

-- 4. Verify
SELECT original_transaction_id, COUNT(*)
FROM user_subscriptions
GROUP BY original_transaction_id
HAVING COUNT(*) > 1;
-- Should return 0 rows
```
