> ⚠️ **Outdated:** This document was written when the app used a page/quota
> system (`page_limit` / `pages_used`) and Lovla branding. That quota system
> has since been **removed** (Embryly has no page limits) and the app was
> rebranded to Embryly. Treat the page/quota details below as historical only.

# Simplified Restore Flow

## You Were Right! 🎯

The backend already handles all the ownership checks, so the frontend doesn't need to make multiple API calls.

---

## ❌ Old Approach (Overcomplicated)

```
Frontend:
1. Get purchase from Apple
2. Call /check-subscription-ownership
3. Check if isOwnedByCurrentUser
4. If yes → Call /restore-purchase with allowTransfer: false
5. If no → Prompt user → Call /restore-purchase with allowTransfer: true
```

**Problem**: Frontend doing logic that backend already does!

---

## ✅ New Approach (Simplified)

```
Frontend:
1. Get purchase from Apple
2. Call /restore-purchase with allowTransfer: false
3. Backend responds:
   - ✅ success: true → Done!
   - ⚠️ requiresTransferConfirmation: true → Prompt user
4. If user confirms → Call /restore-purchase with allowTransfer: true
```

**Benefit**: Backend does all the logic, frontend just handles UI!

---

## Code Comparison

### ❌ Old (Overcomplicated)

```typescript
async function restorePurchases(userId: string) {
  const { results } = await InAppPurchases.getPurchaseHistoryAsync();
  const purchase = results[0];

  // ❌ Unnecessary API call
  const ownershipCheck = await checkSubscriptionOwnership(
    purchase.originalTransactionIdentifier,
    userId
  );

  // ❌ Frontend doing ownership logic
  if (ownershipCheck.isOwnedByCurrentUser) {
    return await restoreForCurrentUser(purchase, userId);
  } else if (ownershipCheck.isOwnedByOther) {
    return await promptForRestore(purchase, userId);
  } else {
    return await restoreForCurrentUser(purchase, userId);
  }
}

// ❌ Extra function
async function checkSubscriptionOwnership(originalTransactionId, userId) {
  return await fetch('/check-subscription-ownership', ...);
}

// ❌ Extra function
async function restoreForCurrentUser(purchase, userId) {
  return await fetch('/restore-purchase', { allowTransfer: false });
}

// ❌ Extra function
async function promptForRestore(purchase, userId) {
  Alert.alert(...);
  return await fetch('/restore-purchase', { allowTransfer: true });
}
```

**Total**: 4 functions, 2 API calls, frontend doing ownership logic

---

### ✅ New (Simplified)

```typescript
async function restorePurchases(userId: string) {
  const { results } = await InAppPurchases.getPurchaseHistoryAsync();
  const purchase = results[0];

  // ✅ Single API call - backend handles ownership
  const result = await attemptRestore(purchase, userId, false);

  // ✅ Backend tells us if transfer needed
  if (result.requiresTransferConfirmation) {
    return await promptForTransfer(purchase, userId);
  }

  return result;
}

// ✅ One reusable function
async function attemptRestore(purchase, userId, allowTransfer) {
  const result = await fetch('/restore-purchase', {
    body: { signedTransaction: purchase.transactionReceipt, userId, allowTransfer }
  });
  
  if (result.success) {
    Alert.alert('Subscription Restored', 'Success!');
  }
  
  return result;
}

// ✅ Simple prompt
async function promptForTransfer(purchase, userId) {
  Alert.alert(
    'Restore Subscription',
    'A subscription was found. Would you like to restore it?',
    [
      { text: 'Cancel' },
      { 
        text: 'Restore', 
        onPress: () => attemptRestore(purchase, userId, true) // ✅ Reuse same function
      }
    ]
  );
}
```

**Total**: 3 functions, 1-2 API calls (only 2 if transfer needed), backend does all logic

---

## Backend Response Flow

### Scenario 1: Same User Restore

```
Request:
POST /restore-purchase
{ userId: "user_a", allowTransfer: false }

Backend checks:
- Subscription exists? Yes
- Belongs to user_a? Yes
- Expired? No

Response:
{ success: true, subscription: {...} }

Frontend:
✅ Show "Subscription Restored"
```

---

### Scenario 2: Different User (Transfer Needed)

```
Request #1:
POST /restore-purchase
{ userId: "user_b", allowTransfer: false }

Backend checks:
- Subscription exists? Yes
- Belongs to user_b? No (belongs to user_a)
- Expired? No

Response:
{ 
  success: false,
  requiresTransferConfirmation: true,
  message: "Subscription linked to another account"
}

Frontend:
⚠️ Show Alert: "A subscription was found. Restore it?"

User taps "Restore"

Request #2:
POST /restore-purchase
{ userId: "user_b", allowTransfer: true }

Backend:
- User confirmed transfer
- Transfer subscription from user_a to user_b
- Preserve pages_used

Response:
{ success: true, transferred: true, subscription: {...} }

Frontend:
✅ Show "Subscription Restored"
```

---

### Scenario 3: No Active Subscription

```
Request:
POST /restore-purchase
{ userId: "user_a", allowTransfer: false }

Backend checks:
- Subscription expired? Yes

Response:
{ 
  success: false,
  code: "NO_ACTIVE_SUBSCRIPTION",
  message: "No active subscription found"
}

Frontend:
❌ Show "No Active Subscription"
```

---

## Key Takeaway

**Backend does the heavy lifting**:
- Checks ownership
- Checks expiration
- Handles transfer logic
- Preserves quota

**Frontend just handles UI**:
- Get purchase from Apple
- Call backend
- Show appropriate message
- Prompt for confirmation if needed

**Result**: Cleaner code, single source of truth, easier to maintain! 🎉
