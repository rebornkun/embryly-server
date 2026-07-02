# 🚨 CRITICAL BUG FIX: Duplicate Check Blocked Transfers

## The Bug

The duplicate transaction check was **blocking ALL transfers** because it checked if the transaction existed **for ANY user**, not just the current user.

---

## How It Broke Transfers

### Scenario:

```
Day 1: User A subscribes
├─ Transaction processed
├─ subscription_events table:
│  └─ { user_id: "user_a_id", transactionId: "123" }

Day 15: User B tries to restore (transfer)
├─ Calls /restore-purchase
├─ Backend checks: "Has transaction 123 been processed?"
├─ Query: SELECT * FROM subscription_events WHERE transactionId = "123"
├─ Result: FOUND (User A's event)
├─ Response: "Transaction already processed" ❌
└─ TRANSFER BLOCKED! ❌
```

---

## The Buggy Code

### Location 1: `processTransaction()` (line ~233)

```typescript
// ❌ BAD: Checks if transaction processed for ANY user
const { data: existingEvent } = await supabase
  .from("subscription_events")
  .select("id")
  .eq("provider", "apple")
  .or(`raw_payload->>transactionId.eq.${txInfo.transactionId}...`)
  .single();

if (existingEvent) {
  // This blocks even if event belongs to different user!
  return res.json({
    success: true,
    alreadyProcessed: true,
  });
}
```

### Location 2: `processTransactionForRestore()` (line ~538)

```typescript
// ❌ BAD: Same issue in restore flow
const { data: existingEvent } = await supabase
  .from("subscription_events")
  .select("id")
  .eq("provider", "apple")
  .or(`raw_payload->>transactionId.eq.${txInfo.transactionId}...`)
  .single();

if (existingEvent) {
  // Blocks transfer!
  return res.json({
    success: true,
    alreadyProcessed: true,
  });
}
```

---

## The Fix

### Add `.eq("user_id", actualUserId)` to the query

```typescript
// ✅ GOOD: Only checks if transaction processed for CURRENT user
const { data: existingEvent } = await supabase
  .from("subscription_events")
  .select("id, user_id")
  .eq("provider", "apple")
  .eq("user_id", actualUserId) // ✅ KEY FIX: Only check current user
  .or(`raw_payload->>transactionId.eq.${txInfo.transactionId}...`)
  .single();

if (existingEvent) {
  // Now only blocks if THIS user already processed it
  return res.json({
    success: true,
    alreadyProcessed: true,
  });
}
```

---

## Why This Works

### Before Fix:

```sql
-- Query checks ALL users
SELECT id FROM subscription_events 
WHERE provider = 'apple' 
AND (raw_payload->>'transactionId' = '123')
LIMIT 1;

-- Result: Returns User A's event
-- Blocks User B from processing same transaction ❌
```

### After Fix:

```sql
-- Query checks ONLY current user
SELECT id, user_id FROM subscription_events 
WHERE provider = 'apple' 
AND user_id = 'user_b_id'  -- ✅ KEY DIFFERENCE
AND (raw_payload->>'transactionId' = '123')
LIMIT 1;

-- Result: No event found (User B hasn't processed it yet)
-- Allows User B to process transaction ✅
```

---

## Flow Comparison

### ❌ Before Fix (Broken):

```
User A subscribes (transactionId: "123")
├─ Check: Has "123" been processed? No
├─ Process subscription
├─ Create event: { user_id: "user_a_id", transactionId: "123" }
└─ Success ✅

User B restores (same transactionId: "123")
├─ Check: Has "123" been processed? YES (found User A's event)
├─ Return: "Already processed"
└─ BLOCKED ❌ (Transfer never happens!)
```

### ✅ After Fix (Working):

```
User A subscribes (transactionId: "123")
├─ Check: Has "user_a_id" processed "123"? No
├─ Process subscription
├─ Create event: { user_id: "user_a_id", transactionId: "123" }
└─ Success ✅

User B restores (same transactionId: "123")
├─ Check: Has "user_b_id" processed "123"? No ✅
├─ Process transfer
├─ Create event: { user_id: "user_b_id", transactionId: "123" }
└─ Success ✅ (Transfer works!)
```

---

## Database State After Transfer

### subscription_events table:

```
| user_id    | transactionId | event_type | created_at |
|------------|---------------|------------|------------|
| user_a_id  | 123           | purchase   | Day 1      |
| user_b_id  | 123           | restore    | Day 15     | ✅ Both events exist!
```

**Key Point**: The same `transactionId` can have multiple events, one per user!

---

## Why Multiple Events Are OK

### Apple's Perspective:
- `transactionId` identifies a specific transaction in Apple's system
- The same Apple transaction can be restored by different users
- This is normal when subscriptions follow the Apple ID

### Your App's Perspective:
- Each user should only process the same transaction ONCE
- But different users CAN process the same transaction
- This is how transfers work!

---

## Test Cases

### Test 1: Same User, Multiple Restores (Should Block)

```
User A subscribes
User A logs out and back in
User A restores
├─ Check: Has "user_a_id" processed "123"? YES
└─ Return: "Already processed" ✅ (Correct - prevents duplicate)
```

### Test 2: Different User, Transfer (Should Allow)

```
User A subscribes
User B restores (transfer)
├─ Check: Has "user_b_id" processed "123"? NO
└─ Process transfer ✅ (Correct - allows transfer)
```

### Test 3: Multiple Transfers (Should Allow Each)

```
User A subscribes
User B restores (User A → User B)
├─ Check: Has "user_b_id" processed "123"? NO
└─ Process transfer ✅

User C restores (User B → User C)
├─ Check: Has "user_c_id" processed "123"? NO
└─ Process transfer ✅
```

---

## Impact Analysis

### What Was Broken:
- ❌ ALL transfers were blocked
- ❌ Users couldn't restore subscriptions to different accounts
- ❌ The entire transfer flow was non-functional

### What Is Fixed:
- ✅ Transfers work correctly
- ✅ Same user can't process transaction twice (prevents duplicates)
- ✅ Different users can process same transaction (enables transfers)

---

## Locations Fixed

1. **`src/routes/validate-purchase.ts`** - `processTransaction()` function
   - Line ~233: Added `.eq("user_id", actualUserId)`

2. **`src/routes/validate-purchase.ts`** - `processTransactionForRestore()` function
   - Line ~538: Added `.eq("user_id", actualUserId)`

---

## Verification

### Before Fix:
```bash
# User A subscribes
curl -X POST /validate-purchase -d '{"userId": "user_a", "signedTransaction": "..."}'
# Response: { success: true }

# User B tries to restore
curl -X POST /restore-purchase -d '{"userId": "user_b", "signedTransaction": "..."}'
# Response: { success: true, alreadyProcessed: true } ❌ BLOCKED!
```

### After Fix:
```bash
# User A subscribes
curl -X POST /validate-purchase -d '{"userId": "user_a", "signedTransaction": "..."}'
# Response: { success: true }

# User B tries to restore
curl -X POST /restore-purchase -d '{"userId": "user_b", "signedTransaction": "..."}'
# Response: { requiresTransferConfirmation: true } ✅ WORKS!

# User B confirms
curl -X POST /restore-purchase -d '{"userId": "user_b", "allowTransfer": true, ...}'
# Response: { success: true, transferred: true } ✅ TRANSFER COMPLETE!
```

---

## Lesson Learned

**Always scope duplicate checks to the current user/context!**

When checking if something has been processed:
- ❌ BAD: "Has this transaction been processed?" (global check)
- ✅ GOOD: "Has THIS USER processed this transaction?" (scoped check)

This pattern applies to:
- Transaction processing
- Event handling
- Idempotency checks
- Duplicate prevention

**Rule of thumb**: If multiple users can legitimately process the same thing, scope your duplicate checks to the user level!

---

## Conclusion

This was a **critical bug** that completely broke the transfer functionality. The fix is simple (adding one `.eq()` clause) but the impact is huge.

**Status**: ✅ FIXED in both locations
