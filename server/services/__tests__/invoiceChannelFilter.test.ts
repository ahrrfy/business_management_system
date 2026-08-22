/**
 * فلتر قناة الفاتورة (١٩/٨) — بلاغ المالك «لا تمييز بصريّ لقناة الفاتورة».
 *
 * الثابت المحروس: **شرط SQL في `buildSalesListConds` ≡ اشتقاق `deriveInvoiceChannel`**
 * المشترك حرفياً. حارسٌ يقرأ من مصدرٍ غير الذي ينفّذ عليه ليس حارساً — فالاختبار يُنشئ
 * الصفوف الأربعة، ثم يقارن **مجموعةَ ما يُرجعه الخادم** بـ**مجموعة ما يشتقّه الملفّ المشترك**
 * على نفس الصفوف. أيّ انجرافٍ بينهما يُحمِّر هذا الملف فوراً.
 *
 * والحالة الحدّية المقصودة: أمرُ شغلٍ سُلّم من وردية **طباعة** يبقى «استقبالاً» — مصدرُه
 * أقوى من ورديّة من سلّمه (وإلّا اختفت طلبات الاستقبال من قناتها لأنّ فنّيّ المطبعة سلّمها).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { deriveInvoiceChannel, INVOICE_CHANNELS, type InvoiceChannel } from "@shared/invoiceChannel";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "invoiceItems", "invoices", "workOrderMaterials", "workOrders",
  "shifts", "customers", "branches", "users", "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}
const getInsertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

function adminCtx(): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role: "admin", branchId: 1, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = () => appRouter.createCaller(adminCtx());

/** خريطة رقم الفاتورة ⇒ القناة المتوقَّعة، تُبنى من الاشتقاق المشترك لا من التخمين. */
let expected = new Map<string, InvoiceChannel>();

async function shift(shiftType: "RETAIL" | "RECEPTION" | "PRINT_SERVICES", guard: string) {
  const r = await db().insert(s.shifts).values({
    userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(),
    openGuard: guard, openingBalance: "0", shiftType,
  });
  return getInsertId(r);
}

/** فاتورةٌ خامّ — نكتبها مباشرةً: المقصود فرزُ القناة لا مسار البيع (المُختبَر في مكانه). */
async function invoice(
  invoiceNumber: string,
  sourceType: "POS" | "ONLINE" | "ORDER" | "WORKORDER",
  shiftId: number | null,
  shiftType: string | null,
) {
  const r = await db().insert(s.invoices).values({
    invoiceNumber, branchId: 1, sourceType, shiftId,
    invoiceDate: new Date(), total: "10.00", subtotal: "10.00",
    paidAmount: "0.00", status: "PENDING", createdBy: 1,
  } as never);
  expected.set(invoiceNumber, deriveInvoiceChannel({ sourceType, shiftType }));
  return getInsertId(r);
}

beforeEach(async () => {
  expected = new Map();
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });

  const retail = await shift("RETAIL", "1:retail");
  const reception = await shift("RECEPTION", "1:reception");
  const print = await shift("PRINT_SERVICES", "1:print");

  await invoice("T-RETAIL", "POS", retail, "RETAIL");
  await invoice("T-RECEPTION-POS", "POS", reception, "RECEPTION");
  await invoice("T-PRINT", "POS", print, "PRINT_SERVICES");
  await invoice("T-STORE", "ONLINE", null, null);
  // الحدّيّتان: أمرُ شغلٍ بلا وردية، وأمرُ شغلٍ سُلّم من وردية طباعة.
  await invoice("T-WO-NOSHIFT", "WORKORDER", null, null);
  await invoice("T-WO-FROM-PRINT", "WORKORDER", print, "PRINT_SERVICES");
  // POS بلا وردية إطلاقاً — تجزئةٌ بحكم الغلبة.
  await invoice("T-POS-NOSHIFT", "POS", null, null);
});

async function numbersFor(channel: InvoiceChannel): Promise<string[]> {
  const rows = await caller().sales.list({ channel } as never);
  return (rows as { invoiceNumber: string }[]).map((r) => r.invoiceNumber).sort();
}
function expectedFor(channel: InvoiceChannel): string[] {
  return [...expected.entries()].filter(([, c]) => c === channel).map(([n]) => n).sort();
}

describe("فلتر قناة الفاتورة", () => {
  it("⭐ كل قناة: ما يعيده الخادم ≡ ما يشتقّه الملفّ المشترك (لا انجراف)", async () => {
    for (const c of INVOICE_CHANNELS) {
      expect({ [c]: await numbersFor(c) }).toEqual({ [c]: expectedFor(c) });
    }
  });

  it("⭐ التقسيم تامّ: اتحاد القنوات = كل الفواتير، وبلا تقاطع", async () => {
    const all = new Set<string>();
    for (const c of INVOICE_CHANNELS) {
      for (const n of await numbersFor(c)) {
        expect(all.has(n)).toBe(false); // لا فاتورة في قناتين
        all.add(n);
      }
    }
    const total = (await db().select({ n: sql<number>`COUNT(*)` }).from(s.invoices))[0];
    expect(all.size).toBe(Number(total.n)); // ولا فاتورة بلا قناة
  });

  it("⭐ أمر الشغل استقبالٌ ولو سُلّم من وردية طباعة أو بلا وردية", async () => {
    const reception = await numbersFor("RECEPTION");
    expect(reception).toContain("T-WO-NOSHIFT");
    expect(reception).toContain("T-WO-FROM-PRINT");
    expect(await numbersFor("PRINT")).toEqual(["T-PRINT"]);
  });

  it("بلا فلتر ⇒ كل الفواتير (الفلتر إضافةٌ لا تضييقٌ افتراضيّ)", async () => {
    const rows = await caller().sales.list({} as never);
    expect((rows as unknown[]).length).toBe(expected.size);
  });

  it("القناة تظهر في الصفّ نفسه — shiftType وworkOrderNumber مُسقَطان", async () => {
    const wo = await db().insert(s.workOrders).values({
      orderNumber: "WO-TEST-1", branchId: 1, customerId: null, title: "t",
      quantity: 1, salePrice: "10.00", status: "DELIVERED", createdBy: 1,
      invoiceId: (await db().select({ id: s.invoices.id }).from(s.invoices)
        .where(eq(s.invoices.invoiceNumber, "T-WO-NOSHIFT")))[0].id,
    } as never);
    expect(getInsertId(wo)).toBeGreaterThan(0);
    const rows = (await caller().sales.list({} as never)) as {
      invoiceNumber: string; shiftType: string | null; workOrderNumber: string | null;
    }[];
    const woRow = rows.find((r) => r.invoiceNumber === "T-WO-NOSHIFT")!;
    expect(woRow.workOrderNumber).toBe("WO-TEST-1");
    const printRow = rows.find((r) => r.invoiceNumber === "T-PRINT")!;
    expect(printRow.shiftType).toBe("PRINT_SERVICES");
  });
});
