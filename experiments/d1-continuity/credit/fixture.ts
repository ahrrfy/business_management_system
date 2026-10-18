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
// Additive isolated baseline extension, installed identically on source and
// restore. It never resets stock, balances, commands or journal history.
export const multiCashierFixtureSql =
  [11, 12, 13, 14]
    .map(
      (id) =>
        `INSERT INTO users(id,openId,name,role,loginMethod,branchId) VALUES(${id},'credit-lab-${id}','Synthetic Credit Cashier ${id}','cashier','local',1);` +
        `INSERT INTO shifts(id,userId,branchId,shiftStatus,shiftType,openingBalance,openGuard) VALUES(${id},${id},1,'OPEN','RETAIL','0.00','1:${id}:RETAIL');`,
    )
    .join("\n") +
  tables
    .filter((t) => ["users", "shifts"].includes(t.name))
    .map((t) => {
      const columns = t.columns.filter(
        (c) => c.defaultSql === "CURRENT_TIMESTAMP",
      );
      return columns.length
        ? "\nUPDATE " +
            quote(t.name) +
            " SET " +
            columns
              .map((c) => quote(c.name) + "='2026-10-18 00:00:00'")
              .join(",") +
            " WHERE id IN(11,12,13,14);"
        : "";
    })
    .join("");
export function creditActor(request: Request, env: any) {
  if (env.TEST_ACTOR) return env.TEST_ACTOR;
  const terminal = request.headers.get("x-credit-lab-terminal");
  if (!terminal) return fixtureActor;
  if (env.CREDIT_MULTI_CASHIER_LAB !== "1" || !/^(11|12|13|14)$/.test(terminal))
    throw Object.assign(Error("INVALID_LAB_TERMINAL"), { status: 400 });
  return { userId: Number(terminal), branchId: 1, role: "cashier" };
}
export const fixtureInput = {
  commandType: "SALE",
  branchId: 1,
  shiftId: 1,
  sourceType: "POS",
  customerId: 1,
  clientRequestId: "credit-fixture-sale",
  lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
};
