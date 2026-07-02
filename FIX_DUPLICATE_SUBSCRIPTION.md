> ⚠️ **Outdated:** This document was written when the app used a page/quota
> system (`page_limit` / `pages_used`) and Lovla branding. That quota system
> has since been **removed** (Embryly has no page limits) and the app was
> rebranded to Embryly. Treat the page/quota details below as historical only.

# Fix Duplicate Subscription Issue

## The Problem

You have duplicate subscriptions with:
- Same `original_transaction_id`
- Different `transaction_id`
- This happened because restore-purchase was called multiple times

## What Was Fixed in Code

Added a check to prevent re-processing if subscription already exists for the user:

```typescript
// Line 517-530 in validate-purchase.ts
if (existingSub && existingSub.user_id === userId) {
  console.log("✅ Subscription already exists for this user");
  return res.json({
    success: true,
    alreadyRestored: true,
    message: "Subscription already restored"
  });
}
```

This prevents creating duplicate subscriptions when restore is called multiple times.

---

## How to Clean Up Current Duplicates

### Step 1: Identify the Duplicates

```sql
-- Find users with duplicate subscriptions (shouldn't be possible if user_id is PK)
SELECT user_id, COUNT(*) as count
FROM user_subscriptions
WHERE provider = 'apple'
GROUP BY user_id
HAVING COUNT(*) > 1;

-- If original_transaction_id is UNIQUE, find duplicates by that
SELECT original_transaction_id, COUNT(*) as count, 
       array_agg(user_id) as user_ids,
       array_agg(transaction_id) as transaction_ids
FROM user_subscriptions
WHERE provider = 'apple'
GROUP BY original_transaction_id
HAVING COUNT(*) > 1;
```

### Step 2: Check Your Specific Case

```sql
-- Replace with your user_id
SELECT 
  user_id,
  original_transaction_id,
  transaction_id,
  status,
  period_start,
  period_end,
  pages_used,
  page_limit,
  created_at,
  updated_at
FROM user_subscriptions
WHERE user_id = 'YOUR_USER_ID'
ORDER BY created_at DESC;
```

### Step 3: Decide Which to Keep

**Keep the most recent one** (latest `updated_at` or `created_at`)

```sql
-- See which one is most recent
SELECT 
  user_id,
  original_transaction_id,
  transaction_id,
  status,
  created_at,
  updated_at,
  CASE 
    WHEN updated_at > created_at THEN 'Updated recently'
    ELSE 'Just created'
  END as recency
FROM user_subscriptions
WHERE user_id = 'YOUR_USER_ID'
ORDER BY COALESCE(updated_at, created_at) DESC;
```

### Step 4: Delete the Duplicate

**Option A: If `user_id` is Primary Key** (most likely)

You can't have duplicates with same `user_id`. The issue is probably:
- Multiple users have same `original_transaction_id`
- OR you have old/stale data

```sql
-- Check if original_transaction_id is duplicated across users
SELECT 
  original_transaction_id,
  array_agg(user_id) as users,
  COUNT(*) as count
FROM user_subscriptions
WHERE original_transaction_id = 'YOUR_ORIGINAL_TRANSACTION_ID'
GROUP BY original_transaction_id;
```

If multiple users have the same `original_transaction_id`, keep only the correct one:

```sql
-- Delete subscription from wrong user
DELETE FROM user_subscriptions
WHERE original_transaction_id = 'YOUR_ORIGINAL_TRANSACTION_ID'
  AND user_id != 'CORRECT_USER_ID';
```

**Option B: If You Somehow Have True Duplicates**

```sql
-- Delete older subscription, keep newest
DELETE FROM user_subscriptions
WHERE user_id = 'YOUR_USER_ID'
  AND created_at < (
    SELECT MAX(created_at)
    FROM user_subscriptions
    WHERE user_id = 'YOUR_USER_ID'
  );
```

---

## Understanding the Database Schema

### If `user_id` is Primary Key:
- ✅ Can't have duplicate subscriptions for same user
- ❌ Can have same `original_transaction_id` for different users (before transfer)

### If `original_transaction_id` is UNIQUE:
- ✅ Can't have duplicate subscriptions with same `original_transaction_id`
- ❌ Can't transfer subscriptions (would violate unique constraint)

### Most Likely Schema:
```sql
CREATE TABLE user_subscriptions (
  user_id TEXT PRIMARY KEY,  -- One subscription per user
  original_transaction_id TEXT UNIQUE,  -- One subscription per Apple transaction
  transaction_id TEXT,  -- Latest transaction (changes on renewal)
  -- ... other fields
);
```

With this schema:
- Each user can only have ONE subscription
- Each Apple subscription can only be linked to ONE user
- `transaction_id` updates on renewal (but `original_transaction_id` stays same)

---

## What Likely Happened

### Scenario 1: You Restored Multiple Times
```
Attempt 1: Restore-purchase
├─ Subscription created with transaction_id: "ABC"
├─ Event creation FAILED (invalid event_type)
└─ Subscription exists, but no event logged

Attempt 2: Restore-purchase (retry)
├─ Check: Does subscription exist? 
├─ OLD CODE: Didn't check, tried to upsert
├─ Upsert updated transaction_id to "XYZ"
└─ Now you have different transaction_id
```

### Scenario 2: Renewal Happened
```
Original purchase: transaction_id = "ABC"
Renewal: transaction_id = "XYZ"
original_transaction_id = "123" (stays same)
```

This is NORMAL! `transaction_id` changes on renewal, but `original_transaction_id` stays the same.

---

## How to Verify What You Have

Run this query:

```sql
SELECT 
  user_id,
  original_transaction_id,
  transaction_id,
  status,
  period_start,
  period_end,
  pages_used,
  page_limit,
  created_at,
  updated_at
FROM user_subscriptions
WHERE user_id = 'YOUR_USER_ID';
```

**Expected result**: 1 row

**If you see 0 rows**: Subscription was deleted
**If you see 1 row**: Everything is fine! (transaction_id changing is normal)
**If you see 2+ rows**: You have a real duplicate (shouldn't be possible with PK)

---

## Prevention (Already Fixed)

The new code checks if subscription already exists before processing:

```typescript
// Check if subscription already exists for this user
if (existingSub && existingSub.user_id === userId) {
  return res.json({
    success: true,
    alreadyRestored: true,
    message: "Subscription already restored"
  });
}
```

This prevents:
- ✅ Re-processing same restore multiple times
- ✅ Creating duplicate events
- ✅ Unnecessary upserts

---

## Next Steps

1. **Check your data**: Run the queries above
2. **Understand what you have**: Is it a real duplicate or just updated `transaction_id`?
3. **Clean up if needed**: Delete wrong/old subscriptions
4. **Retry restore**: Should work now with fixed code

Need help interpreting the results? Share the output of the queries and I'll help you understand what happened!
