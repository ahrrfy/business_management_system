/**
 * Tier-2 #3 (٢٥/٨): `runReconcileScanOnce` غلافُ **قراءةٍ محضة** لفحوص الاتّزان الخمسة.
 *
 * الاختبار هنا يُثبت العقد التشغيليّ للسكربت الليليّ:
 *   • يُعيد `FinancialReconciliationSummary` كاملة (كل الأقسام الخمسة موجودة).
 *   • لا يكتب في جداول الأعمال — استدعاؤه ثمّ فحصُ عدد الصفوف يبقى ثابتاً.
 *   • على بيانات نظيفة: `balanced=true` و`totalIssueCount=0` — فلا يفلت WARN كاذب في السجل.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../../db";
import { runReconcileScanOnce } from "../reconcileScheduler";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

describe("runReconcileScanOnce — دورةُ قراءةٍ ليليّة", () => {
  it("يُعيد ملخّصاً مكتملَ الأقسام مع `balanced=true` على بيانات نظيفة", async () => {
    const summary = await runReconcileScanOnce();
    expect(summary).toHaveProperty("runAt");
    expect(summary).toHaveProperty("totalIssueCount");
    expect(summary).toHaveProperty("balanced");
    expect(summary).toHaveProperty("sections");
    // الأقسام الستّة الحاكمة — لو نقص أحدها، تنكسر الشاشة والسكربت معاً.
    for (const key of ["customers", "suppliers", "delivery", "inventory", "ledger", "onlineOrders"] as const) {
      expect(summary.sections[key]).toEqual({ issueCount: 0, balanced: true });
    }
    expect(summary.totalIssueCount).toBe(0);
    expect(summary.balanced).toBe(true);
  });

  it("قراءةٌ فقط — لا صفوفَ مكتوبةً في الجداول الحسّاسة بعد الاستدعاء", async () => {
    const before = await countSensitive();
    await runReconcileScanOnce();
    const after = await countSensitive();
    // الجداول التي قد يُغري بها كاتبٌ صامت (سندات/قيود/حركات) لم تُمَسّ.
    expect(after).toEqual(before);
  });
});

async function countSensitive(): Promise<Record<string, number>> {
  const rows = await Promise.all([
    db().execute(sql`SELECT COUNT(*) as c FROM receipts`),
    db().execute(sql`SELECT COUNT(*) as c FROM accountingEntries`),
    db().execute(sql`SELECT COUNT(*) as c FROM inventoryMovements`),
  ]);
  const [receipts, accountingEntries, inventoryMovements] = rows.map(
    (r) => Number((r[0] as Array<{ c: number }>)[0]?.c ?? 0),
  );
  return { receipts, accountingEntries, inventoryMovements };
}
