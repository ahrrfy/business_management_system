// تقرير المبيعات — الإجماليات على كامل نطاق الفلتر لا الصفحة المجلوبة (تدقيق ١٧/٧، خطر #5).
// كانت البطاقات (عدد/إجمالي/محصَّل/متبقٍّ) تُحسب بـreduce على صفوف الصفحة (≤ limit) ⇒ نطاق يتجاوز
// الحدّ يُعطي المحاسب إجماليات ناقصة تبدو نهائية. الآن SUM خادميّ على كل المطابق.
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
function adminCtx(): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role: "admin", branchId: 1, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = () => appRouter.createCaller(adminCtx());

beforeEach(async () => {
  await truncateTables(["invoices", "customers", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  // ٣ فواتير: الإجمالي ١٠٠+٢٠٠+٣٠٠=٦٠٠، المدفوع ٥٠+٢٠٠+٠=٢٥٠، المتبقّي (١٠٠−٥٠)+٠+٣٠٠=٣٥٠.
  await d.insert(s.invoices).values([
    { branchId: 1, invoiceNumber: "INV-1", sourceType: "POS", status: "PARTIALLY_PAID", invoiceDate: new Date("2026-07-01T08:00:00Z"), subtotal: "100.00", total: "100.00", paidAmount: "50.00" },
    { branchId: 1, invoiceNumber: "INV-2", sourceType: "POS", status: "PAID", invoiceDate: new Date("2026-07-02T08:00:00Z"), subtotal: "200.00", total: "200.00", paidAmount: "200.00" },
    { branchId: 1, invoiceNumber: "INV-3", sourceType: "POS", status: "PENDING", invoiceDate: new Date("2026-07-03T08:00:00Z"), subtotal: "300.00", total: "300.00", paidAmount: "0.00" },
  ]);
});

describe("reports.salesReport — إجماليات كامل النطاق", () => {
  it("limit=1 يعيد صفّاً واحداً لكن الإجماليات تعكس كل الفواتير المطابقة", async () => {
    const res = await caller().reports.salesReport({ limit: 1 });
    expect(res.rows.length).toBe(1); // الصفحة محدودة بـlimit
    expect(res.totals.count).toBe(3); // الإجماليات على الكل لا الصفحة
    expect(res.totals.total).toBe("600.00");
    expect(res.totals.paid).toBe("250.00");
    expect(res.totals.unpaid).toBe("350.00");
    expect(res.nextCursor).not.toBeNull(); // ما زال هناك المزيد
  });

  it("فلتر الحالة يُطبَّق على الإجماليات أيضاً (PAID وحدها)", async () => {
    const res = await caller().reports.salesReport({ limit: 100, statuses: ["PAID"] });
    expect(res.totals.count).toBe(1);
    expect(res.totals.total).toBe("200.00");
    expect(res.totals.unpaid).toBe("0.00");
  });
});
