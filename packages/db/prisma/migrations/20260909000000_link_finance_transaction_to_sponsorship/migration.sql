-- Links a FinanceTransaction to the Sponsorship it was booked for (issue #26).
--
-- Nullable: every existing row is untouched and stays NULL -- a finance
-- record does not have to come from a sponsorship conversion.
-- Unique: the database, not application code, is what guarantees at most one
-- finance record per sponsorship, including under two concurrent requests.
-- Restrict: a sponsorship with income already booked against it cannot be
-- deleted out from under that finance record.
ALTER TABLE "FinanceTransaction" ADD COLUMN     "sponsorshipId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "FinanceTransaction_sponsorshipId_key" ON "FinanceTransaction"("sponsorshipId");

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_sponsorshipId_fkey" FOREIGN KEY ("sponsorshipId") REFERENCES "Sponsorship"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
