import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getOpeningEntryAmount, upsertOpeningEntry } from "../openingBalance";
import { withTx } from "../tx";

/**
 * المسار ب-١ من ورقة الإصلاحات (١٦/٨): **إلحاقية الدفتر على الرصيد الافتتاحي**.
 *
 * `upsertOpeningEntry` كان يُجري `UPDATE` على مبلغ قيد OPENING و`DELETE` له عند التصفير ⇒
 * كشفُ حسابٍ مطبوعٌ بتاريخٍ سابق **لا يمكن إعادة إنتاجه**، والقيمة الأصلية لا توجد في أيّ
 * مكان: حركة حقوقٍ صامتة. والدفتر مصمَّم إلحاقياً (الإلغاء بقيدٍ تعويضيّ لا بحذف).
 *
 * والنظام نفسه يقول ذلك في `assertLegacyOpeningMutable` عند تفعيل الدفتر المزدوج:
 * «سجّل التصحيح بقيد فرقٍ جديد» — هذه الشريحة تجعله السلوك **دائماً**.
 */

function db() {
  const v = getDb();
  if (!v) throw new Error("DATABASE_URL not set for tests");
  return v;
}

const CUSTOMER = 71;

async function openingRows() {
  return db()
    .select({ id: s.accountingEntries.id, amount: s.accountingEntries.amount })
    .from(s.accountingEntries)
    .where(
      and(
        eq(s.accountingEntries.entryType, "OPENING"),
        eq(s.accountingEntries.customerId, CUSTOMER),
      ),
    );
}

async function openingSum(): Promise<string> {
  const r = await db()
    .select({ v: sql<string>`COALESCE(SUM(CAST(${s.accountingEntries.amount} AS DECIMAL(15,2))), 0)` })
    .from(s.accountingEntries)
    .where(
      and(
        eq(s.accountingEntries.entryType, "OPENING"),
        eq(s.accountingEntries.customerId, CUSTOMER),
      ),
    );
  return String(r[0]?.v ?? "0");
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["accountingEntries", "customers", "users", "branches"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values({ id: 1, name: "Main", code: "MAIN", type: "MAIN" });
  await d.insert(s.customers).values({ id: CUSTOMER, name: "زبون الرصيد الافتتاحي" });
});

describe("المسار ب-١ — الرصيد الافتتاحي إلحاقيّ لا يُمحى", () => {
  it("التعديل يُضيف قيد فرقٍ ولا يمسّ القيد الأصليّ", async () => {
    await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "100000"));
    const first = await openingRows();
    expect(first).toHaveLength(1);
    const originalId = Number(first[0].id);

    await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "60000"));
    const after = await openingRows();

    // إلحاقيّ: صفّان — الأصل كما هو، وفرقٌ −٤٠٬٠٠٠.
    expect(after).toHaveLength(2);
    const original = after.find((r) => Number(r.id) === originalId);
    expect(original).toBeTruthy();
    expect(String(original!.amount)).toBe("100000.00");
    expect(await openingSum()).toBe("60000.00");
  });

  it("التصفير لا يحذف شيئاً — يُقيّد فرقاً معاكساً", async () => {
    await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "100000"));
    await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "0"));

    const rows = await openingRows();
    expect(rows).toHaveLength(2); // لا DELETE إطلاقاً
    expect(rows.some((r) => String(r.amount) === "100000.00")).toBe(true);
    expect(await openingSum()).toBe("0.00");
  });

  it("القيمة التاريخية تبقى قابلة لإعادة الإنتاج بعد التعديل", async () => {
    await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "100000"));
    const before = await openingRows();
    const cutoffId = Number(before[0].id);

    await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "25000"));

    // كشفٌ «كما كان» = مجموع القيود حتى القيد المرجعيّ ⇒ يعيد ١٠٠٬٠٠٠ الأصلية.
    const asOf = await db()
      .select({ v: sql<string>`COALESCE(SUM(CAST(${s.accountingEntries.amount} AS DECIMAL(15,2))), 0)` })
      .from(s.accountingEntries)
      .where(
        and(
          eq(s.accountingEntries.entryType, "OPENING"),
          eq(s.accountingEntries.customerId, CUSTOMER),
          sql`${s.accountingEntries.id} <= ${cutoffId}`,
        ),
      );
    expect(String(asOf[0]?.v)).toBe("100000.00");
  });

  it("شاشة التعديل تقرأ المجموع لا أوّل صفّ", async () => {
    await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "100000"));
    await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "60000"));
    // لولا الجمع لأعادت ١٠٠٬٠٠٠ (أوّل صفّ) فيُعدّل المدير على قيمةٍ خاطئة.
    const shown = await withTx((tx) => getOpeningEntryAmount(tx, "CUSTOMER", CUSTOMER));
    expect(shown).toBe("60000.00");
  });

  it("الفارق المُعاد يبقى صحيحاً (يُطبَّق على currentBalance)", async () => {
    const a = await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "100000"));
    expect(a.delta).toBe("100000.00");
    const b = await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "60000"));
    expect(b.delta).toBe("-40000.00");
    const c = await withTx((tx) => upsertOpeningEntry(tx, "CUSTOMER", CUSTOMER, "60000"));
    expect(c.delta).toBe("0.00"); // لا تغيير ⇒ لا قيد جديد
    expect(await openingRows()).toHaveLength(2);
  });
});
