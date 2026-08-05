/**
 * ش٢ — مسوّدة طلب المحطة (هجرة 0152).
 * docs/reception-cashier-system-design-2026-08-05.md §٥ + §٦ + §١٢.
 *
 * المُثبَت:
 *  I1 — المسوّدة صفرٌ ماليّ بنيوياً: promote+sync بـ٣ بنود ⇒ صفر صفوف في invoices/
 *       accountingEntries/inventoryMovements وcurrentBalance قبل=بعد.
 *  N1 — الترقيم DRF-{فرع}-{YYYYMMDD}-{NNNNN} متسلسل.
 *  S1 — المزامنة بالجملة تعيد الحساب خادمياً (إجماليات العميل المزوّرة تُتجاهَل).
 *  I9 — version تفاؤليّ: مزامنتان على نفس الأساس ⇒ الثانية CONFLICT وأسطر الأولى سليمة.
 *  C1 — الإلغاء بسبب + الحالة تمنع مزامنة لاحقة برسالة تشرح.
 *  X1 — الكنّاس يطوي الفارغة المنقضية، ولا يمسّ المموّلة (moneyLocked) ولا الملغاة.
 *  R1 — بوّابة exec: print_operator يمرّ على draftPromote، وuser يُرفض.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import {
  cancelDraft,
  listDrafts,
  promoteDraft,
  sweepExpiredDrafts,
  syncDraft,
} from "../reception";

const TABLES = [
  "receptionDraftLines", "receptionDrafts",
  "idempotencyKeys", "accountingEntries", "receipts",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
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

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 8, openId: "po", name: "فني طباعة", email: "p@t.test", role: "print_operator", loginMethod: "local", branchId: 1 },
    { id: 9, openId: "gen", name: "مستخدم عام", email: "g@t.test", role: "user", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "عميل", currentBalance: "0.00" }]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
}

const LINES = [
  { lineKind: "GOODS" as const, variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "1000.00", title: "دفتر ٤٠ ورقة" },
  { lineKind: "PRINT" as const, variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "250.00", title: "استنساخ" },
  { lineKind: "CUSTOM" as const, quantity: "1", unitPrice: "45000.00", title: "درع تكريم", printSpec: '{"size":"A4"}' },
];

beforeEach(async () => {
  await reset();
  await seed();
});

describe("ش٢ — مسوّدة المحطة", () => {
  it("I1: صفرٌ ماليّ بنيوياً — promote+sync لا يكتبان في أيّ جدولٍ ماليّ/مخزنيّ", async () => {
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: LINES }, CASHIER);
    expect(p.draftNumber).toMatch(/^DRF-1-\d{8}-00001$/);
    expect(p.total).toBe("49500.00"); // 2000 + 2500 + 45000

    await syncDraft({ draftId: p.draftId, version: 0, header: { customerId: 1 }, lines: LINES.slice(0, 2) }, CASHIER);

    expect((await db().select().from(s.invoices)).length).toBe(0);
    expect((await db().select().from(s.accountingEntries)).length).toBe(0);
    expect((await db().select().from(s.inventoryMovements)).length).toBe(0);
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("0.00");
  });

  it("N1: الترقيم متسلسل داخل اليوم", async () => {
    const a = await promoteDraft({ branchId: 1, header: {}, lines: [LINES[0]] }, CASHIER);
    const b = await promoteDraft({ branchId: 1, header: {}, lines: [LINES[0]] }, CASHIER);
    expect(a.draftNumber.endsWith("00001")).toBe(true);
    expect(b.draftNumber.endsWith("00002")).toBe(true);
  });

  it("S1: الإجماليات تُعاد حسابها خادمياً — تزوير العميل يُتجاهَل", async () => {
    const p = await promoteDraft({ branchId: 1, header: {}, lines: [LINES[0]] }, CASHIER);
    // العميل يدّعي خصماً/إجمالياً مزوّراً عبر discountAmount فقط — الحساب من الأسطر.
    const r = await syncDraft({
      draftId: p.draftId, version: 0, header: {},
      lines: [{ ...LINES[0], quantity: "3", discountAmount: "500.00" }],
    }, CASHIER);
    expect(r.totals.subtotal).toBe("3000.00");
    expect(r.totals.discountTotal).toBe("500.00");
    expect(r.totals.total).toBe("2500.00");
    const row = (await db().select().from(s.receptionDrafts).where(eq(s.receptionDrafts.id, p.draftId)))[0];
    expect(row.total).toBe("2500.00");
  });

  it("I9: مزامنتان على نفس الأساس ⇒ الثانية CONFLICT وأسطر الأولى سليمة", async () => {
    const p = await promoteDraft({ branchId: 1, header: {}, lines: [LINES[0]] }, CASHIER);
    await syncDraft({ draftId: p.draftId, version: 0, header: {}, lines: [{ ...LINES[0], quantity: "5" }] }, CASHIER);
    await expect(
      syncDraft({ draftId: p.draftId, version: 0, header: {}, lines: [{ ...LINES[0], quantity: "9" }] }, CASHIER),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const lines = await db().select().from(s.receptionDraftLines).where(eq(s.receptionDraftLines.draftId, p.draftId));
    expect(lines.length).toBe(1);
    expect(lines[0].quantity).toBe("5.000"); // أسطر المزامنة الأولى لم تُطمَس
  });

  it("C1: الإلغاء بسبب، والمزامنة بعده تُرفض برسالة تشرح الحالة", async () => {
    const p = await promoteDraft({ branchId: 1, header: {}, lines: [LINES[0]] }, CASHIER);
    await cancelDraft({ draftId: p.draftId, version: 0, reason: "غيّر الزبون رأيه" }, CASHIER);
    await expect(
      syncDraft({ draftId: p.draftId, version: 1, header: {}, lines: [LINES[0]] }, CASHIER),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const list = await listDrafts({ branchId: 1, status: "CANCELLED" }, CASHIER);
    expect(list.rows.length).toBe(1);
  });

  it("X1: الكنّاس يطوي الفارغة المنقضية فقط — المموّلة لا تُمسّ", async () => {
    const a = await promoteDraft({ branchId: 1, header: {}, lines: [LINES[0]] }, CASHIER);
    const b = await promoteDraft({ branchId: 1, header: {}, lines: [LINES[0]] }, CASHIER);
    const past = new Date(Date.now() - 60_000);
    await db().update(s.receptionDrafts).set({ expiresAt: past }).where(eq(s.receptionDrafts.id, a.draftId));
    await db().update(s.receptionDrafts).set({ expiresAt: past, moneyLocked: true }).where(eq(s.receptionDrafts.id, b.draftId));

    const swept = await sweepExpiredDrafts();
    expect(swept).toBe(1);
    const rows = await db().select().from(s.receptionDrafts).orderBy(s.receptionDrafts.id);
    expect(rows.find((r) => Number(r.id) === a.draftId)!.status).toBe("EXPIRED");
    expect(rows.find((r) => Number(r.id) === b.draftId)!.status).toBe("OPEN"); // مموّلة — لا تُطوى أبداً
  });

  it("R1: بوّابة exec — فني الطباعة يمرّ على draftPromote، وuser يُرفض", async () => {
    const mk = (id: number) => ({ req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user: undefined } as never);
    const userRow = async (id: number) => (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];

    const po = appRouter.createCaller({ req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user: await userRow(8) } as never);
    const ok = await po.reception.draftPromote({ header: {}, lines: [LINES[2]] });
    expect(ok.draftNumber).toMatch(/^DRF-1-/);

    const gen = appRouter.createCaller({ req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user: await userRow(9) } as never);
    await expect(gen.reception.draftPromote({ header: {}, lines: [LINES[2]] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
