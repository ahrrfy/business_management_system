/**
 * بذرةُ **عرضٍ** للقنوات الأربع (جولة بصرية ١٩/٨) — تمرّ بالخدمات الحقيقية لا بصفوفٍ مُلفَّقة،
 * فما يظهر على الشاشة يكون قد قطع مسار الفوترة والدفتر والمخزون فعلاً.
 *
 * ⛔ للتطوير المحلّي وحدها: ترفض أيّ قاعدةٍ لا يحمل اسمُها `_dev`.
 */
import "dotenv/config";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { getDb } from "../server/db";
import { openShift, closeShift } from "../server/services/shiftService";
import { createSale } from "../server/services/saleService";
import { createPrintSale } from "../server/services/printSaleService";
import { createWorkOrder } from "../server/services/workOrder/create";
import { deliverWorkOrder } from "../server/services/workOrder/deliver";

const url = process.env.DATABASE_URL ?? "";
if (!/_dev(\?|$)/.test(url)) {
  console.error(`✗ قاعدةٌ غير تطويرية — رُفضت: ${url.replace(/:[^:@]*@/, ":***@")}`);
  process.exit(1);
}

const db = getDb()!;
const ADMIN = { userId: 1, branchId: 1, role: "admin" as const };

/** عميلان **بلا حدّ ائتمان** — وحدهما يقبلان الآجل (صفرٌ = نقديٌّ فقط، وهو الافتراضي). */
async function ensureCustomers() {
  const openCredit = () =>
    db.select().from(s.customers).where(isNull(s.customers.creditLimit));
  let rows = await openCredit();
  if (rows.length < 2) {
    await db.insert(s.customers).values([
      { name: "مكتب الرافدين للطباعة", phone: "+9647701112233", defaultPriceTier: "WHOLESALE", currentBalance: "0", creditLimit: null },
      { name: "أحمد الجبوري", phone: "+9647702223344", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: null },
    ]);
    rows = await openCredit();
  }
  return rows.map((r) => Number(r.id));
}

async function withShift<T>(
  shiftType: "RETAIL" | "RECEPTION" | "PRINT_SERVICES",
  fn: (shiftId: number) => Promise<T>,
): Promise<T> {
  // ورديةٌ مفتوحةٌ سلفاً تُستعمل كما هي ولا تُقفَل: إقفالُ وردية غيرك يعبث بدرجها.
  const existing = (await db
    .select()
    .from(s.shifts)
    .where(and(eq(s.shifts.shiftType, shiftType), eq(s.shifts.status, "OPEN"), eq(s.shifts.branchId, 1)))
    .limit(1))[0];
  if (existing) return await fn(Number(existing.id));

  const open = await openShift({ branchId: 1, openingBalance: "0", shiftType }, ADMIN);
  const shiftId = Number((open as { shiftId: number }).shiftId);
  try {
    return await fn(shiftId);
  } finally {
    const sh = (await db.select().from(s.shifts).where(eq(s.shifts.id, shiftId)))[0];
    await closeShift({ shiftId, countedCash: String(sh?.expectedCash ?? "0") }, ADMIN);
  }
}


/** خدمة طباعةٍ واحدة (`productType = PRINT_SERVICE`) — شاشة المطبعة تشترطها. */
async function ensurePrintService(): Promise<{ variantId: number; unitId: number }> {
  const existing = (await db
    .select({ vid: s.productVariants.id, uid: s.productUnits.id })
    .from(s.productVariants)
    .innerJoin(s.products, eq(s.productVariants.productId, s.products.id))
    .innerJoin(s.productUnits, eq(s.productUnits.variantId, s.productVariants.id))
    .where(eq(s.products.productType, "PRINT_SERVICE"))
    .limit(1))[0];
  if (existing) return { variantId: Number(existing.vid), unitId: Number(existing.uid) };

  const pr = await db.insert(s.products).values({
    name: "طباعة A4 ملوّن", productType: "PRINT_SERVICE",
  } as never);
  const productId = Number((pr as never as { insertId: number }).insertId ?? (pr as never as [{ insertId: number }])[0].insertId);
  const vr = await db.insert(s.productVariants).values({
    productId, sku: "SVC-A4-COLOR", costPrice: "150.00",
  } as never);
  const variantId = Number((vr as never as { insertId: number }).insertId ?? (vr as never as [{ insertId: number }])[0].insertId);
  const ur = await db.insert(s.productUnits).values({
    variantId, unitName: "ورقة", conversionFactor: "1", isBaseUnit: true,
  } as never);
  const unitId = Number((ur as never as { insertId: number }).insertId ?? (ur as never as [{ insertId: number }])[0].insertId);
  await db.insert(s.productPrices).values({ productUnitId: unitId, priceTier: "RETAIL", price: "600.00" } as never);
  await db.insert(s.productPrices).values({ productUnitId: unitId, priceTier: "WHOLESALE", price: "600.00" } as never);
  return { variantId, unitId };
}


/** الخطوة تُتخطّى إن سبق تنفيذها (مفتاح idempotency مسجّل) — فالسكربت يُعاد تشغيله بلا تكرار. */
async function alreadyDone(clientRequestId: string): Promise<boolean> {
  const r = await db
    .select({ id: s.idempotencyKeys.id })
    .from(s.idempotencyKeys)
    .where(eq(s.idempotencyKeys.clientRequestId, clientRequestId))
    .limit(1);
  return r.length > 0;
}

async function main() {
  const [c1, c2] = await ensureCustomers();

  // ① التجزئة — بيعٌ نقديٌّ مكتمل التحصيل (يجوز بلا عميل: زبونٌ عابر).
  if (!(await alreadyDone("demo-retail-4"))) await withShift("RETAIL", async (shiftId) => {
    await createSale({
      branchId: 1, customerId: null, sourceType: "POS", shiftId,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "4" }],
      payment: { amount: "1000.00", method: "CASH" },
      clientRequestId: "demo-retail-4",
    } as never, ADMIN);
    console.log("① تجزئة: بيعٌ نقديّ 1000");
  });

  // ② الاستقبال — أمرُ شغلٍ **آجلٌ بلا عربون**، ثمّ يُسلَّم فتُنشأ فاتورته.
  //    هذا هو مسارُ بلاغ المالك: كان يظهر «نقدي» وقد صار NULL = آجل صادق.
  if (!(await alreadyDone("demo-wo-c"))) await withShift("RECEPTION", async () => {
    const wo = await createWorkOrder({
      branchId: 1, customerId: c1, title: "درع تكريم منقوش", quantity: 2,
      salePrice: "30000.00", deposit: "0", materials: [],
      receptionChannel: "WHATSAPP", channelHandle: "+9647701112233",
      priority: "URGENT", clientRequestId: "demo-wo-c",
    } as never, ADMIN);
    const woId = Number((wo as { workOrderId: number }).workOrderId);
    await db.update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
    await deliverWorkOrder({ workOrderId: woId, payment: null }, ADMIN);
    console.log("② استقبال: أمرُ شغلٍ آجلٌ بلا عربون ⇒ فاتورةٌ صادقة (لا «نقدي»)");
  });

  // ③ الاستقبال — أمرٌ ثانٍ بعربونٍ نقديّ جزئيّ (قناة هاتف).
  if (!(await alreadyDone("demo-wo-d"))) await withShift("RECEPTION", async () => {
    const wo = await createWorkOrder({
      branchId: 1, customerId: c2, title: "طباعة كروت شخصية", quantity: 1,
      salePrice: "12000.00", deposit: "5000.00", paymentMethod: "CASH", materials: [],
      receptionChannel: "PHONE", channelHandle: "+9647702223344",
      clientRequestId: "demo-wo-d",
    } as never, ADMIN);
    const woId = Number((wo as { workOrderId: number }).workOrderId);
    await db.update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, woId));
    await deliverWorkOrder({ workOrderId: woId, payment: { amount: "7000.00", method: "CASH" } }, ADMIN);
    console.log("③ استقبال: عربونٌ 5000 + تسليمٌ بقبض 7000");
  });

  // ④ المطبعة — بيعُ **خدمة طباعة** (شاشتها ترفض الأصناف الكتالوجية عن قصد).
  const svc = await ensurePrintService();
  if (!(await alreadyDone("demo-print-5"))) await withShift("PRINT_SERVICES", async (shiftId) => {
    await createPrintSale({
      branchId: 1, customerId: c1, shiftId,
      lines: [{ variantId: svc.variantId, productUnitId: svc.unitId, quantity: "10", unitPrice: "600.00" }],
      payment: { amount: "6000.00", method: "CASH" },
      clientRequestId: "demo-print-5",
    } as never, ADMIN);
    console.log("④ مطبعة: بيعُ خدمةٍ 6000 من وردية الطباعة");
  });

  const rows = await db.execute(sql`
    SELECT i.invoiceNumber, i.sourceType, i.paymentMethod, i.total, i.paidAmount, sh.shiftType, w.orderNumber
    FROM invoices i LEFT JOIN shifts sh ON sh.id = i.shiftId
    LEFT JOIN workOrders w ON w.invoiceId = i.id ORDER BY i.id`);
  console.table((rows as unknown as [unknown[]])[0] ?? rows);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
