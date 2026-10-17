import { tables, quote } from "./schema";
export const fixtureSql =
  `
INSERT INTO branches(id,name,code,branchType) VALUES(1,'Synthetic MAIN','MAIN','MAIN');
INSERT INTO users(id,openId,name,role,loginMethod,branchId) VALUES(1,'cash-fixture','Synthetic Cashier','cashier','local',1);
INSERT INTO monthCloseSequence(id,monthCloseSequenceStatus,version) VALUES(1,'NEEDS_BOOTSTRAP',0);
INSERT INTO shifts(id,userId,branchId,shiftStatus,shiftType,openingBalance,openGuard) VALUES(1,1,1,'OPEN','RETAIL','0.00','1:1:RETAIL');
INSERT INTO products(id,name) VALUES(1,'Synthetic Stock A'),(2,'Synthetic Stock B');
INSERT INTO productVariants(id,productId,sku,costPrice) VALUES(1,1,'CASH-A','50.00'),(2,2,'CASH-B','30.00');
INSERT INTO productUnits(id,variantId,unitName,conversionFactor,isBaseUnit) VALUES(1,1,'piece','1.0000',1),(2,2,'piece','1.0000',1);
INSERT INTO productPrices(id,productUnitId,priceTier,price) VALUES(1,1,'RETAIL','100.00'),(2,2,'RETAIL','80.00');
INSERT INTO branchStock(id,variantId,branchId,quantity) VALUES(1,1,1,100),(2,2,1,50);
INSERT INTO doubleEntrySettings(id,mode) VALUES(1,'OFF');
UPDATE cashEpoch SET epoch=epoch+1 WHERE id=1;
` +
  tables
    .map((t) => {
      const cols = t.columns.filter(
        (c) => c.defaultSql === "CURRENT_TIMESTAMP",
      );
      return cols.length
        ? "UPDATE " +
            quote(t.name) +
            " SET " +
            cols
              .map((c) => quote(c.name) + "='2026-10-17 00:00:00'")
              .join(",") +
            ";"
        : "";
    })
    .join("\n");
export const fixtureActor = { userId: 1, branchId: 1, role: "cashier" };
export const fixtureInput = {
  branchId: 1,
  shiftId: 1,
  sourceType: "POS",
  clientRequestId: "actual-cash-1",
  lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }],
  payment: { amount: "200", method: "CASH" },
};
