-- Fixes a deployment that hit the self-lock closed by #39: the TOOLS row
-- could previously be turned off via PATCH/DELETE like any other module, and
-- authorize() refuses every "tool":"TOOLS" request -- including the one that
-- would turn it back on -- once its own row is inactive. The API guard now
-- rejects that write going forward; this repairs any environment where the
-- row was already left inactive before the guard existed.

UPDATE "Tool" SET "isActive" = true WHERE "key" = 'TOOLS';
