# Duplicate Check Analysis: /validate-purchase vs /restore-purchase

## The Question

Should the duplicate transaction check be:
- **User-specific** (only checks current user)
- **Global** (checks all users)

The answer is **DIFFERENT** for each endpoint!

---

## Endpoint 1: `/validate-purchase` (New Purchase)

### Purpose
Validates a purchase that just happened in the app.

### Flow
```
User purchases in app
├─ Apple processes payment
├─ Apple sets appAccountToken to current user
├─ App receives receipt
└─ App calls /validate-purchase
```

### Security Layers

**Layer 1: appAccountToken Check (Line 213)**
```typescript
if (txInfo.appAccountToken && txInfo.appAccountToken !== userId) {
  return "ACCOUNT_MISMATCH"; // Blocks different user
}
```

**Layer 2: Duplicate Event Check (Line 232)**
```typescript
// Question: Should this be user-specific or global?
```

### Analysis

**Scenario 1: Same user, double-submit**
```
User A purchases
User A's app calls /validate-purchase (1st time)
├─ appAccountToken: "user_a_id" ✅ Matches
├─ Duplicate check: Not found
└─ Process ✅

User A's app calls /validate-purchase (2nd time - network retry)
├─ appAccountToken: "user_a_id" ✅ Matches
├─ Duplicate check: ???
│  ├─ User-specific: Finds event for user_a_id → Blocks ✅
│  └─ Global: Finds event for user_a_id → Blocks ✅
└─ Both work! ✅
```

**Scenario 2: Different user tries to use same receipt**
```
User A purchases
User A logs out, User B logs in
User B tries to validate User A's receipt
├─ appAccountToken: "user_a_id" ❌ Doesn't match "user_b_id"
├─ BLOCKED by Layer 1 (appAccountToken check)
└─ Never reaches duplicate check!
```

**Scenario 3: appAccountToken is missing (edge case)**
```
User A purchases
Receipt has no appAccountToken (shouldn't happen, but...)
User A calls /validate-purchase
├─ appAccountToken check: Skipped (no token)
├─ Duplicate check: ???
│  ├─ User-specific: Not found → Process ✅
│  └─ Global: Not found → Process ✅
└─ Both work! ✅

User B tries to use same receipt
├─ appAccountToken check: Skipped (no token)
├─ Duplicate check: ???
│  ├─ User-specific: Not found for user_b → Process ❌ (WRONG!)
│  └─ Global: Found for user_a → Block ✅ (CORRECT!)
└─ Global check is safer!
```

### Conclusion for `/validate-purchase`

**Use GLOBAL check** (check all users)

**Reasoning**:
1. appAccountToken check already handles normal case
2. Global check is a **safety net** for edge cases
3. Prevents abuse if appAccountToken is missing/manipulated
4. No downside since appAccountToken already blocks legitimate different-user cases

---

## Endpoint 2: `/restore-purchase` (Restore)

### Purpose
Restores a subscription when user taps "Restore Purchases".

### Flow
```
User taps "Restore Purchases"
├─ App fetches purchase history from Apple
├─ Apple returns ALL purchases for this Apple ID
├─ App calls /restore-purchase
└─ Backend decides: restore or transfer?
```

### Security Layers

**Layer 1: Expiration Check (Line 442)**
```typescript
if (expiresDate < now) {
  return "NO_ACTIVE_SUBSCRIPTION";
}
```

**Layer 2: Ownership Check (Line 456)**
```typescript
if (existingSub && existingSub.user_id !== userId) {
  if (!allowTransfer) {
    return "requiresTransferConfirmation"; // Ask user
  }
  // User confirmed → Transfer
}
```

**Layer 3: Duplicate Event Check (Line 538)**
```typescript
// Question: Should this be user-specific or global?
```

### Analysis

**Scenario 1: Same user, multiple restores**
```
User A subscribes
User A logs out and back in
User A restores (1st time)
├─ Duplicate check: ???
│  ├─ User-specific: Not found → Process ✅
│  └─ Global: Not found → Process ✅
└─ Both work! ✅

User A restores (2nd time)
├─ Duplicate check: ???
│  ├─ User-specific: Found for user_a → Block ✅
│  └─ Global: Found for user_a → Block ✅
└─ Both work! ✅
```

**Scenario 2: Different user, transfer**
```
User A subscribes
User B restores (transfer)
├─ Ownership check: Detects different user
├─ User confirms transfer
├─ Duplicate check: ???
│  ├─ User-specific: Not found for user_b → Process ✅ (CORRECT!)
│  └─ Global: Found for user_a → Block ❌ (WRONG!)
└─ MUST use user-specific check!
```

**Scenario 3: Multiple transfers**
```
User A subscribes
User B restores (A→B transfer)
├─ Duplicate check (user-specific): Not found for user_b → Process ✅

User C restores (B→C transfer)
├─ Duplicate check (user-specific): Not found for user_c → Process ✅

User C restores again
├─ Duplicate check (user-specific): Found for user_c → Block ✅
```

### Conclusion for `/restore-purchase`

**Use USER-SPECIFIC check** (only check current user)

**Reasoning**:
1. Transfers are legitimate and expected
2. Ownership check already validates transfer is allowed
3. Global check would block ALL transfers
4. User-specific check still prevents duplicate processing per user

---

## Final Answer

### `/validate-purchase` → GLOBAL check ✅
```typescript
const { data: existingEvent } = await supabase
  .from("subscription_events")
  .select("id, user_id")
  .eq("provider", "apple")
  // NO .eq("user_id", actualUserId) - check ALL users
  .or(`raw_payload->>transactionId.eq.${txInfo.transactionId}...`)
  .single();
```

**Why**: Safety net for edge cases, appAccountToken already handles normal cases

### `/restore-purchase` → USER-SPECIFIC check ✅
```typescript
const { data: existingEvent } = await supabase
  .from("subscription_events")
  .select("id, user_id")
  .eq("provider", "apple")
  .eq("user_id", actualUserId) // Check ONLY current user
  .or(`raw_payload->>transactionId.eq.${txInfo.transactionId}...`)
  .single();
```

**Why**: Allows transfers, ownership check already validates legitimacy

---

## Summary Table

| Endpoint | Check Type | Reason |
|----------|-----------|--------|
| `/validate-purchase` | Global | Safety net, appAccountToken already blocks different users |
| `/restore-purchase` | User-specific | Allows transfers, ownership check validates legitimacy |

---

## Edge Case: What if someone bypasses appAccountToken?

**Attack scenario**:
```
Attacker gets User A's receipt
Attacker modifies request to remove/change appAccountToken
Attacker calls /validate-purchase with their userId
```

**Defense with global check**:
```
/validate-purchase
├─ appAccountToken check: Skipped (modified/missing)
├─ Duplicate check (global): Found User A's event
└─ BLOCKED ✅ (Attack prevented!)
```

**Defense with user-specific check**:
```
/validate-purchase
├─ appAccountToken check: Skipped (modified/missing)
├─ Duplicate check (user-specific): Not found for attacker
└─ PROCESSED ❌ (Attack succeeds!)
```

**Conclusion**: Global check is more secure for `/validate-purchase`!

---

## Implementation Status

✅ `/validate-purchase` - Using GLOBAL check (correct)
✅ `/restore-purchase` - Using USER-SPECIFIC check (correct)
