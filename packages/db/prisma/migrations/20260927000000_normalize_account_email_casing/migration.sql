-- Existing rows created before Account.email was normalized at the
-- application boundary (packages/types/src/accounts.ts's emailSchema,
-- packages/db/src/bootstrap.ts) may still hold mixed case or untrimmed
-- values. The column stays a plain case-sensitive unique text column --
-- normalizing here, once, is what makes "Admin@x.test" and "admin@x.test"
-- collide as the same account from now on instead of two rows nothing else
-- in the schema treats as related.
--
-- Two real, distinct accounts that already differ only by email casing
-- cannot both be silently renamed onto the same value -- that would corrupt
-- one of them by merging its identity into the other's without moving any
-- of its roles, tasks, or history along with it. Rather than guess which one
-- should win, any such collision is left untouched and reported via
-- RAISE NOTICE so a human resolves it by hand; every account whose
-- normalized form does not collide with another row is updated.
DO $$
DECLARE
  colliding RECORD;
BEGIN
  FOR colliding IN
    SELECT lower(trim(email)) AS normalized, array_agg(id ORDER BY "createdAt") AS account_ids
    FROM "Account"
    GROUP BY lower(trim(email))
    HAVING count(*) > 1
  LOOP
    RAISE NOTICE 'Skipping email normalization for %: accounts % already collide on this address and must be reconciled by hand.',
      colliding.normalized, colliding.account_ids;
  END LOOP;

  UPDATE "Account" a
  SET email = lower(trim(a.email))
  WHERE a.email <> lower(trim(a.email))
    AND NOT EXISTS (
      SELECT 1 FROM "Account" b
      WHERE b.id <> a.id AND lower(trim(b.email)) = lower(trim(a.email))
    );
END $$;
