# Apple Compliant Messaging - Quick Reference

## ✅ DO Use These Messages

### No Active Subscription
```
"No active subscription found"
"Subscribe to access premium features"
```

### Restore Needed
```
"A subscription was found for this Apple ID. Would you like to restore it?"
"Already subscribed? Tap 'Restore Purchases'"
"Use 'Restore Purchases' to access your subscription"
```

### Already Owned
```
"You already own this subscription. Would you like to restore it?"
```

### Restore Success
```
"Your subscription has been restored successfully"
"Subscription restored"
```

### No Purchases Found
```
"No active subscriptions were found for this Apple ID"
```

### Purchase Failed
```
"Unable to complete your purchase. Please try again"
"Purchase failed. Please try again later"
```

---

## ❌ DON'T Use These Messages

### Account-Related (Apple Rejects These)
```
❌ "This subscription belongs to another account"
❌ "Switch accounts to access this subscription"
❌ "Transfer subscription to this account"
❌ "Log in with the account that purchased this"
❌ "Account mismatch detected"
```

### Expiration-Related (Too Explicit)
```
❌ "Your subscription has expired"
❌ "Subscription expired on [date]"
❌ "Renew your expired subscription"
```

### Technical Details (Confusing to Users)
```
❌ "appAccountToken mismatch"
❌ "originalTransactionId already linked"
❌ "Webhook validation failed"
❌ "Receipt verification error"
```

### Payment Alternatives (Apple Violation)
```
❌ "Subscribe on our website for cheaper prices"
❌ "Contact support to transfer subscription"
❌ "Pay via PayPal instead"
```

---

## Message Mapping

| Backend Error Code | User-Facing Message |
|-------------------|---------------------|
| `ACCOUNT_MISMATCH` | "Would you like to restore your purchases?" |
| `SUBSCRIPTION_LINKED_TO_OTHER_ACCOUNT` | "A subscription was found. Would you like to restore it?" |
| `NO_ACTIVE_SUBSCRIPTION` | "No active subscription found" |
| `SUBSCRIPTION_EXPIRED` | "No active subscription found" |
| `ITEM_ALREADY_OWNED` | "You already own this. Would you like to restore it?" |
| `PAYMENT_CANCELLED` | (No message - silent) |
| `VALIDATION_FAILED` | "Unable to complete your purchase. Please try again" |

---

## Required UI Elements (Apple Requirements)

### 1. Restore Purchases Button
**Where**: 
- Subscription/paywall screen
- Settings screen

**Label**: 
- "Restore Purchases" (exact wording)

### 2. Subscription Terms
**Text**:
```
"Subscription automatically renews unless auto-renew is turned off 
at least 24 hours before the end of the current period."
```

### 3. Links
- Terms of Service
- Privacy Policy

### 4. Pricing
- Must come from StoreKit (never hardcoded)
- Show in user's local currency

---

## Alert Examples (Copy-Paste Ready)

### Restore Prompt
```typescript
Alert.alert(
  'Restore Subscription',
  'A subscription was found for this Apple ID. Would you like to restore it to your current account?',
  [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Restore', onPress: () => handleRestore() },
  ]
);
```

### Already Owned
```typescript
Alert.alert(
  'Restore Purchases',
  'You already own this subscription. Would you like to restore it?',
  [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Restore', onPress: () => handleRestore() },
  ]
);
```

### No Active Subscription
```typescript
Alert.alert(
  'No Active Subscription',
  'Subscribe to access premium features.',
  [{ text: 'OK' }]
);
```

### Restore Success
```typescript
Alert.alert(
  'Subscription Restored',
  'Your subscription has been restored successfully.',
  [{ text: 'OK' }]
);
```

### No Purchases to Restore
```typescript
Alert.alert(
  'No Subscriptions Found',
  'No active subscriptions were found for this Apple ID.',
  [{ text: 'OK' }]
);
```

### Purchase Failed
```typescript
Alert.alert(
  'Purchase Failed',
  'Unable to complete your purchase. Please try again.',
  [{ text: 'OK' }]
);
```

---

## App Store Review Checklist

- [ ] No mention of "account", "transfer", or "switch"
- [ ] "Restore Purchases" button present and working
- [ ] Subscription terms displayed
- [ ] Privacy Policy linked
- [ ] Terms of Service linked
- [ ] Prices from StoreKit only
- [ ] No alternative payment methods mentioned
- [ ] Expired = "No active subscription"
- [ ] Technical errors hidden from users
- [ ] User cancellation handled silently

---

## Common Rejection Reasons

1. **Missing "Restore Purchases"** → Add button in subscription screen + settings
2. **Mentions "account switching"** → Use "restore" terminology only
3. **No subscription terms** → Add auto-renewal disclosure
4. **Hardcoded prices** → Use StoreKit pricing
5. **Alternative payment methods** → Remove all mentions
6. **Technical error messages** → Show user-friendly messages only

---

## Key Principle

**From Apple's perspective**: 
- Subscriptions belong to the **Apple ID**, not your app's accounts
- Users "restore" subscriptions, they don't "transfer" them
- Keep it simple: "Restore Purchases" solves everything
