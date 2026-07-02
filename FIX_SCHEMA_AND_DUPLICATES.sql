-- ========================================
-- FIX: Add UNIQUE Constraint to Prevent Duplicates
-- ========================================

-- Step 1: First, clean up any existing duplicates
-- (Run this BEFORE adding the UNIQUE constraint)

-- Find duplicates
SELECT 
  original_transaction_id,
  COUNT(*) as count,
  array_agg(user_id::text) as user_ids,
  array_agg(created_at) as created_dates
FROM user_subscriptions
WHERE original_transaction_id IS NOT NULL
GROUP BY original_transaction_id
HAVING COUNT(*) > 1;

-- For each duplicate, decide which to keep (keep the most recent)
-- and delete the others

-- Example: Delete all but the most recent for each original_transaction_id
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
  WHERE rn > 1
);

-- Step 2: Add UNIQUE constraint on original_transaction_id
-- This prevents future duplicates
ALTER TABLE user_subscriptions
ADD CONSTRAINT unique_original_transaction_id 
UNIQUE (original_transaction_id);

-- Step 3: Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_subs_original_transaction_id 
ON user_subscriptions(original_transaction_id) 
WHERE original_transaction_id IS NOT NULL;

-- ========================================
-- Verify the fix
-- ========================================

-- Should return 0 rows (no duplicates)
SELECT 
  original_transaction_id,
  COUNT(*) as count
FROM user_subscriptions
WHERE original_transaction_id IS NOT NULL
GROUP BY original_transaction_id
HAVING COUNT(*) > 1;

-- Check the constraint exists
SELECT 
  conname as constraint_name,
  contype as constraint_type
FROM pg_constraint
WHERE conrelid = 'user_subscriptions'::regclass
  AND conname = 'unique_original_transaction_id';
