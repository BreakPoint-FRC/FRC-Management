-- Account.email is the platform-wide login identity, and every application
-- write path stores it trimmed and lowercase. Existing databases may predate
-- that contract, so normalize their rows before new code relies on canonical
-- lookups.
--
-- The current unique index is case-sensitive. Two rows such as
-- `Admin@example.test` and `admin@example.test` are therefore legal before
-- this migration but cannot both be normalized safely. Detect that state and
-- abort before changing any row so an operator can reconcile the identities.
DO $$
DECLARE
  normalized_collision_count integer;
BEGIN
  -- Serialize account writes across the collision check and backfill. The
  -- lock is released with this migration transaction.
  LOCK TABLE "Account" IN SHARE ROW EXCLUSIVE MODE;

  SELECT COUNT(*)
    INTO normalized_collision_count
    FROM (
      SELECT LOWER(BTRIM("email")) AS normalized_email
        FROM "Account"
       GROUP BY LOWER(BTRIM("email"))
      HAVING COUNT(*) > 1
    ) AS collisions;

  IF normalized_collision_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = FORMAT(
        'Cannot normalize Account.email: %s normalized address collision(s) found.',
        normalized_collision_count
      ),
      HINT = 'Resolve duplicate Account rows that differ only by surrounding spaces or letter case. If Prisma recorded this migration as failed, mark it rolled back with prisma migrate resolve before rerunning prisma migrate deploy.';
  END IF;

  UPDATE "Account"
     SET "email" = LOWER(BTRIM("email")),
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "email" IS DISTINCT FROM LOWER(BTRIM("email"));
END $$;
