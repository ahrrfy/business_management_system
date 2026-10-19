import { creditProjectionSql } from "../returns/state";
import { accountingTables } from "./schema";
import { rowJsonSql } from "../cash/cash-state";
// Complete static account/profile/map policy; financial history only for target invoice.
const source =
  "SELECT id FROM accountingEntries WHERE invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope) OR receiptId IN(SELECT id FROM receipts WHERE invoiceId=(SELECT json_extract(j,'$.input.invoiceId') FROM cashScope))";
const journal =
  "SELECT id FROM journalEntries WHERE entryId IN(" + source + ")";
const policy: Record<string, string> = {
  accounts: "1",
  statutoryAccountingProfiles: "1",
  statutoryAccounts: "1",
  statutoryAccountMappings: "1",
  journalEntries: "id IN(" + journal + ")",
  journalLines: "journalId IN(" + journal + ")",
};
const additional = accountingTables
  .map(
    (t) =>
      "(SELECT json_group_array(json(rowJson)) FROM(SELECT " +
      rowJsonSql(t.columns.map((c) => c.name)) +
      " rowJson FROM `" +
      t.name +
      "` WHERE " +
      policy[t.name] +
      " ORDER BY " +
      t.primary.map((c) => "`" + c + "`").join(",") +
      ")) AS `" +
      t.name +
      "`",
  )
  .join(",");
export const accountingProjectionSql = creditProjectionSql
  .replace(
    " FROM cashEpoch WHERE id=1",
    "," + additional + " FROM cashEpoch WHERE id=1",
  )
  .replace(
    "name IN(",
    "name IN('accounts','journalEntries','journalLines','statutoryAccountingProfiles','statutoryAccounts','statutoryAccountMappings',",
  );
