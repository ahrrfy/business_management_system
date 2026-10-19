import {
  tables as prior,
  initializationSql as priorInitializationSql,
} from "../returns/schema";
import { createProjectionTables } from "../cash/schema";
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
export const initializationSql = [
  priorInitializationSql,
  ...accountingTables.map((t) => t.ddl),
  "CREATE INDEX accounting_source_invoice ON accountingEntries(invoiceId);",
  "CREATE INDEX accounting_source_receipt ON accountingEntries(receiptId);",
  "CREATE INDEX accounting_journal_source ON journalEntries(entryId);",
  "CREATE INDEX accounting_lines_journal ON journalLines(journalId);",
].join("\n");
