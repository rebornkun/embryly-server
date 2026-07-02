# Expo IAP Implementation Guide (Apple Compliant)

## Overview
This guide shows how to implement in-app purchases using `expo-in-app-purchases` with Apple-compliant messaging and proper restore flow.

---

## Installation

```bash
npx expo install expo-in-app-purchases
```

---

## Apple Compliance Rules

### ✅ DO:
- Use Apple's terminology: "Restore Purchases" (not "Transfer")
- Show clear subscription terms before purchase
- Handle errors gracefully with user-friendly messages
- Provide a "Restore Purchases" button in settings
- Use Apple's product IDs and pricing from StoreKit

### ❌ DON'T:
- Mention "account transfer" or "switching accounts" to users
- Show technical error codes to users
- Use terms like "expired subscription" - say "no active subscription"
- Bypass Apple's payment system
- Show prices not from Apple's StoreKit

---

## Implementation

### 1. Setup & Configuration

```typescript
// hooks/useSubscription.ts
import { useEffect, useState } from 'react';
import * as InAppPurchases from 'expo-in-app-purchases';
import { Platform } from 'react-native';

// Your product IDs from App Store Connect
const PRODUCT_IDS = {
  monthly: 'com.embryly.premium.monthly',
  yearly: 'com.embryly.premium.yearly',
};

export function useSubscription() {
  const [isReady, setIsReady] = useState(false);
  const [products, setProducts] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    initializeIAP();
    return () => {
      InAppPurchases.disconnectAsync();
    };
  }, []);

  async function initializeIAP() {
    try {
      await InAppPurchases.connectAsync();
      setIsReady(true);
      
      // Fetch products
      const { results } = await InAppPurchases.getProductsAsync(
        Object.values(PRODUCT_IDS)
      );
      setProducts(results);
    } catch (error) {
      console.error('Failed to initialize IAP:', error);
    }
  }

  return { isReady, products, isLoading };
}
```

---

### 2. Purchase Flow (Apple Compliant)

```typescript
// services/subscriptionService.ts
import * as InAppPurchases from 'expo-in-app-purchases';
import { Alert } from 'react-native';

export async function purchaseSubscription(
  productId: string,
  userId: string
) {
  try {
    // Set app account token (links purchase to your user)
    await InAppPurchases.setAppAccountTokenAsync(userId);

    // Purchase
    const result = await InAppPurchases.purchaseItemAsync(productId);

    if (result.results && result.results.length > 0) {
      const purchase = result.results[0];
      
      // Validate with your server
      const validation = await validatePurchaseWithServer(
        purchase.transactionReceipt,
        userId
      );

      if (validation.success) {
        return { success: true, subscription: validation.subscription };
      } else {
        // Handle different error cases
        return handleValidationError(validation);
      }
    }
  } catch (error: any) {
    return handlePurchaseError(error);
  }
}

async function validatePurchaseWithServer(receipt: string, userId: string) {
  const response = await fetch('https://your-server.com/validate-purchase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTransaction: receipt,
      userId,
    }),
  });
  return response.json();
}

function handleValidationError(validation: any) {
  switch (validation.code) {
    case 'ACCOUNT_MISMATCH':
      // Apple Compliant: Don't mention "account mismatch"
      // Guide user to restore instead
      Alert.alert(
        'Restore Purchases',
        'It looks like you may have an existing subscription. Would you like to restore your purchases?',
        [
          { text: 'Cancel', style: 'cancel' },
          { 
            text: 'Restore', 
            onPress: () => restorePurchases(validation.purchaseOwnerId) 
          },
        ]
      );
      return { success: false, needsRestore: true };

    case 'SUBSCRIPTION_LINKED_TO_OTHER_ACCOUNT':
      // Apple Compliant: Don't mention "other account"
      Alert.alert(
        'Subscription Found',
        'An active subscription is already linked to this device. Use "Restore Purchases" to access it.',
        [{ text: 'OK' }]
      );
      return { success: false, needsRestore: true };

    case 'NO_ACTIVE_SUBSCRIPTION':
      // Apple Compliant: Simple message
      Alert.alert(
        'No Active Subscription',
        'Subscribe to access premium features.',
        [{ text: 'OK' }]
      );
      return { success: false };

    default:
      Alert.alert(
        'Purchase Failed',
        'Unable to complete your purchase. Please try again.',
        [{ text: 'OK' }]
      );
      return { success: false };
  }
}

function handlePurchaseError(error: any) {
  // User cancelled
  if (error.code === InAppPurchases.IAPErrorCode.PAYMENT_CANCELLED) {
    return { success: false, cancelled: true };
  }

  // Already purchased (Apple says user already has this)
  if (error.code === InAppPurchases.IAPErrorCode.ITEM_ALREADY_OWNED) {
    Alert.alert(
      'Restore Purchases',
      'You already own this subscription. Would you like to restore it?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore', onPress: () => restorePurchases() },
      ]
    );
    return { success: false, needsRestore: true };
  }

  // Generic error
  Alert.alert(
    'Purchase Error',
    'Something went wrong. Please try again later.',
    [{ text: 'OK' }]
  );
  return { success: false, error: error.message };
}
```

---

### 3. Restore Purchases Flow (Apple Compliant)

**Key Point**: The backend handles ALL ownership checks and transfer logic. The frontend just:
1. Calls `/restore-purchase` with `allowTransfer: false`
2. If backend returns `requiresTransferConfirmation`, ask user
3. Call again with `allowTransfer: true` if user confirms

No need for separate `/check-subscription-ownership` endpoint!

```typescript
// services/subscriptionService.ts

export async function restorePurchases(userId: string) {
  try {
    // Get purchase history from Apple
    const { results } = await InAppPurchases.getPurchaseHistoryAsync();

    if (!results || results.length === 0) {
      // Apple Compliant: Don't say "no purchases found"
      Alert.alert(
        'No Subscriptions Found',
        'No active subscriptions were found for this Apple ID.',
        [{ text: 'OK' }]
      );
      return { success: false };
    }

    // Get the most recent subscription
    const latestPurchase = results[0];

    // Try to restore (backend handles all ownership checks)
    const result = await attemptRestore(latestPurchase, userId, false);

    // Backend detected transfer needed - ask user for confirmation
    if (result.requiresTransferConfirmation) {
      return await promptForTransfer(latestPurchase, userId);
    }

    // Handle other errors
    if (!result.success) {
      handleRestoreError(result);
    }

    return result;
  } catch (error) {
    Alert.alert(
      'Restore Failed',
      'Unable to restore purchases. Please try again.',
      [{ text: 'OK' }]
    );
    return { success: false, error };
  }
}

/**
 * Attempt to restore purchase
 * Backend handles all the ownership logic
 */
async function attemptRestore(
  purchase: any,
  userId: string,
  allowTransfer: boolean
) {
  const response = await fetch('https://your-server.com/restore-purchase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTransaction: purchase.transactionReceipt,
      userId,
      allowTransfer,
    }),
  });

  const result = await response.json();

  if (result.success) {
    Alert.alert(
      'Subscription Restored',
      'Your subscription has been restored successfully.',
      [{ text: 'OK' }]
    );
    return { success: true, subscription: result.subscription };
  }

  return result;
}

/**
 * Prompt user to confirm restore (when backend detects transfer needed)
 * Apple Compliant: Don't mention "transfer" or "other account"
 */
async function promptForTransfer(purchase: any, userId: string) {
  return new Promise((resolve) => {
    Alert.alert(
      'Restore Subscription',
      'A subscription was found for this Apple ID. Would you like to restore it?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => resolve({ success: false, cancelled: true }),
        },
        {
          text: 'Restore',
          onPress: async () => {
            // User confirmed - try again with allowTransfer: true
            const result = await attemptRestore(purchase, userId, true);
            
            if (!result.success) {
              handleRestoreError(result);
            }
            
            resolve(result);
          },
        },
      ]
    );
  });
}

function handleRestoreError(result: any) {
  switch (result.code) {
    case 'NO_ACTIVE_SUBSCRIPTION':
      Alert.alert(
        'No Active Subscription',
        'No active subscription was found.',
        [{ text: 'OK' }]
      );
      break;

    default:
      Alert.alert(
        'Restore Failed',
        'Unable to restore your subscription. Please try again.',
        [{ text: 'OK' }]
      );
  }
  return { success: false };
}
```

---

### 4. UI Components (Apple Compliant)

```typescript
// screens/SubscriptionScreen.tsx
import React from 'react';
import { View, Text, Button, ActivityIndicator } from 'react-native';
import { useSubscription } from '../hooks/useSubscription';
import { purchaseSubscription, restorePurchases } from '../services/subscriptionService';

export function SubscriptionScreen({ userId }: { userId: string }) {
  const { isReady, products, isLoading } = useSubscription();
  const [purchasing, setPurchasing] = React.useState(false);

  async function handlePurchase(productId: string) {
    setPurchasing(true);
    await purchaseSubscription(productId, userId);
    setPurchasing(false);
  }

  async function handleRestore() {
    setPurchasing(true);
    await restorePurchases(userId);
    setPurchasing(false);
  }

  if (!isReady || isLoading) {
    return <ActivityIndicator />;
  }

  return (
    <View style={{ padding: 20 }}>
      <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 20 }}>
        Premium Subscription
      </Text>

      {/* Show products */}
      {products.map((product) => (
        <View key={product.productId} style={{ marginBottom: 15 }}>
          <Text style={{ fontSize: 18 }}>{product.title}</Text>
          <Text style={{ color: '#666' }}>{product.description}</Text>
          <Button
            title={`Subscribe - ${product.priceString}`}
            onPress={() => handlePurchase(product.productId)}
            disabled={purchasing}
          />
        </View>
      ))}

      {/* Apple requires "Restore Purchases" button */}
      <View style={{ marginTop: 30, borderTopWidth: 1, paddingTop: 20 }}>
        <Button
          title="Restore Purchases"
          onPress={handleRestore}
          disabled={purchasing}
        />
        <Text style={{ fontSize: 12, color: '#666', marginTop: 10, textAlign: 'center' }}>
          Already subscribed? Tap here to restore your subscription.
        </Text>
      </View>

      {/* Apple Compliant: Show terms */}
      <Text style={{ fontSize: 10, color: '#999', marginTop: 20, textAlign: 'center' }}>
        Subscription automatically renews unless auto-renew is turned off at least 24 hours before the end of the current period.
        {'\n\n'}
        <Text onPress={() => openTerms()}>Terms of Service</Text>
        {' • '}
        <Text onPress={() => openPrivacy()}>Privacy Policy</Text>
      </Text>
    </View>
  );
}
```

---

### 5. Settings Screen (Apple Compliant)

```typescript
// screens/SettingsScreen.tsx
import React from 'react';
import { View, Text, Button } from 'react-native';
import { restorePurchases } from '../services/subscriptionService';

export function SettingsScreen({ userId }: { userId: string }) {
  return (
    <View style={{ padding: 20 }}>
      <Text style={{ fontSize: 20, fontWeight: 'bold', marginBottom: 20 }}>
        Settings
      </Text>

      {/* Apple requires "Restore Purchases" in settings */}
      <View style={{ marginBottom: 20 }}>
        <Text style={{ fontSize: 16, marginBottom: 10 }}>Subscription</Text>
        <Button
          title="Restore Purchases"
          onPress={() => restorePurchases(userId)}
        />
      </View>

      {/* Other settings... */}
    </View>
  );
}
```

---

## Apple Compliant Messaging Reference

### ✅ Good Messages (Apple Approved):

```typescript
// No active subscription
"No active subscription found"
"Subscribe to access premium features"

// Restore needed
"A subscription was found for this Apple ID"
"Would you like to restore it?"
"Tap 'Restore Purchases' to access your subscription"

// Already owned
"You already own this subscription"
"Use 'Restore Purchases' to access it"

// Restore success
"Your subscription has been restored successfully"

// No purchases to restore
"No active subscriptions were found for this Apple ID"
```

### ❌ Bad Messages (Apple May Reject):

```typescript
// Don't mention account switching
"This subscription belongs to another account"
"Switch accounts to access this subscription"
"Transfer subscription to this account"

// Don't mention expiration explicitly
"Your subscription has expired"
"Subscription expired on [date]"

// Don't mention technical details
"appAccountToken mismatch"
"originalTransactionId already linked"
"Webhook validation failed"

// Don't bypass Apple's system
"Subscribe on our website for cheaper prices"
"Contact support to transfer subscription"
```

---

## Error Handling Summary

| Server Response | User-Facing Message | Action |
|----------------|---------------------|--------|
| `ACCOUNT_MISMATCH` | "Would you like to restore your purchases?" | Prompt restore |
| `SUBSCRIPTION_LINKED_TO_OTHER_ACCOUNT` | "Use 'Restore Purchases' to access it" | Show restore button |
| `NO_ACTIVE_SUBSCRIPTION` | "No active subscription found" | Show subscribe button |
| `ITEM_ALREADY_OWNED` (Apple) | "Would you like to restore it?" | Prompt restore |
| `PAYMENT_CANCELLED` (Apple) | (Silent - no alert) | Return to screen |

---

## Testing Checklist

- [ ] "Restore Purchases" button visible in subscription screen
- [ ] "Restore Purchases" button visible in settings
- [ ] No mention of "transfer" or "account switching" to users
- [ ] Expired subscriptions show as "No active subscription"
- [ ] Terms of Service and Privacy Policy links present
- [ ] Subscription auto-renew terms displayed
- [ ] Prices shown from Apple's StoreKit (not hardcoded)
- [ ] Handles "already owned" error gracefully
- [ ] Handles user cancellation silently
- [ ] All alerts use Apple-compliant language

---

## App Store Review Tips

1. **Include "Restore Purchases"**: Apple requires this button to be easily accessible
2. **Show Subscription Terms**: Display auto-renewal terms clearly
3. **Handle Errors Gracefully**: Don't show technical errors to users
4. **Use Apple's Pricing**: Never show prices not from StoreKit
5. **Privacy Policy**: Link to your privacy policy before purchase
6. **No Alternative Payment**: Don't mention other ways to subscribe

---

## Additional Resources

- [Apple In-App Purchase Guidelines](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase)
- [Expo IAP Documentation](https://docs.expo.dev/versions/latest/sdk/in-app-purchases/)
- [StoreKit Best Practices](https://developer.apple.com/documentation/storekit)
