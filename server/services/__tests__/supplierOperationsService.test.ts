import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getSupplierSummary } from "../supplierOperationsService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await d.execute(sql.raw("TRUNCATE TABLE `suppliers`"));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.suppliers).values([
    { id: 1, name: "مورد كبير", currentBalance: "5000", currentBalanceUsd: "100", supplierKind: "REGULAR", isActive: true },
    { id: 2, name: "مورد مدين", currentBalance: "-700", currentBalanceUsd: "-20", supplierKind: "REGULAR", isActive: true },
    { id: 3, name: "مودع أمانة", currentBalance: "300", currentBalanceUsd: "0", supplierKind: "CONSIGNOR", isActive: false },
  ]);
});

describe("getSupplierSummary", () => {
  it("يفصل المستحقات عن الأرصدة المدينة والعملتين", async () => {
    const result = await getSupplierSummary({ includeInactive: true });
    expect(result).toMatchObject({
      total: 3,
      active: 2,
      inactive: 1,
      regular: 2,
      consignors: 1,
      payableIqd: "5300.00",
      receivableIqd: "700.00",
      netIqd: "4600.00",
      payableUsd: "100.00",
      receivableUsd: "20.00",
      netUsd: "80.00",
      nonZeroBalances: 3,
      highestPayable: { supplierId: 1, supplierName: "مورد كبير", amount: "5000.00" },
    });
  });

  it("يحترم النوع وحالة التفعيل في الملخص", async () => {
    const active = await getSupplierSummary({});
    expect(active.total).toBe(2);
    expect(active.payableIqd).toBe("5000.00");

    const consignors = await getSupplierSummary({ includeInactive: true, kind: "CONSIGNOR" });
    expect(consignors.total).toBe(1);
    expect(consignors.payableIqd).toBe("300.00");
  });
});
