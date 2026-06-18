import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listSalesReturns, returnSale } from "../returnService";
import { createSale } from "../saleService";
import { truncateTables } from "./__testUtils__";

/* ═══════════ listSalesReturns — سجلّ مرتجعات البيع ═══════════
   قيود RETURN ذات invoiceId بلا supplierId (عكس مرتجعات الشراء).
   يغطي: الصفّ الصحيح بعد مرتجع فعلي، عدم تلوّث بقيود الشراء،
   شمولية from/to على حدّي entryDate (عمود DATE)، ومرتجع بيع نقدي بلا عميل.
═══════════════════════════════════════════════════════════════ */

const actor = { userId: 1, branchId: 1, role: "admin" };
const getInsertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);
let seedShiftId = 0;

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await truncateTables(TABLES);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d
    .insert(s.productUnits)
    .values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0" });
  // M5/M8/M10: عمليات النقد تَستلزم وردية مفتوحة (هنا: بيع نقدي بلا عميل ⇒ pay CASH).
  const sr = await d.insert(s.shifts).values({
    userId: 1, branchId: 1, status: "OPEN",
    openedAt: new Date(),
    openGuard: "1:1", openingBalance: "0",
  });
  seedShiftId = getInsertId(sr);
}

async function setStock(variantId: number, branchId: number, qty: number) {
  await db().insert(s.branchStock).values({ variantId, branchId, quantity: qty });
}

/** بيع (آجل بعميل، أو نقدي بلا عميل مع سداد كامل — البيع غير المسدَّد بلا عميل مرفوض) ثم إرجاع جزء منه. */
async function saleThenReturn(opts: { customerId?: number | null; qty: string; returnBase: number; pay?: string }) {
  const sale = await createSale(
    {
      branchId: 1,
      customerId: opts.customerId ?? null,
      sourceType: "ORDER",
      lines: [{ variantId: 1, productUnitId: 1, quantity: opts.qty }],
      payment: opts.pay ? { amount: opts.pay, method: "CASH" } : null,
      // M8: createSale CASH يَستلزم shiftId صريحاً. الوردية مفتوحة في seedBase.
      shiftId: opts.pay ? seedShiftId : undefined,
    },
    actor,
  );
  const item = (await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId)))[0];
  await returnSale(
    { invoiceId: sale.invoiceId, lines: [{ invoiceItemId: Number(item.id), baseQuantity: opts.returnBase }] },
    actor,
  );
  return sale;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("listSalesReturns — سجلّ مرتجعات البيع", () => {
  it("بيع ثم مرتجع ⇒ الصفّ يظهر بقيمة سالبة ورقم فاتورة واسم عميل صحيحين، وtotal يزداد", async () => {
    await setStock(1, 1, 20);
    const sale = await saleThenReturn({ customerId: 1, qty: "10", returnBase: 5 });

    const first = await listSalesReturns();
    expect(first.total).toBe(1);
    expect(first.rows).toHaveLength(1);
    const row = first.rows[0];
    // اتفاقية RETURN: المبلغ مخزَّن سالباً (5 × 10.00 = 50.00 ⇒ ‎-50.00).
    expect(row.amount).toBe("-50.00");
    expect(Number(row.invoiceId)).toBe(sale.invoiceId);
    expect(row.invoiceNumber).toBe(sale.invoiceNumber);
    expect(Number(row.customerId)).toBe(1);
    expect(row.customerName).toBe("تاجر");
    expect(Number(row.branchId)).toBe(1);

    // مرتجع ثانٍ ⇒ total يزداد (قيد RETURN لكل عملية إرجاع).
    await saleThenReturn({ customerId: 1, qty: "3", returnBase: 3 });
    const second = await listSalesReturns();
    expect(second.total).toBe(2);
    // الترتيب: id DESC ⇒ الأحدث أولاً.
    expect(Number(second.rows[0].id)).toBeGreaterThan(Number(second.rows[1].id));
  });

  it("عدم تلوّث: قيد RETURN ذو supplierId (مرتجع شراء) لا يظهر أبداً في مرتجعات البيع", async () => {
    await setStock(1, 1, 20);
    const sale = await saleThenReturn({ customerId: 1, qty: "10", returnBase: 5 });

    // قيد مرتجع شراء: supplierId غير فارغ (وبلا فاتورة) — يحاكي ما يكتبه createPurchaseReturn.
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    await db().insert(s.accountingEntries).values({
      entryType: "RETURN",
      branchId: 1,
      supplierId: 1,
      cost: "-99.00",
      amount: "-99.00",
      entryDate: new Date(),
    });
    // وحتى لو وُجد قيد شراء شاذّ يحمل invoiceId (دفاع isNull(supplierId)) — لا يتسرّب.
    await db().insert(s.accountingEntries).values({
      entryType: "RETURN",
      branchId: 1,
      supplierId: 1,
      invoiceId: sale.invoiceId,
      cost: "-7.00",
      amount: "-7.00",
      entryDate: new Date(),
    });

    const res = await listSalesReturns();
    expect(res.total).toBe(1);
    expect(res.rows).toHaveLength(1);
    expect(res.rows.every((r) => r.amount !== "-99.00" && r.amount !== "-7.00")).toBe(true);
  });

  it("from/to شاملان على حدّي entryDate (عمود DATE — بلا حيلة nextDay)", async () => {
    await setStock(1, 1, 30);
    await saleThenReturn({ customerId: 1, qty: "2", returnBase: 1 });
    await saleThenReturn({ customerId: 1, qty: "2", returnBase: 1 });
    await saleThenReturn({ customerId: 1, qty: "2", returnBase: 1 });

    // ثبّت تواريخ القيود الثلاثة يدوياً (postEntry يكتب اليوم الحالي افتراضاً).
    const entries = await db()
      .select({ id: s.accountingEntries.id })
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "RETURN"))
      .orderBy(sql`${s.accountingEntries.id} ASC`);
    expect(entries).toHaveLength(3);
    const dates = ["2026-01-10", "2026-01-15", "2026-01-20"];
    for (let i = 0; i < 3; i++) {
      await db()
        .update(s.accountingEntries)
        .set({ entryDate: new Date(dates[i]) })
        .where(eq(s.accountingEntries.id, Number(entries[i].id)));
    }

    // الفترة [10، 15]: صفّا الحدّين كلاهما داخلان، والـ20 خارج.
    const mid = await listSalesReturns({ from: "2026-01-10", to: "2026-01-15" });
    expect(mid.total).toBe(2);
    const midIds = mid.rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    expect(midIds).toEqual([Number(entries[0].id), Number(entries[1].id)]);

    // فترة يوم واحد على الحدّ بالضبط: from=to=2026-01-20 ⇒ الصفّ المؤرَّخ به داخل.
    const exact = await listSalesReturns({ from: "2026-01-20", to: "2026-01-20" });
    expect(exact.total).toBe(1);
    expect(Number(exact.rows[0].id)).toBe(Number(entries[2].id));

    // خارج الفترة كلّياً ⇒ لا صفوف.
    const none = await listSalesReturns({ from: "2026-02-01", to: "2026-02-28" });
    expect(none.total).toBe(0);
    expect(none.rows).toHaveLength(0);
  });

  it("مرتجع بيع نقدي (بلا عميل): customerName فارغ والصفّ حاضر ببيانات ربط الفاتورة", async () => {
    await setStock(1, 1, 10);
    const sale = await saleThenReturn({ customerId: null, qty: "4", returnBase: 2, pay: "40.00" });

    const res = await listSalesReturns();
    expect(res.total).toBe(1);
    const row = res.rows[0];
    expect(row.customerId).toBeNull();
    expect(row.customerName).toBeNull();
    expect(Number(row.invoiceId)).toBe(sale.invoiceId);
    expect(row.invoiceNumber).toBe(sale.invoiceNumber);
    expect(row.amount).toBe("-20.00");
  });
});
