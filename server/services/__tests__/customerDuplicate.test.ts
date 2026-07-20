// dup-detect (٦/٧): اختبارات idempotency إنشاء العميل (clientRequestId + قيد 0051 الفريد)
// وكشف التكرار الحيّ findSimilarCustomers (اسم مطبَّع عربياً + لاحقة هاتف + شمول المعطَّلين).
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createCustomer,
  deactivateCustomer,
  findSimilarCustomers,
} from "../customerService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "accountingEntries",
  "receipts",
  "invoiceItems",
  "invoices",
  "customers",
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

async function countCustomers() {
  const r = (await db().execute(sql`SELECT COUNT(*) AS n FROM customers`)) as any;
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

describe("createCustomer idempotency (clientRequestId)", () => {
  it("نفس المفتاح مرّتين ⇒ نفس العميل وصفٌّ واحد لا اثنان", async () => {
    const r1 = await createCustomer({ name: "أحمد التميمي", clientRequestId: "req-11111111" }, actor);
    expect(r1.idempotentReplay).toBe(false);

    const r2 = await createCustomer({ name: "أحمد التميمي", clientRequestId: "req-11111111" }, actor);
    expect(r2.customerId).toBe(r1.customerId);
    expect(r2.idempotentReplay).toBe(true);
    expect(await countCustomers()).toBe(1);
  });

  it("مفتاحان مختلفان بنفس الاسم ⇒ عميلان (لا حجب بالاسم)", async () => {
    const r1 = await createCustomer({ name: "أحمد التميمي", clientRequestId: "req-aaaaaaaa" }, actor);
    const r2 = await createCustomer({ name: "أحمد التميمي", clientRequestId: "req-bbbbbbbb" }, actor);
    expect(r2.customerId).not.toBe(r1.customerId);
    expect(await countCustomers()).toBe(2);
  });

  it("بلا مفتاح (المسارات القديمة) ⇒ السلوك السابق بلا تغيير", async () => {
    const r1 = await createCustomer({ name: "أحمد التميمي" }, actor);
    const r2 = await createCustomer({ name: "أحمد التميمي" }, actor);
    expect(r2.customerId).not.toBe(r1.customerId);
    expect(await countCustomers()).toBe(2);
  });

  it("إعادة التشغيل لا تكرّر قيد OPENING ولا تمسّ الرصيد", async () => {
    const input = {
      name: "عميل برصيد",
      openingBalance: "5000",
      openingBalanceDirection: "OWED_TO_US" as const,
      clientRequestId: "req-opening-1",
    };
    const r1 = await createCustomer(input, actor);
    expect(await countAccountingEntries()).toBe(1);

    const r2 = await createCustomer(input, actor);
    expect(r2.customerId).toBe(r1.customerId);
    expect(r2.idempotentReplay).toBe(true);
    expect(await countAccountingEntries()).toBe(1);

    const row = (await db().execute(
      sql`SELECT currentBalance FROM customers WHERE id = ${r1.customerId}`,
    )) as any;
    expect(String(row[0][0].currentBalance)).toBe("5000.00");
  });
});

describe("findSimilarCustomers (كشف التكرار الحيّ)", () => {
  async function seedCustomers() {
    const a = await createCustomer(
      { name: "أحمد الأزرق", phone: "+9647701234567" },
      actor,
    );
    const b = await createCustomer(
      { name: "منى الياسري", phone: "+9647809876543" },
      actor,
    );
    return { a: a.customerId, b: b.customerId };
  }

  it("الاسم يطابق مطبَّعاً عربياً: «ازرق» يجد «الأزرق»", async () => {
    const { a } = await seedCustomers();
    const rows = await findSimilarCustomers({ name: "ازرق" });
    expect(rows.map((r) => r.id)).toContain(a);
    expect(rows.find((r) => r.id === a)?.matchedOn).toBe("name");
  });

  it("الهاتف بصيغة محلية 07xx يجد المخزَّن دولياً +9647xx (لاحقة)", async () => {
    const { a, b } = await seedCustomers();
    const rows = await findSimilarCustomers({ phones: ["0770 123 4567"] });
    expect(rows.map((r) => r.id)).toContain(a);
    expect(rows.map((r) => r.id)).not.toContain(b);
    expect(rows.find((r) => r.id === a)?.matchedOn).toBe("phone");
  });

  it("تطابق الاسم والهاتف معاً ⇒ matchedOn=both", async () => {
    const { a } = await seedCustomers();
    const rows = await findSimilarCustomers({ name: "الازرق", phones: ["07701234567"] });
    expect(rows.find((r) => r.id === a)?.matchedOn).toBe("both");
  });

  it("يشمل العملاء المعطَّلين (أهم تحذير: موجود لكنه معطَّل)", async () => {
    const { a } = await seedCustomers();
    await deactivateCustomer(a, actor);
    const rows = await findSimilarCustomers({ name: "الأزرق" });
    const hit = rows.find((r) => r.id === a);
    expect(hit).toBeTruthy();
    expect(hit?.isActive).toBe(false);
  });

  it("مدخل قصير/فارغ ⇒ لا استعلام ولا نتائج", async () => {
    await seedCustomers();
    expect(await findSimilarCustomers({})).toEqual([]);
    expect(await findSimilarCustomers({ name: "أ" })).toEqual([]);
    expect(await findSimilarCustomers({ phones: ["077"] })).toEqual([]);
  });

  it("لا مطابقة زائفة لاسم/هاتف مختلفين", async () => {
    await seedCustomers();
    const rows = await findSimilarCustomers({ name: "كاظم", phones: ["0751 000 0000"] });
    expect(rows).toEqual([]);
  });

  // ترقية ٢٠/٧: أغلبية الكلمات بدل السلسلة المتصلة — حالتان كانت المطابقة القديمة تفوّتهما.
  it("ترتيب كلمات مختلف يُمسَك: «النور مكتبة» تجد «مكتبة النور الحديثة»", async () => {
    const c = await createCustomer({ name: "مكتبة النور الحديثة" }, actor);
    const rows = await findSimilarCustomers({ name: "النور مكتبة" });
    const hit = rows.find((r) => r.id === c.customerId);
    expect(hit).toBeTruthy();
    expect(hit?.matchedOn).toBe("name");
  });

  it("اسم مكتوب أطول من المخزَّن يُمسَك بالأغلبية: «مكتبة النور الحديثة» تجد «مكتبة النور»", async () => {
    const c = await createCustomer({ name: "مكتبة النور" }, actor);
    const rows = await findSimilarCustomers({ name: "مكتبة النور الحديثة" });
    expect(rows.map((r) => r.id)).toContain(c.customerId);
  });
});
