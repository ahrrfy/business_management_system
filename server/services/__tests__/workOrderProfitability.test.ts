// اختبارات تقرير ربحية أوامر الشغل (Job Costing) — server/services/reports/workOrderProfitability.ts
//
// السيناريو مبذور **بالخدمات الحقيقية** كاملةً (لا بذر جداول مباشر للدورة):
// createWorkOrder → startWorkOrder (لقطة materialsCost من costPrice + حركات OUT)
// → markWorkOrderReady → deliverWorkOrder (فاتورة WORKORDER + قيد SALE) — ثم يُضبط
// workSeconds/deliveredAt مباشرةً بعد التسليم فقط (قيمهما الحقيقية زمن-تشغيلية:
// TIMESTAMPDIFF وNOW() — غير قابلة للتثبيت عبر الخدمات في اختبار).
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { workOrderProfitability } from "../reports/workOrderProfitability";
import { createWorkOrder } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import { markWorkOrderReady, startWorkOrder } from "../workOrder/lifecycle";

const admin = { userId: 1, branchId: 1, role: "admin" as const };

const TABLES = [
  "accountingEntries",
  "receipts",
  "invoiceItems",
  "invoices",
  "workOrderMaterials",
  "workOrderItems",
  "workOrderImages",
  "workOrders",
  "inventoryMovements",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "customers",
  "branches",
  "users",
  "idempotencyKeys",
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

const VARIANT_ID = 11;
const CUSTOMER_ID = 5;
// costPrice للمتغيّر — يُلتقط لقطةً في startWorkOrder ⇒ materialsCost = 250 × baseQuantity.
const UNIT_COST = "250.00";

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
  // creditLimit=null ⇒ بلا حدّ (يسمح بالتسليم الآجل بلا دفعة ولا وردية نقدية).
  await d.insert(s.customers).values({ id: CUSTOMER_ID, name: "عميل المطبعة" });
  await d.insert(s.products).values({ id: 10, name: "خشب درع" });
  await d.insert(s.productVariants).values({
    id: VARIANT_ID,
    productId: 10,
    sku: "WOOD-1",
    costPrice: UNIT_COST,
  });
  // رصيد كافٍ في الفرعين — startWorkOrder يستهلك OUT ويرفض النقص.
  await d.insert(s.branchStock).values([
    { variantId: VARIANT_ID, branchId: 1, quantity: 1000 },
    { variantId: VARIANT_ID, branchId: 2, quantity: 1000 },
  ]);
}

/** دورة كاملة بالخدمات الحقيقية حتى DELIVERED، ثم تثبيت workSeconds/deliveredAt للحتمية. */
async function makeDeliveredWO(opts: {
  branchId?: number;
  salePrice: string;
  quotedLaborCost?: string;
  materialsQty?: number; // baseQuantity للمادة الواحدة (كلفة الوحدة 250.00)
  workSeconds?: number | null;
  deliveredAt: Date;
}): Promise<number> {
  const branchId = opts.branchId ?? 1;
  const { workOrderId } = await createWorkOrder(
    {
      branchId,
      customerId: CUSTOMER_ID,
      title: `درع تخرج ${Math.random().toString(36).slice(2, 8)}`,
      quantity: 1,
      salePrice: opts.salePrice,
      laborCost: opts.quotedLaborCost,
      materials:
        opts.materialsQty && opts.materialsQty > 0
          ? [{ variantId: VARIANT_ID, baseQuantity: opts.materialsQty }]
          : [],
    },
    { userId: 1, branchId },
  );
  await startWorkOrder(workOrderId, { ...admin, branchId });
  await markWorkOrderReady(workOrderId, { ...admin, branchId });
  // تسليم آجل بلا دفعة ⇒ لا وردية مطلوبة؛ الذمم تُعدَّل على العميل.
  await deliverWorkOrder({ workOrderId, payment: null }, { ...admin, branchId });
  await db()
    .update(s.workOrders)
    .set({ workSeconds: opts.workSeconds ?? null, deliveredAt: opts.deliveredAt })
    .where(eq(s.workOrders.id, workOrderId));
  return workOrderId;
}

// منتصف نهار محلي — بعيد عن حواف اليوم (فلترة deliveredAt بنطاق [from, to+يوم) محلي).
const D_JUN10 = new Date(2026, 5, 10, 12, 0, 0);
const D_JUN15 = new Date(2026, 5, 15, 12, 0, 0);
const RANGE = { from: "2026-06-01", to: "2026-06-30" };

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("workOrderProfitability — صحة الأرقام المالية", () => {
  it("الإيراد من الفاتورة المرتبطة، المواد من لقطة startWorkOrder، الساعات من workSeconds", async () => {
    // salePrice 6000، مواد 4 × 250 = 1000، زمن 5400 ثانية = 1.50 ساعة.
    const woId = await makeDeliveredWO({
      salePrice: "6000",
      quotedLaborCost: "700",
      materialsQty: 4,
      workSeconds: 5400,
      deliveredAt: D_JUN10,
    });

    const res = await workOrderProfitability({ ...RANGE, branchId: null });
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.id).toBe(woId);
    expect(row.customerName).toBe("عميل المطبعة");
    expect(row.branchName).toBe("الفرع الرئيسي");
    expect(row.deliveredAt).toBe("2026-06-10");
    expect(row.invoiceId).not.toBeNull();
    expect(row.invoiceNumber).toBeTruthy();
    // الإيراد = invoice.total − invoice.taxAmount = salePrice (فواتير WO بضريبة 0).
    expect(row.revenue).toBe("6000.00");
    expect(row.materialsCost).toBe("1000.00");
    expect(row.quotedLaborCost).toBe("700.00");
    expect(row.hours).toBe("1.50");
    // بلا laborRatePerHour ⇒ كلفة العمل null والربح = 6000 − 1000 فقط.
    expect(row.laborCost).toBeNull();
    expect(row.profit).toBe("5000.00");
    expect(row.marginPct).toBe("83.33");
    expect(res.totals.laborCost).toBeNull();

    // تحقّق تقاطعي: الإيراد المعروض يطابق قيد SALE (revenue في الدفتر).
    const entry = (await db()
      .select({ revenue: s.accountingEntries.revenue, cost: s.accountingEntries.cost })
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "SALE")))[0];
    expect(entry.revenue).toBe(row.revenue);
  });

  it("laborRatePerHour يغيّر كلفة العمل والربح والهامش", async () => {
    await makeDeliveredWO({
      salePrice: "6000",
      materialsQty: 4,
      workSeconds: 5400, // 1.5 ساعة
      deliveredAt: D_JUN10,
    });

    const res = await workOrderProfitability({ ...RANGE, laborRatePerHour: "2000" });
    const row = res.rows[0];
    // كلفة العمل = 1.5 × 2000 = 3000؛ الربح = 6000 − 1000 − 3000 = 2000.
    expect(row.laborCost).toBe("3000.00");
    expect(row.profit).toBe("2000.00");
    expect(row.marginPct).toBe("33.33");
    expect(res.totals.laborCost).toBe("3000.00");
    expect(res.totals.profit).toBe("2000.00");
  });

  it("أمر بلا workSeconds: الساعات وكلفة العمل null حتى مع rate، والربح إيراد − مواد فقط", async () => {
    await makeDeliveredWO({
      salePrice: "3000",
      materialsQty: 2, // 500
      workSeconds: null,
      deliveredAt: D_JUN10,
    });

    const res = await workOrderProfitability({ ...RANGE, laborRatePerHour: "2000" });
    const row = res.rows[0];
    expect(row.hours).toBeNull();
    expect(row.laborCost).toBeNull();
    expect(row.profit).toBe("2500.00");
    // مجموع الساعات لا يتأثر بالأوامر غير المُقاسة.
    expect(res.totals.hours).toBe("0.00");
  });
});

describe("workOrderProfitability — النطاق والفلاتر", () => {
  it("فلترة المدى على deliveredAt: خارج المدى لا يظهر", async () => {
    const inRange = await makeDeliveredWO({ salePrice: "1000", deliveredAt: D_JUN10 });
    await makeDeliveredWO({ salePrice: "2000", deliveredAt: D_JUN15 });

    const res = await workOrderProfitability({ from: "2026-06-10", to: "2026-06-12" });
    expect(res.rows.map((r) => r.id)).toEqual([inRange]);
    expect(res.totals.count).toBe(1);
    expect(res.totals.revenue).toBe("1000.00");
  });

  it("عزل الفرع: branchId يحصر النتائج، وغيابه يجمع الفرعين", async () => {
    const b1 = await makeDeliveredWO({ branchId: 1, salePrice: "1000", deliveredAt: D_JUN10 });
    const b2 = await makeDeliveredWO({ branchId: 2, salePrice: "2000", deliveredAt: D_JUN10 });

    const only1 = await workOrderProfitability({ ...RANGE, branchId: 1 });
    expect(only1.rows.map((r) => r.id)).toEqual([b1]);
    expect(only1.totals.revenue).toBe("1000.00");

    const only2 = await workOrderProfitability({ ...RANGE, branchId: 2 });
    expect(only2.rows.map((r) => r.id)).toEqual([b2]);

    const all = await workOrderProfitability({ ...RANGE, branchId: null });
    expect(all.totals.count).toBe(2);
    expect(all.totals.revenue).toBe("3000.00");
  });

  it("أمر غير مُسلَّم (READY) لا يظهر في التقرير", async () => {
    // دورة تتوقف عند READY — لا فاتورة ولا تسليم.
    const { workOrderId } = await createWorkOrder(
      {
        branchId: 1,
        customerId: CUSTOMER_ID,
        title: "أمر جاهز غير مُسلَّم",
        quantity: 1,
        salePrice: "9000",
        materials: [{ variantId: VARIANT_ID, baseQuantity: 1 }],
      },
      { userId: 1, branchId: 1 },
    );
    await startWorkOrder(workOrderId, admin);
    await markWorkOrderReady(workOrderId, admin);

    await makeDeliveredWO({ salePrice: "1000", deliveredAt: D_JUN10 });

    const res = await workOrderProfitability({ ...RANGE });
    expect(res.rows).toHaveLength(1);
    expect(res.rows.map((r) => r.id)).not.toContain(workOrderId);
    expect(res.totals.revenue).toBe("1000.00");
  });
});

describe("workOrderProfitability — الإجماليات والترقيم", () => {
  it("الإجماليات = مجموع الصفوف بدقّة decimal (قيم بكسور سنت)", async () => {
    await makeDeliveredWO({
      salePrice: "100.10",
      materialsQty: 0,
      workSeconds: 1800, // 0.5 ساعة
      deliveredAt: D_JUN10,
    });
    await makeDeliveredWO({
      salePrice: "200.25",
      materialsQty: 1, // 250.00 ⇒ ربح سالب مقبول محاسبياً
      workSeconds: 2700, // 0.75 ساعة
      deliveredAt: D_JUN15,
    });

    const res = await workOrderProfitability({ ...RANGE, laborRatePerHour: "3333.33" });
    expect(res.rows).toHaveLength(2);
    // نتحقّق نصّياً بالقيم المحسوبة يدوياً:
    // labor: 0.5×3333.33=1666.67 (round2)؛ 0.75×3333.33=2500.00 (2499.9975→2500.00).
    expect(res.rows.map((r) => r.laborCost)).toEqual(
      expect.arrayContaining(["1666.67", "2500.00"]),
    );
    expect(res.totals.revenue).toBe("300.35"); // 100.10 + 200.25
    expect(res.totals.materialsCost).toBe("250.00");
    expect(res.totals.laborCost).toBe("4166.67"); // 1666.67 + 2500.00
    expect(res.totals.hours).toBe("1.25"); // 0.50 + 0.75
    // profit صف١ = 100.10−0−1666.67 = −1566.57؛ صف٢ = 200.25−250−2500 = −2549.75.
    expect(res.totals.profit).toBe("-4116.32");
    expect(res.totals.count).toBe(2);
  });

  it("limit/offset يقسمان الصفوف والإجماليات تبقى لكامل النطاق", async () => {
    await makeDeliveredWO({ salePrice: "1000", deliveredAt: D_JUN10 });
    await makeDeliveredWO({ salePrice: "2000", deliveredAt: D_JUN15 });

    const page1 = await workOrderProfitability({ ...RANGE, limit: 1, offset: 0 });
    const page2 = await workOrderProfitability({ ...RANGE, limit: 1, offset: 1 });
    expect(page1.rows).toHaveLength(1);
    expect(page2.rows).toHaveLength(1);
    expect(page1.rows[0].id).not.toBe(page2.rows[0].id);
    // الأحدث تسليماً أولاً.
    expect(page1.rows[0].deliveredAt).toBe("2026-06-15");
    // الإجماليات ثابتة عبر الصفحات = كامل النطاق.
    expect(page1.totals.revenue).toBe("3000.00");
    expect(page2.totals.revenue).toBe("3000.00");
    expect(page1.totalCount).toBe(2);
  });
});
