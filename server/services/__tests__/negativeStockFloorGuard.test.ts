// أرضية السالب التراكمية + «العدّ يفتتح الصنف» (تحقيق سوالب ١٢/٨).
//
// خلفية الحادثة: أصنافٌ بلغت ‑172/‑177 رغم اعتماد جردٍ «دوريّ» أمس. سببان تضافرا:
//   (١) السقف كان يُفحَص على كمية السطر فقط ⇒ بيوعٌ متتابعة كلٌّ ضمن السقف تحفر الرصيد بلا قاع.
//   (٢) الجرد الدوري كان يصحّح الكمية دون ختم openedAt ⇒ يبقى الصنف «غير مُفتتَح» ويُباع بالسالب.
// هذه الاختبارات تثبّت الإصلاح عند نقطة الاختناق applyMovement + توسعة setStock.
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { createSale } from "../saleService";
import { applyMovement, setStock } from "../inventoryService";

const actor = { userId: 1, branchId: 1, role: "admin" };
const DAY_MS = 86_400_000;

const TABLES = [
  "accountingEntries",
  "receipts",
  "invoiceItemBundleComponents",
  "invoiceItems",
  "invoices",
  "inventoryMovements",
  "branchStock",
  "openingModeSettings",
  "bundleComponents",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "customers",
  "shifts",
  "auditLogs",
  "users",
  "branches",
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
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values([
    { id: 1, name: "قلم" },
    { id: 2, name: "دفتر" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "4.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "10.00" },
  ]);
  await d.insert(s.shifts).values({
    id: 1, userId: 1, branchId: 1, status: "OPEN",
    openedAt: new Date(), openGuard: "1:1", openingBalance: "0",
  });
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

async function enableOpeningMode(over: Partial<typeof s.openingModeSettings.$inferInsert> = {}) {
  await db()
    .insert(s.openingModeSettings)
    .values({ id: 1, enabled: true, endsAt: new Date(Date.now() + 7 * DAY_MS), maxNegativeQtyPerLine: 100, ...over });
}

function cashSale(variantId: number, productUnitId: number, qty: string, amount: string) {
  return createSale(
    {
      branchId: 1,
      shiftId: 1,
      priceTier: "RETAIL",
      sourceType: "POS",
      lines: [{ variantId, productUnitId, quantity: qty }],
      payment: { amount, method: "CASH" },
    } as Parameters<typeof createSale>[0],
    actor,
  );
}

async function stockRow(variantId: number, branchId = 1) {
  const [r] = await db()
    .select({ q: s.branchStock.quantity, openedAt: s.branchStock.openedAt })
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return r;
}

describe("أرضية السالب التراكمية — نقطة الاختناق applyMovement", () => {
  it("المسار الحيّ: بيوعٌ متتابعة كلٌّ ضمن سقف السطر لا تتجاوز القاع ‑cap (يُرفض الحفر أبعد)", async () => {
    await enableOpeningMode({ maxNegativeQtyPerLine: 5 });
    // بيعٌ يصل بالضبط للقاع ‑5 (‑cap) يمرّ.
    const ok = await cashSale(1, 1, "5", "50.00");
    expect(ok.negativeDips?.[0]?.newQuantity).toBe(-5);
    expect(Number((await stockRow(1)).q)).toBe(-5);

    // بيعٌ إضافيّ (كميّته ١ ضمن سقف السطر ٥) يُرفض لأنّ الرصيد الناتج ‑6 يتجاوز القاع ‑5.
    let err: TRPCError | null = null;
    try {
      await cashSale(1, 1, "1", "10.00");
    } catch (e) {
      err = e as TRPCError;
    }
    expect(err?.code).toBe("CONFLICT");
    expect(err?.message).toMatch(/البيع بالسالب في وضع الافتتاح/);
    // ذرّية: الرصيد لم يتغيّر ولا فاتورة ثانية.
    expect(Number((await stockRow(1)).q)).toBe(-5);
    expect((await db().select().from(s.invoices)).length).toBe(1);
  });

  it("صنفٌ بلغ القاع سلفاً: أيّ بيعٍ إضافيّ يُرفض حتى لو كان ضمن سقف السطر", async () => {
    await enableOpeningMode({ maxNegativeQtyPerLine: 3 });
    await cashSale(1, 1, "3", "30.00"); // ‑3 = القاع
    let err: TRPCError | null = null;
    try {
      await cashSale(1, 1, "1", "10.00");
    } catch (e) {
      err = e as TRPCError;
    }
    expect(err?.code).toBe("CONFLICT");
    expect(Number((await stockRow(1)).q)).toBe(-3);
  });

  it("ضمن القاع تماماً يمرّ: سقف ٥ وبيعٌ يُنزل الرصيد إلى ‑5 بلا رفع علَم", async () => {
    await enableOpeningMode({ maxNegativeQtyPerLine: 5 });
    const moved = await withTx((tx) =>
      applyMovement(tx, {
        variantId: 1, branchId: 1, baseQuantity: 5, movementType: "OUT",
        referenceType: "INVOICE", allowNegativeUnopened: true,
      }),
    );
    expect(moved.newQuantity).toBe(-5);
    expect(moved.floorBreached).toBeFalsy();
  });

  it("قناة الأوفلاين/الخدمات (allowNegative): لا تُرفض أبداً عند تجاوز القاع — تُوسَم وتُرفع floorBreached", async () => {
    await enableOpeningMode({ maxNegativeQtyPerLine: 3 });
    const moved = await withTx((tx) =>
      applyMovement(tx, {
        variantId: 1, branchId: 1, baseQuantity: 5, movementType: "OUT",
        referenceType: "INVOICE", notes: "إعادة تشغيل أوفلاين", allowNegative: true,
      }),
    );
    expect(moved.newQuantity).toBe(-5); // مرّ رغم تجاوز ‑3
    expect(moved.floorBreached).toBe(true);
    const [mv] = await db()
      .select({ notes: s.inventoryMovements.notes })
      .from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.variantId, 1));
    expect(String(mv.notes ?? "")).toContain("تجاوز حدّ السالب");
  });

  it("بلا صفّ إعدادات وضع الافتتاح: القاع الافتراضي ١٠٠ (لا يتأثر البيع الاعتيادي)", async () => {
    // لا enableOpeningMode ⇒ صفّ openingModeSettings غير موجود ⇒ readNegativeFloorCap = ١٠٠.
    const moved = await withTx((tx) =>
      applyMovement(tx, {
        variantId: 1, branchId: 1, baseQuantity: 50, movementType: "OUT",
        referenceType: "INVOICE", allowNegativeUnopened: true,
      }),
    );
    expect(moved.newQuantity).toBe(-50); // ‑50 > ‑100 ⇒ يمرّ
    expect(moved.floorBreached).toBeFalsy();
  });

  it("البيع الاعتيادي (مخزون كافٍ) لا يمسّه القاع إطلاقاً", async () => {
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10, openedAt: new Date() });
    const moved = await withTx((tx) =>
      applyMovement(tx, { variantId: 1, branchId: 1, baseQuantity: 4, movementType: "OUT", referenceType: "INVOICE" }),
    );
    expect(moved.newQuantity).toBe(6);
    expect(moved.floorBreached).toBeFalsy();
  });
});

describe("«العدّ يفتتح الصنف» — ختم openedAt في setStock", () => {
  it("جردٌ دوريّ (مرجع STOCKTAKE) يختم openedAt", async () => {
    await withTx((tx) =>
      setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 10, referenceType: "STOCKTAKE", createdBy: 1 }),
    );
    expect((await stockRow(1)).openedAt).not.toBeNull();
  });

  it("جردٌ افتتاحيّ (مرجع OPENING) يظلّ يختم openedAt", async () => {
    await withTx((tx) =>
      setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 7, referenceType: "OPENING", createdBy: 1 }),
    );
    expect((await stockRow(1)).openedAt).not.toBeNull();
  });

  it("تسويةٌ يدويّة عاديّة (مرجع ADJUST) لا تختم openedAt", async () => {
    await withTx((tx) =>
      setStock(tx, { variantId: 2, branchId: 1, targetQuantity: 5, referenceType: "ADJUST", createdBy: 1 }),
    );
    expect((await stockRow(2)).openedAt).toBeNull();
  });

  it("بعد ختمه بجردٍ دوريّ يُرفض البيع بالسالب (الصنف صار مُفتتَحاً)", async () => {
    await enableOpeningMode();
    await withTx((tx) =>
      setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 0, referenceType: "STOCKTAKE", createdBy: 1 }),
    );
    // مُفتتَح الآن ⇒ allowNegativeUnopened لا يسمح.
    let err: unknown = null;
    try {
      await withTx((tx) =>
        applyMovement(tx, {
          variantId: 1, branchId: 1, baseQuantity: 1, movementType: "OUT",
          referenceType: "INVOICE", allowNegativeUnopened: true,
        }),
      );
    } catch (e) {
      err = e;
    }
    expect((err as TRPCError)?.code).toBe("CONFLICT");
    expect(Number((await stockRow(1)).q)).toBe(0);
  });
});
