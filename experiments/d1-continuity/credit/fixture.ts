import { fixtureSql as cashFixture } from "../cash/fixture";
import { tables, quote } from "./schema";
export const fixtureSql =
  cashFixture +
  `\nINSERT INTO customers(id,name,creditLimit,currentBalance) VALUES(1,'Synthetic Credit Buyer','1000.00','0.00'),(2,'Synthetic Limited Buyer','150.00','0.00'),(3,'Synthetic Prior Credit','1000.00','-40.00'),(4,'Synthetic Cash Only','0.00','0.00'),(5,'Synthetic Unlimited',NULL,'0.00');\n` +
  tables
    .map((t) => {
      const c = t.columns.filter((c) => c.defaultSql === "CURRENT_TIMESTAMP");
      return c.length
        ? "UPDATE " +
            quote(t.name) +
            " SET " +
            c.map((c) => quote(c.name) + "='2026-10-18 00:00:00'").join(",") +
            ";"
        : "";
    })
    .join("\n") +
  "\nUPDATE customers SET searchNorm=lower(name);";
// MySQL has a STORED generated search column. Native D1 uses the same known
// synthetic fixture values; this lab exposes no customer-edit operation.
export const fixtureActor = { userId: 1, branchId: 1, role: "cashier" };
export const fixtureInput = {
  commandType: "SALE",
  branchId: 1,
  shiftId: 1,
  sourceType: "POS",
  customerId: 1,
  clientRequestId: "credit-fixture-sale",
  lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
};
