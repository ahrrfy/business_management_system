import { sql } from "drizzle-orm";

/** Closing/reopening transfers remain in the ledger, outside the period's trading result. */
export function financialActivityJournalSql() {
  return sql`AND (je.sourceType IS NULL OR je.sourceType <> 'SHADOW_OPENING')
    AND (je.postingProfile IS NULL OR je.postingProfile NOT IN ('ADJUST_YEAR_CLOSE','ADJUST_YEAR_CLOSE_ZERO'))`;
}
