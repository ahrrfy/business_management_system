/**
 * اختبارات customerNoteService — CRUD ملاحظات متابعة العملاء + استعلام «تذكيرات اليوم».
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createCustomerNote,
  deleteCustomerNote,
  dueTodayCustomerNotes,
  listCustomerNotes,
  resolveCustomerNote,
  updateCustomerNote,
} from "../customerNoteService";

const actor = { userId: 1, branchId: 1 };

const TABLES = ["customerNotes", "customers", "users", "branches"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

function todayStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([{ id: 1, openId: "u1", name: "المدير", role: "manager", branchId: 1 }]);
  await d.insert(s.customers).values([
    { id: 1, name: "أحمد", customerType: "فرد" },
    { id: 2, name: "شركة النور", customerType: "شركة" },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("createCustomerNote", () => {
  it("مسار سعيد: يُنشئ ملاحظة بلا تاريخ متابعة", async () => {
    const r = await createCustomerNote({ customerId: 1, note: "اتصل ووعد بالدفع" }, actor);
    expect(r.customerId).toBe(1);
    const row = (await db().select().from(s.customerNotes).where(eq(s.customerNotes.id, r.id)))[0];
    expect(row.note).toBe("اتصل ووعد بالدفع");
    expect(row.followUpDate).toBeNull();
    expect(row.isResolved).toBe(false);
    expect(row.createdBy).toBe(1);
    expect(row.branchId).toBe(1);
  });

  it("مسار سعيد: يُنشئ ملاحظة بتاريخ متابعة ويُقصّ الفراغات من النص", async () => {
    const r = await createCustomerNote({ customerId: 1, note: "  متابعة تسليم  ", followUpDate: "2026-08-01" }, actor);
    const row = (await db().select().from(s.customerNotes).where(eq(s.customerNotes.id, r.id)))[0];
    expect(row.note).toBe("متابعة تسليم");
    expect(row.followUpDate).toBe("2026-08-01");
  });

  it("رفض: نص فارغ ⇒ BAD_REQUEST", async () => {
    await expect(createCustomerNote({ customerId: 1, note: "   " }, actor)).rejects.toThrow(/نص الملاحظة مطلوب/);
  });

  it("رفض: نص أطول من ٢٠٠٠ حرف ⇒ BAD_REQUEST", async () => {
    await expect(createCustomerNote({ customerId: 1, note: "أ".repeat(2001) }, actor)).rejects.toThrow(/طويل جداً/);
  });

  it("رفض: تاريخ متابعة بصيغة غير صالحة ⇒ BAD_REQUEST", async () => {
    await expect(createCustomerNote({ customerId: 1, note: "ملاحظة", followUpDate: "01-08-2026" }, actor)).rejects.toThrow(/تاريخ المتابعة غير صالح/);
  });

  it("رفض: عميل غير موجود ⇒ NOT_FOUND", async () => {
    await expect(createCustomerNote({ customerId: 999999, note: "ملاحظة" }, actor)).rejects.toThrow(/العميل غير موجود/);
  });
});

describe("listCustomerNotes", () => {
  it("يُرجع ملاحظات العميل المطلوب فقط، الأحدث أولاً، مع اسم المُنشئ", async () => {
    const a = await createCustomerNote({ customerId: 1, note: "الأولى" }, actor);
    const b = await createCustomerNote({ customerId: 1, note: "الثانية" }, actor);
    await createCustomerNote({ customerId: 2, note: "لعميل آخر" }, actor);

    const rows = await listCustomerNotes({ customerId: 1, includeResolved: true });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(b.id);
    expect(rows[1].id).toBe(a.id);
    expect(rows[0].createdByName).toBe("المدير");
  });

  it("includeResolved=false يُخفي الملاحظات المُنجَزة", async () => {
    const a = await createCustomerNote({ customerId: 1, note: "الأولى" }, actor);
    await resolveCustomerNote(a.id, true, actor);
    await createCustomerNote({ customerId: 1, note: "الثانية" }, actor);

    const rows = await listCustomerNotes({ customerId: 1, includeResolved: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("الثانية");
  });
});

describe("dueTodayCustomerNotes", () => {
  it("يُرجع الملاحظات غير المُنجَزة بتاريخ متابعة اليوم أو أقدم فقط، الأقدم أولاً", async () => {
    await createCustomerNote({ customerId: 1, note: "متأخرة", followUpDate: todayStr(-3) }, actor);
    await createCustomerNote({ customerId: 2, note: "اليوم", followUpDate: todayStr(0) }, actor);
    await createCustomerNote({ customerId: 1, note: "مستقبلية", followUpDate: todayStr(5) }, actor);
    await createCustomerNote({ customerId: 1, note: "بلا تاريخ" }, actor);

    const rows = await dueTodayCustomerNotes();
    expect(rows.map((r) => r.note)).toEqual(["متأخرة", "اليوم"]);
    expect(rows[0].customerName).toBe("أحمد");
  });

  it("يستثني الملاحظات المُنجَزة حتى لو تاريخها اليوم", async () => {
    const r = await createCustomerNote({ customerId: 1, note: "اليوم لكن مُنجَزة", followUpDate: todayStr(0) }, actor);
    await resolveCustomerNote(r.id, true, actor);
    const rows = await dueTodayCustomerNotes();
    expect(rows).toHaveLength(0);
  });
});

describe("updateCustomerNote", () => {
  it("تحديث جزئي: يغيّر تاريخ المتابعة فقط ويُبقي النص", async () => {
    const r = await createCustomerNote({ customerId: 1, note: "ملاحظة أصلية" }, actor);
    const res = await updateCustomerNote({ noteId: r.id, followUpDate: "2026-09-01" }, actor);
    expect(res.changed).toBe(true);
    const row = (await db().select().from(s.customerNotes).where(eq(s.customerNotes.id, r.id)))[0];
    expect(row.note).toBe("ملاحظة أصلية");
    expect(row.followUpDate).toBe("2026-09-01");
  });

  it("تمرير followUpDate=null يمسح تاريخ المتابعة", async () => {
    const r = await createCustomerNote({ customerId: 1, note: "ملاحظة", followUpDate: "2026-09-01" }, actor);
    await updateCustomerNote({ noteId: r.id, followUpDate: null }, actor);
    const row = (await db().select().from(s.customerNotes).where(eq(s.customerNotes.id, r.id)))[0];
    expect(row.followUpDate).toBeNull();
  });

  it("رفض: ملاحظة غير موجودة ⇒ NOT_FOUND", async () => {
    await expect(updateCustomerNote({ noteId: 999999, note: "أياً كان" }, actor)).rejects.toThrow(/الملاحظة غير موجودة/);
  });
});

describe("resolveCustomerNote", () => {
  it("يُغلق ثم يُعيد فتح الملاحظة (idempotent الاتجاهين)", async () => {
    const r = await createCustomerNote({ customerId: 1, note: "ملاحظة" }, actor);
    const closed = await resolveCustomerNote(r.id, true, actor);
    expect(closed).toEqual({ id: r.id, isResolved: true });
    const reopened = await resolveCustomerNote(r.id, false, actor);
    expect(reopened).toEqual({ id: r.id, isResolved: false });
  });

  it("رفض: ملاحظة غير موجودة ⇒ NOT_FOUND", async () => {
    await expect(resolveCustomerNote(999999, true, actor)).rejects.toThrow(/الملاحظة غير موجودة/);
  });
});

describe("deleteCustomerNote", () => {
  it("يحذف الملاحظة نهائياً", async () => {
    const r = await createCustomerNote({ customerId: 1, note: "للحذف" }, actor);
    await deleteCustomerNote(r.id, actor);
    const row = (await db().select().from(s.customerNotes).where(eq(s.customerNotes.id, r.id)))[0];
    expect(row).toBeUndefined();
  });

  it("رفض: ملاحظة غير موجودة ⇒ NOT_FOUND", async () => {
    await expect(deleteCustomerNote(999999, actor)).rejects.toThrow(/الملاحظة غير موجودة/);
  });
});
