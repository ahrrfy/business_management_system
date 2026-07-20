// idempotency إنشاء المورّد (clientRequestId + القيد الفريد 0090) — مرآة اختبارات
// createCustomer في customerDuplicate.test.ts: نفس المفتاح مرّتين ⇒ صفٌّ واحد وقيد OPENING واحد.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSupplier } from "../supplierService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries",
  "purchaseOrderItems",
  "purchaseOrders",
  "suppliers",
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
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({
    id: 1,
    openId: "local_test",
    name: "admin",
    role: "admin",
    loginMethod: "local",
  });
}

async function countSuppliers() {
  const r = (await db().execute(sql`SELECT COUNT(*) AS n FROM suppliers`)) as any;
  return Number(r[0][0].n);
}

async function countAccountingEntries() {
  const r = (await db().execute(sql`SELECT COUNT(*) AS n FROM accountingEntries`)) as any;
  return Number(r[0][0].n);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("createSupplier idempotency (clientRequestId)", () => {
  it("نفس المفتاح مرّتين ⇒ نفس المورّد وصفٌّ واحد لا اثنان", async () => {
    const r1 = await createSupplier({ name: "مكتبة الرشيد", clientRequestId: "req-supp-1111" }, actor);
    expect(r1.idempotentReplay).toBe(false);

    const r2 = await createSupplier({ name: "مكتبة الرشيد", clientRequestId: "req-supp-1111" }, actor);
    expect(r2.supplierId).toBe(r1.supplierId);
    expect(r2.id).toBe(r1.supplierId);
    expect(r2.idempotentReplay).toBe(true);
    expect(await countSuppliers()).toBe(1);
  });

  it("مفتاحان مختلفان بنفس الاسم ⇒ مورّدان (لا حجب بالاسم)", async () => {
    const r1 = await createSupplier({ name: "شركة الأمانة", clientRequestId: "req-supp-aaaa" }, actor);
    const r2 = await createSupplier({ name: "شركة الأمانة", clientRequestId: "req-supp-bbbb" }, actor);
    expect(r2.supplierId).not.toBe(r1.supplierId);
    expect(await countSuppliers()).toBe(2);
  });

  it("بلا مفتاح (المسارات القديمة/الاستيراد) ⇒ السلوك السابق بلا تغيير", async () => {
    const r1 = await createSupplier({ name: "شركة الأمانة" }, actor);
    const r2 = await createSupplier({ name: "شركة الأمانة" }, actor);
    expect(r2.supplierId).not.toBe(r1.supplierId);
    expect(r1.idempotentReplay).toBe(false);
    expect(await countSuppliers()).toBe(2);
  });

  it("إعادة التشغيل لا تكرّر قيد OPENING ولا تمسّ الرصيد", async () => {
    const input = {
      name: "مورّد برصيد",
      openingBalance: "5000",
      openingBalanceDirection: "OWED_BY_US" as const,
      clientRequestId: "req-supp-opening",
    };
    const r1 = await createSupplier(input, actor);
    expect(await countAccountingEntries()).toBe(1);

    const r2 = await createSupplier(input, actor);
    expect(r2.supplierId).toBe(r1.supplierId);
    expect(r2.idempotentReplay).toBe(true);
    expect(await countAccountingEntries()).toBe(1);

    // المورّد: موجب = «علينا له» (§٥ — إشارة منقلبة عن العميل).
    const row = (await db().execute(
      sql`SELECT currentBalance FROM suppliers WHERE id = ${r1.supplierId}`,
    )) as any;
    expect(String(row[0][0].currentBalance)).toBe("5000.00");
  });

  it("تحقّق التكرار على الهاتف لا يُطبَّق على إعادة التشغيل (المفتاح يسبق فحص الهاتف)", async () => {
    const input = { name: "مورّد بهاتف", phone: "07701234567", clientRequestId: "req-supp-phone" };
    const r1 = await createSupplier(input, actor);
    const r2 = await createSupplier(input, actor);
    expect(r2.supplierId).toBe(r1.supplierId);
    expect(r2.idempotentReplay).toBe(true);
    expect(await countSuppliers()).toBe(1);
  });

  it("سباقان متزامنان بنفس المفتاح ⇒ صفٌّ واحد (القيد الفريد يحسم)", async () => {
    const input = { name: "مورّد متزامن", clientRequestId: "req-supp-race" };
    const [a, b] = await Promise.all([
      createSupplier(input, actor),
      createSupplier(input, actor),
    ]);
    expect(a.supplierId).toBe(b.supplierId);
    expect(await countSuppliers()).toBe(1);
  });
});
