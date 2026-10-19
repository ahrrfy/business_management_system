import { tables as prior } from "../returns/schema";
import {
  createProjectionTables,
  projectionInitializationSql,
} from "../cash/schema";
export { quote } from "../cash/schema";
const additional = [
  "accounts",
  "journalEntries",
  "journalLines",
  "statutoryAccountingProfiles",
  "statutoryAccounts",
  "statutoryAccountMappings",
];
export const accountingTables = createProjectionTables(
  [...prior.map((t) => t.name), ...additional],
  true,
  ["salesControlRequests.activeInvoiceId", "returnRequests.activeInvoiceId"],
).filter((t) => additional.includes(t.name));
// Retain all established OFF table definitions byte for byte.
export const tables = [...prior, ...accountingTables];
export const initializationSql = projectionInitializationSql(tables, [
  "CREATE INDEX accounting_source_invoice ON accountingEntries(invoiceId);",
  "CREATE INDEX accounting_source_receipt ON accountingEntries(receiptId);",
  "CREATE INDEX accounting_journal_source ON journalEntries(entryId);",
  "CREATE INDEX accounting_lines_journal ON journalLines(journalId);",
]);
