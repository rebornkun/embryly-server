-- Remove the page/quota system (Embryly has no page limits).
--
-- The server no longer reads or writes page_limit / pages_used and no longer
-- calls create_subscription_grant / resetSubscriptionPages. Run this in the
-- Supabase SQL editor to clean up the database side.
--
-- IMPORTANT: review these two functions BEFORE dropping the columns, because
-- they are defined in the database (not visible in this repo):
--   * get_subscription_info(check_user_id)  -- STILL CALLED by the server.
--         If its RETURNS/SELECT references page_limit or pages_used, edit it
--         first so it stops returning those, otherwise it will error once the
--         columns are gone.
--   * create_subscription_grant(...)        -- no longer called; safe to drop.
--
-- The statements are commented out so you can run them deliberately.

-- 1. Drop the quota columns from user_subscriptions
-- ALTER TABLE public.user_subscriptions
--   DROP COLUMN IF EXISTS page_limit,
--   DROP COLUMN IF EXISTS pages_used;

-- 2. Drop the grant RPC (no longer used by the server)
-- DROP FUNCTION IF EXISTS public.create_subscription_grant(
--   uuid, text, integer, timestamptz, timestamptz
-- );
-- NOTE: adjust the argument types above to match the actual function signature.

-- 3. (Optional) If a subscription_grants table existed only to track page grants
--    and nothing else depends on it, drop it too:
-- DROP TABLE IF EXISTS public.subscription_grants;
