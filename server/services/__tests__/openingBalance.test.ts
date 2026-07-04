import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createCustomer } from "../customerService";
import { createSupplier } from "../supplierService";
import { signedOpeningBalance } from "../openingBalance";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries",
  "receipts",
  "invoiceItems",
  "invoices",
  "purchaseOrders",
  "customers",
  "suppliers",
  "financialPeriods",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

/** يجلب قيد OPENING للطرف (إن وُجد). */
async function openingEntry(party: "CUSTOMER" | "SUPPLIER", id: number) {
  const col = party === "CUSTOMER" ? s.accountingEntries.customerId : s.accountingEntries.supplierId;
  return (
    await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "OPENING"), eq(col, id)))
      .limit(1)
  )[0];
}

describe("signedOpeningBalance (وحدة)", () => {
  it("العميل: «لنا» موجب، «علينا» سالب", () => {
    expect(signedOpeningBalance("CUSTOMER", "1000", "OWED_TO_US")).toBe("1000.00");
    expect(signedOpeningBalance("CUSTOMER", "1000", "OWED_BY_US")).toBe("-1000.00");
  });

  it("المورّد: الإشارة منقلبة — «علينا له» موجب، «لنا عليه» سالب", () => {
    expect(signedOpeningBalance("SUPPLIER", "1000", "OWED_BY_US")).toBe("1000.00");
    expect(signedOpeningBalance("SUPPLIER", "1000", "OWED_TO_US")).toBe("-1000.00");
  });

  it("صفر/فارغ/null ⇒ '0.00' (لا رصيد)", () => {
    expect(signedOpeningBalance("CUSTOMER", "0", "OWED_TO_US")).toBe("0.00");
    expect(signedOpeningBalance("CUSTOMER", "", "OWED_TO_US")).toBe("0.00");
    expect(signedOpeningBalance("CUSTOMER", null, "OWED_TO_US")).toBe("0.00");
    expect(signedOpeningBalance("SUPPLIER", undefined, "OWED_BY_US")).toBe("0.00");
  });

  it("يقرّب لمنزلتين ويرفض غير الرقمي", () => {
    expect(signedOpeningBalance("CUSTOMER", "1234.5", "OWED_TO_US")).toBe("1234.50");
    expect(() => signedOpeningBalance("CUSTOMER", "abc", "OWED_TO_US")).toThrow();
    expect(() => signedOpeningBalance("CUSTOMER", "-5", "OWED_TO_US")).toThrow();
  });
});

describe("createCustomer — رصيد افتتاحي", () => {
  it("«لنا على العميل» ⇒ currentBalance موجب + قيد OPENING مطابق", async () => {
    const { customerId } = await createCustomer(
      { name: "عميل مدين", openingBalance: "750000", openingBalanceDirection: "OWED_TO_US" },
      actor,
    );
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, customerId)).limit(1))[0];
    expect(c.currentBalance).toBe("750000.00");
    const e = await openingEntry("CUSTOMER", customerId);
    expect(e).toBeTruthy();
    expect(e.amount).toBe("750000.00");
    expect(e.entryType).toBe("OPENING");
    expect(e.dedupeKey).toBe(`OPENING:CUSTOMER:${customerId}`);
    expect(e.revenue).toBe("0.00");
    expect(e.profit).toBe("0.00");
  });

  it("«للعميل علينا» (رصيد دائن) ⇒ currentBalance سالب + قيد OPENING سالب", async () => {
    const { customerId } = await createCustomer(
      { name: "عميل دائن", openingBalance: "200000", openingBalanceDirection: "OWED_BY_US" },
      actor,
    );
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, customerId)).limit(1))[0];
    expect(c.currentBalance).toBe("-200000.00");
    const e = await openingEntry("CUSTOMER", customerId);
    expect(e.amount).toBe("-200000.00");
  });

  it("بلا رصيد افتتاحي ⇒ currentBalance '0.00' وبلا قيد OPENING", async () => {
    const { customerId } = await createCustomer({ name: "بلا رصيد" }, actor);
    const c = (await db().select().from(s.customers).where(eq(s.customers.id, customerId)).limit(1))[0];
    expect(c.currentBalance).toBe("0.00");
    expect(await openingEntry("CUSTOMER", customerId)).toBeUndefined();
  });

  it("رصيد صفر صريح ⇒ بلا قيد OPENING", async () => {
    const { customerId } = await createCustomer(
      { name: "صفر", openingBalance: "0", openingBalanceDirection: "OWED_TO_US" },
      actor,
    );
    expect(await openingEntry("CUSTOMER", customerId)).toBeUndefined();
  });
});

describe("createSupplier — رصيد افتتاحي", () => {
  it("«علينا للمورّد» ⇒ currentBalance موجب + قيد OPENING مطابق", async () => {
    const { supplierId } = await createSupplier(
      { name: "مورّد دائن", openingBalance: "500000", openingBalanceDirection: "OWED_BY_US" },
      actor,
    );
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0];
    expect(sup.currentBalance).toBe("500000.00");
    const e = await openingEntry("SUPPLIER", supplierId);
    expect(e).toBeTruthy();
    expect(e.amount).toBe("500000.00");
    expect(e.dedupeKey).toBe(`OPENING:SUPPLIER:${supplierId}`);
  });

  it("«لنا على المورّد» (دفعة مقدّمة) ⇒ currentBalance سالب", async () => {
    const { supplierId } = await createSupplier(
      { name: "مورّد مدين", openingBalance: "125000", openingBalanceDirection: "OWED_TO_US" },
      actor,
    );
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0];
    expect(sup.currentBalance).toBe("-125000.00");
    const e = await openingEntry("SUPPLIER", supplierId);
    expect(e.amount).toBe("-125000.00");
  });

  it("بلا رصيد ⇒ '0.00' وبلا قيد", async () => {
    const { supplierId } = await createSupplier({ name: "بلا رصيد" }, actor);
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, supplierId)).limit(1))[0];
    expect(sup.currentBalance).toBe("0.00");
    expect(await openingEntry("SUPPLIER", supplierId)).toBeUndefined();
  });
});
