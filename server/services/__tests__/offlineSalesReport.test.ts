// اختبارات تقرير «المبيعات الأوفلاين» (الشريحة ٥): الصفوف + المؤشرات + وسم «مُزامنة لاحقاً»
// + فلاتر الفرع والتاريخ. البذرة بإدراج مباشر لفواتير موسومة (لا حاجة لمسار replay الكامل هنا —
// دلالته مغطاة في offlineReplay.test.ts).
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { buildOfflineSalesReport } from "../offline/salesReport";

const TABLES = ["invoices", "shifts", "customers", "branches", "users"];

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

const H = 60 * 60 * 1000;

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 2, openId: "local_c1", name: "كاشير", email: "c1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  // وردية أُغلقت قبل ساعتين.
  await d.insert(s.shifts).values([
    { id: 1, userId: 2, branchId: 1, status: "CLOSED", openedAt: new Date(Date.now() - 8 * H), closedAt: new Date(Date.now() - 2 * H), openingBalance: "0" },
  ]);
  await d.insert(s.invoices).values([
    // التُقطت قبل ٣ ساعات ورُحِّلت قبل الإغلاق (قبل ٢.٥ ساعة) ⇒ ليست «مُزامنة لاحقاً»؛ التأخر ٣٠ دقيقة.
    {
      id: 1, invoiceNumber: "INV-1-A-1", sourceType: "POS", sourceId: "off-a", branchId: 1, shiftId: 1,
      subtotal: "250.00", total: "250.00", paidAmount: "250.00", status: "PAID",
      originatedOffline: true, offlineReceiptNumber: "OFF-1-aa11-1",
      capturedAt: new Date(Date.now() - 3 * H), createdAt: new Date(Date.now() - 2.5 * H),
    },
    // التُقطت قبل ٤ ساعات ورُحِّلت بعد الإغلاق (قبل ساعة) ⇒ «مُزامنة لاحقاً»؛ التأخر ١٨٠ دقيقة.
    {
      id: 2, invoiceNumber: "INV-1-A-2", sourceType: "POS", sourceId: "off-b", branchId: 1, shiftId: 1,
      subtotal: "1000.00", total: "1000.00", paidAmount: "1000.00", status: "PAID",
      originatedOffline: true, offlineReceiptNumber: "OFF-1-aa11-2",
      capturedAt: new Date(Date.now() - 4 * H), createdAt: new Date(Date.now() - 1 * H),
    },
    // فاتورة أونلاينية عادية — يجب ألّا تظهر.
    {
      id: 3, invoiceNumber: "INV-1-A-3", sourceType: "POS", sourceId: "online-1", branchId: 1, shiftId: 1,
      subtotal: "999.00", total: "999.00", paidAmount: "999.00", status: "PAID",
      originatedOffline: false, createdAt: new Date(Date.now() - 1 * H),
    },
    // فرع آخر — لفحص فلتر الفرع.
    {
      id: 4, invoiceNumber: "INV-2-A-1", sourceType: "POS", sourceId: "off-c", branchId: 2, shiftId: null,
      subtotal: "500.00", total: "500.00", paidAmount: "500.00", status: "PAID",
      originatedOffline: true, offlineReceiptNumber: "OFF-2-bb22-1",
      capturedAt: new Date(Date.now() - 2 * H), createdAt: new Date(Date.now() - 1 * H),
    },
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

describe("buildOfflineSalesReport — الصفوف والمؤشرات", () => {
  it("يعرض الأوفلايني فقط بربط OFF↔INV وزمن الترحيل ووسم «مُزامنة لاحقاً»", async () => {
    const rep = await buildOfflineSalesReport({});
    expect(rep.totals.count).toBe(3); // بلا الفاتورة الأونلاينية
    expect(rep.rows.map((r) => r.invoiceNumber).sort()).toEqual(["INV-1-A-1", "INV-1-A-2", "INV-2-A-1"]);

    const a = rep.rows.find((r) => r.invoiceNumber === "INV-1-A-1")!;
    expect(a.offlineReceiptNumber).toBe("OFF-1-aa11-1");
    expect(a.replayLagMinutes).toBe(30);
    expect(a.lateSynced).toBe(false);

    const b = rep.rows.find((r) => r.invoiceNumber === "INV-1-A-2")!;
    expect(b.replayLagMinutes).toBe(180);
    expect(b.lateSynced).toBe(true); // رُحِّلت بعد closedAt

    expect(rep.totals.lateSyncedCount).toBe(1);
    expect(Number(rep.totals.total)).toBe(1750);
    expect(rep.totals.maxLagMinutes).toBe(180);
  });

  it("فلتر الفرع يقصر النتائج والمجاميع على فرعه", async () => {
    const rep = await buildOfflineSalesReport({ branchId: 2 });
    expect(rep.totals.count).toBe(1);
    expect(rep.rows[0].invoiceNumber).toBe("INV-2-A-1");
    expect(rep.rows[0].lateSynced).toBe(false); // بلا وردية ⇒ لا وسم
    expect(Number(rep.totals.total)).toBe(500);
  });

  it("نطاق تاريخ لا يشمل شيئاً ⇒ صفوف فارغة ومجاميع صفرية بلا فشل", async () => {
    const rep = await buildOfflineSalesReport({ from: "2020-01-01", to: "2020-01-02" });
    expect(rep.rows).toHaveLength(0);
    expect(rep.totals.count).toBe(0);
    expect(rep.totals.avgLagMinutes).toBeNull();
  });
});
