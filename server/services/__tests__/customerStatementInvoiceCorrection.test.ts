import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getARAging, getCustomerStatement } from "../reports/arAging";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

beforeEach(async () => {
  await truncateTables(["accountingEntries", "customers", "branches", "users"]);
  const db = getDb()!;
  await db.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db.insert(s.users).values({ id: 1, openId: "statement-correction", name: "المدير", role: "admin", branchId: 1 });
  await db.insert(s.customers).values({ id: 1, name: "عميل التصحيح", currentBalance: "70.00" });
  await db.insert(s.accountingEntries).values([
    { entryType: "OPENING", branchId: 1, customerId: 1, amount: "100.00", entryDate: new Date("2020-01-01T12:00:00Z") },
    { entryType: "ADJUST", branchId: 1, customerId: 1, amount: "-40.00", entryDate: new Date("2020-01-02T12:00:00Z"), dedupeKey: "INVOICE_CORRECTION_CUSTOMER_RECLASS:1:2:NEW", createdBy: 1 },
    { entryType: "DELIVERY_REMIT", branchId: 1, customerId: 1, amount: "10.00", entryDate: new Date("2020-01-03T12:00:00Z"), dedupeKey: "INVOICE_AMEND_CUSTODY:1:correction", createdBy: 1 },
    { entryType: "ADJUST", branchId: 1, customerId: 1, amount: "9000.00", entryDate: new Date("2020-01-03T12:00:00Z"), dedupeKey: "UNRELATED_ADJUSTMENT" },
  ]);
});

describe("أثر تصحيح الفاتورة في كشف العميل", () => {
  it("يعرض تسوية الذمة وتحرير عهدة التصحيح كمستندات غير نقدية ويتزن مع الرصيد", async () => {
    const statement = (await getCustomerStatement(1))!;
    expect(statement.payments).toHaveLength(2);
    const net = statement.payments.reduce((sum, entry) => sum.plus(money(entry.amount).times(entry.direction === "OUT" ? 1 : -1)), money(0));
    expect(money(statement.summary.openingBalance).plus(net).toFixed(2)).toBe("70.00");
    expect(statement.payments.every(entry => entry.createdBy === 1)).toBe(true);
    expect(statement.payments.every(entry => entry.paymentMethod === "INVOICE_ADJUSTMENT")).toBe(true);
    expect(statement.payments.every(entry => entry.provenance?.docRefs?.every(ref => ref.docType !== "receipt"))).toBe(true);
  });

  it("يرحّل الحركات السابقة للفترة ويعرضها مرة واحدة فقط داخل حدود الفترة", async () => {
    const later = (await getCustomerStatement(1, { from: "2021-01-01" }))!;
    expect(later.summary.openingBalance).toBe("70.00");
    expect(later.payments).toHaveLength(0);
    const during = (await getCustomerStatement(1, { from: "2020-01-02", to: "2020-01-03" }))!;
    expect(during.summary.openingBalance).toBe("100.00");
    expect(during.payments).toHaveLength(2);
  });

  it("يستخدم التعديلات المحددة المصدر وحدها في رصيد تقادم الفرع", async () => {
    expect(await getARAging({ branchId: 1 })).toMatchObject([{ customerId: 1, currentBalance: "70.00", unbucketed: "70.00" }]);
  });
});
