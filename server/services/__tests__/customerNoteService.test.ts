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
  dueTodayCustomerNotesPage,
  listCustomerNotes,
  listCustomerNotesPage,
  resolveCustomerNote,
  updateCustomerNote,
} from "../customerNoteService";

const actor = { userId: 1, branchId: 1 };
const BRANCH_SCOPE = { branchId: 1 } as const;

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

    const rows = await listCustomerNotes({ customerId: 1, includeResolved: true }, BRANCH_SCOPE);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(b.id);
    expect(rows[1].id).toBe(a.id);
    expect(rows[0].createdByName).toBe("المدير");
  });

  it("includeResolved=false يُخفي الملاحظات المُنجَزة", async () => {
    const a = await createCustomerNote({ customerId: 1, note: "الأولى" }, actor);
    await resolveCustomerNote(a.id, true, actor);
    await createCustomerNote({ customerId: 1, note: "الثانية" }, actor);

    const rows = await listCustomerNotes({ customerId: 1, includeResolved: false }, BRANCH_SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("الثانية");
  });
  it("paginates and counts in SQL beyond the former 500-row ceiling, including q/date filters", async () => {
    await db().insert(s.customerNotes).values(
      Array.from({ length: 510 }, (_, index) => ({
        customerId: 1,
        note: index % 100 === 0 ? `needle-${index}` : `bulk-${index}`,
        followUpDate: null,
        isResolved: false,
        createdBy: 1,
        branchId: 1,
        createdAt: new Date(index % 2 === 0 ? "2026-08-10T12:00:00.000Z" : "2026-08-09T12:00:00.000Z"),
      })),
    );

    const tail = await listCustomerNotesPage(
      { customerId: 1, includeResolved: true, limit: 50, offset: 500 },
      BRANCH_SCOPE,
    );
    expect(tail.total).toBe(510);
    expect(tail.rows).toHaveLength(10);

    const filtered = await listCustomerNotesPage(
      { customerId: 1, includeResolved: true, q: "needle", from: "2026-08-10", to: "2026-08-10", limit: 20 },
      BRANCH_SCOPE,
    );
    expect(filtered.total).toBe(6);
    expect(filtered.rows).toHaveLength(6);
  });
});

describe("dueTodayCustomerNotes", () => {
  it("يُرجع الملاحظات غير المُنجَزة بتاريخ متابعة اليوم أو أقدم فقط، الأقدم أولاً", async () => {
    await createCustomerNote({ customerId: 1, note: "متأخرة", followUpDate: todayStr(-3) }, actor);
    await createCustomerNote({ customerId: 2, note: "اليوم", followUpDate: todayStr(0) }, actor);
    await createCustomerNote({ customerId: 1, note: "مستقبلية", followUpDate: todayStr(5) }, actor);
    await createCustomerNote({ customerId: 1, note: "بلا تاريخ" }, actor);

    const rows = await dueTodayCustomerNotes(BRANCH_SCOPE);
    expect(rows.map((r) => r.note)).toEqual(["متأخرة", "اليوم"]);
    expect(rows[0].customerName).toBe("أحمد");
  });

  it("يستثني الملاحظات المُنجَزة حتى لو تاريخها اليوم", async () => {
    const r = await createCustomerNote({ customerId: 1, note: "اليوم لكن مُنجَزة", followUpDate: todayStr(0) }, actor);
    await resolveCustomerNote(r.id, true, actor);
    const rows = await dueTodayCustomerNotes(BRANCH_SCOPE);
    expect(rows).toHaveLength(0);
  });
  it("switches at Baghdad midnight, keeps branch isolation, and exposes every due row beyond 200", async () => {
    await db().insert(s.branches).values({ id: 2, name: "Branch two", code: "B2", type: "SALES" });
    await db().insert(s.users).values({ id: 2, openId: "u2", name: "Manager two", role: "manager", branchId: 2 });
    await db().insert(s.customerNotes).values([
      { customerId: 1, note: "boundary-own", followUpDate: "2026-08-11", createdBy: 1, branchId: 1 },
      { customerId: 1, note: "boundary-other", followUpDate: "2026-08-11", createdBy: 2, branchId: 2 },
    ]);

    const before = await dueTodayCustomerNotesPage({}, BRANCH_SCOPE, new Date("2026-08-10T20:59:59.999Z"));
    expect(before).toMatchObject({ rows: [], total: 0 });

    const after = await dueTodayCustomerNotesPage({}, BRANCH_SCOPE, new Date("2026-08-10T21:00:00.000Z"));
    expect(after.total).toBe(1);
    expect(after.rows.map((row) => row.note)).toEqual(["boundary-own"]);

    await db().insert(s.customerNotes).values(
      Array.from({ length: 225 }, (_, index) => ({
        customerId: 1,
        note: `dense-${index}`,
        followUpDate: "2026-08-11",
        createdBy: 1,
        branchId: 1,
      })),
    );
    const page = await dueTodayCustomerNotesPage(
      { limit: 100, offset: 200 },
      BRANCH_SCOPE,
      new Date("2026-08-10T21:00:00.000Z"),
    );
    expect(page.total).toBe(226);
    expect(page.rows).toHaveLength(26);
    expect(page.rows.every((row) => row.branchId === 1)).toBe(true);

    const allPagedIds: number[] = [];
    for (let offset = 0; offset < page.total; offset += 75) {
      const current = await dueTodayCustomerNotesPage(
        { limit: 75, offset },
        BRANCH_SCOPE,
        new Date("2026-08-10T21:00:00.000Z"),
      );
      expect(current.total).toBe(226);
      allPagedIds.push(...current.rows.map((row) => row.id));
    }
    expect(allPagedIds).toHaveLength(226);
    expect(new Set(allPagedIds).size).toBe(226);

    const legacy = await dueTodayCustomerNotes(BRANCH_SCOPE, new Date("2026-08-10T21:00:00.000Z"));
    expect(legacy).toHaveLength(200);
    expect(legacy.some((row) => row.note === "boundary-other")).toBe(false);
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
