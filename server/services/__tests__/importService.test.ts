import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  customerImportRow,
  importCustomers,
  importProducts,
  importSuppliers,
  productImportRow,
  usdRateStr,
  writeErrorMessage,
  type CustomerImportRow,
  type ProductImportRow,
  type SupplierImportRow,
} from "../importService";
import { toArabicMessage } from "../../../shared/errorMap.ar";
import { reconcileCustomerBalances, reconcileSupplierBalances } from "../reconcileService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "importBatches",
  "accountingEntries",
  "invoiceItems",
  "invoices",
  "inventoryMovements",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "categories",
  "suppliers",
  "customers",
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
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

// ───────────────────────── العملاء ─────────────────────────

describe("importCustomers", () => {
  it("ينشئ عملاء جدداً بقيم افتراضية + تنسيق المال", async () => {
    const rows: CustomerImportRow[] = [
      { rowNumber: 1, name: "أحمد", phone: "0770111", creditLimit: "500" },
      { rowNumber: 2, name: "سارة" },
    ];
    const r = await importCustomers(rows, {}, actor);
    expect(r.committed).toBe(true);
    expect(r.created).toBe(2);
    const all = await db().select().from(s.customers);
    expect(all).toHaveLength(2);
    const ahmad = all.find((c) => c.name === "أحمد")!;
    expect(ahmad.creditLimit).toBe("500.00");
    expect(ahmad.defaultPriceTier).toBe("RETAIL");
  });

  it("يتخطّى الموجود بالهاتف دون كتابة مكرّر", async () => {
    await importCustomers([{ rowNumber: 1, name: "أحمد", phone: "0770111" }], {}, actor);
    const r = await importCustomers(
      [
        { rowNumber: 1, name: "أحمد مكرّر", phone: "0770111" },
        { rowNumber: 2, name: "جديد", phone: "0770222" },
      ],
      { onExisting: "skip" },
      actor,
    );
    expect(r.skipped).toBe(1);
    expect(r.created).toBe(1);
    expect(await db().select().from(s.customers)).toHaveLength(2);
  });

  // مُحدَّث بنصّ العقد §٤.٣.٤-ب: الهاتف وحده لم يعد مفتاح تكرار — المفتاح (الهاتف+الاسم) أو legacyCode.
  it("الكل-أو-لا-شيء: تكرار داخل الملف (نفس الهاتف والاسم) يمنع الكتابة كاملة", async () => {
    const r = await importCustomers(
      [
        { rowNumber: 1, name: "أ", phone: "0770111" },
        { rowNumber: 2, name: "أ", phone: "0770111" },
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(s.customers)).toHaveLength(0);
  });

  it("هاتف مشترك لاسمين مختلفين ليس تكراراً (عائلة/محل واحد — §٤.٣.٤-ب)", async () => {
    const r = await importCustomers(
      [
        { rowNumber: 1, name: "أب العائلة", phone: "0770111" },
        { rowNumber: 2, name: "ابن العائلة", phone: "0770111" },
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    expect(r.created).toBe(2);
    expect(await db().select().from(s.customers)).toHaveLength(2);
  });

  it("تكرار legacyCode داخل الملف يفشل برسالة تذكر الرقم المزدوج", async () => {
    const r = await importCustomers(
      [
        { rowNumber: 1, name: "أ", legacyCode: "118" },
        { rowNumber: 2, name: "ب", legacyCode: "118" },
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    const failedRow = r.rows.find((x) => x.rowNumber === 2);
    expect(failedRow?.status).toBe("failed");
    expect(failedRow?.message).toContain("118");
  });

  it("legacyCode بحالتي أحرف («A1»/«a1») يُكشف تكراراً — مرآة قيد UNIQUE غير الحسّاس للحالة", async () => {
    // بدون التوحيد كان الصفّان يجتازان الفحص ثم يسقطان على uq_customer_legacy وقت الكتابة برسالة خام.
    const r = await importCustomers(
      [
        { rowNumber: 1, name: "أ", legacyCode: "A1" },
        { rowNumber: 2, name: "ب", legacyCode: "a1" },
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    expect(r.rows.find((x) => x.rowNumber === 2)?.status).toBe("failed");
    expect(await db().select().from(s.customers)).toHaveLength(0);
  });

  it("مطابقة legacyCode عند إعادة الاستيراد غير حسّاسة للحالة (تخطٍّ لا اصطدام بالقاعدة)", async () => {
    await importCustomers([{ rowNumber: 1, name: "لاتيني", legacyCode: "AB7" }], {}, actor);
    const r = await importCustomers([{ rowNumber: 1, name: "لاتيني", legacyCode: "ab7" }], {}, actor);
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);
    expect(await db().select().from(s.customers)).toHaveLength(1);
  });

  it("dryRun لا يكتب شيئاً", async () => {
    const r = await importCustomers([{ rowNumber: 1, name: "معاينة" }], { dryRun: true }, actor);
    expect(r.committed).toBe(false);
    expect(await db().select().from(s.customers)).toHaveLength(0);
  });

  it("update يحدّث الموجود بالحقول غير الفارغة فقط", async () => {
    await importCustomers([{ rowNumber: 1, name: "أحمد", phone: "0770111" }], {}, actor);
    const r = await importCustomers(
      [{ rowNumber: 1, name: "أحمد", phone: "0770111", city: "بغداد" }],
      { onExisting: "update" },
      actor,
    );
    expect(r.updated).toBe(1);
    const c = (await db().select().from(s.customers).where(eq(s.customers.phone, "0770111")).limit(1))[0];
    expect(c.city).toBe("بغداد");
  });

  it("يتخطّى الموجود بلا هاتف بمطابقة اسم غير حسّاسة للحالة (لا تكرار)", async () => {
    await db().insert(s.customers).values({ name: "ahmed co", phone: null });
    const r = await importCustomers([{ rowNumber: 1, name: "AHMED CO" }], { onExisting: "skip" }, actor);
    expect(r.skipped).toBe(1);
    expect(r.created).toBe(0);
    expect(await db().select().from(s.customers)).toHaveLength(1);
  });
});

// ───────────────────────── الموردون ─────────────────────────

describe("importSuppliers", () => {
  it("ينشئ موردين جدداً", async () => {
    const rows: SupplierImportRow[] = [
      { rowNumber: 1, name: "مورد ١", phone: "0780111", email: "a@b.com" },
      { rowNumber: 2, name: "مورد ٢" },
    ];
    const r = await importSuppliers(rows, {}, actor);
    expect(r.committed).toBe(true);
    expect(r.created).toBe(2);
    expect(await db().select().from(s.suppliers)).toHaveLength(2);
  });
});

// ───────────────────────── المنتجات ─────────────────────────

describe("importProducts", () => {
  const baseRow = (over: Partial<ProductImportRow>): ProductImportRow => ({
    rowNumber: 1,
    productName: "قلم",
    sku: "PEN-1",
    costPrice: "1.00",
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
    priceTier: "RETAIL",
    price: "2.00",
    ...over,
  });

  it("ينشئ شجرة منتج كاملة (منتج+متغيّر+وحدة+سعر)", async () => {
    const r = await importProducts([baseRow({})], {}, actor);
    expect(r.committed).toBe(true);
    expect(r.created).toBe(1);
    expect((await db().select().from(s.products))[0].name).toBe("قلم");
    const v = (await db().select().from(s.productVariants))[0];
    expect(v.sku).toBe("PEN-1");
    expect(v.costPrice).toBe("1.00");
    const u = (await db().select().from(s.productUnits))[0];
    expect(u.isBaseUnit).toBe(true);
    const pr = (await db().select().from(s.productPrices))[0];
    expect(pr.price).toBe("2.00");
    expect(pr.priceTier).toBe("RETAIL");
  });

  it("منتج بوحدتين (قطعة أساس + درزن) بأسعار", async () => {
    const r = await importProducts(
      [
        baseRow({ rowNumber: 1 }),
        baseRow({ rowNumber: 2, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, barcode: "600123", price: "22.00" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    expect(await db().select().from(s.productUnits)).toHaveLength(2);
    expect(await db().select().from(s.productVariants)).toHaveLength(1);
  });

  it("يرفض وحدة أساس بمعامل ≠ ١ (لا كتابة)", async () => {
    const r = await importProducts([baseRow({ conversionFactor: "5" })], {}, actor);
    expect(r.committed).toBe(false);
    expect(await db().select().from(s.products)).toHaveLength(0);
  });

  it("يرفض وحدة غير أساس بمعامل كسري", async () => {
    const r = await importProducts(
      [
        baseRow({ rowNumber: 1 }),
        baseRow({ rowNumber: 2, unitName: "نصف", conversionFactor: "1.5", isBaseUnit: false, price: "1.00" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
  });

  it("يتطلّب وحدة أساس واحدة بالضبط", async () => {
    const r = await importProducts([baseRow({ isBaseUnit: false })], {}, actor);
    expect(r.committed).toBe(false);
  });

  it("يتخطّى نفس المنتج وSKU عند إعادة الاستيراد", async () => {
    await importProducts([baseRow({})], {}, actor);
    const r = await importProducts([baseRow({})], { onExisting: "skip" }, actor);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(s.products)).toHaveLength(1);
  });

  it("يسمح بنفس SKU في منتجين مختلفين عند اختلاف الباركود/غيابه", async () => {
    const r = await importProducts(
      [
        baseRow({ rowNumber: 1, productName: "منتج أ", sku: "PR-BLU" }),
        baseRow({ rowNumber: 2, productName: "منتج ب", sku: "PR-BLU" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    expect(r.created).toBe(2);
    const variants = await db().select().from(s.productVariants).where(eq(s.productVariants.sku, "PR-BLU"));
    expect(variants).toHaveLength(2);
  });

  it("ينشئ التصنيف الناقص تلقائياً", async () => {
    const r = await importProducts([baseRow({ categoryName: "قرطاسية" })], {}, actor);
    expect(r.committed).toBe(true);
    const cats = await db().select().from(s.categories);
    expect(cats.some((c) => c.name === "قرطاسية")).toBe(true);
  });

  it("يرفض باركوداً مكرّراً داخل الملف", async () => {
    const r = await importProducts(
      [
        baseRow({ rowNumber: 1, sku: "A", productName: "منتج أ", barcode: "999" }),
        baseRow({ rowNumber: 2, sku: "B", productName: "منتج ب", barcode: "999" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
  });

  it("يرفض تكلفة متعارضة لنفس الـ SKU (لا دمج صامت)", async () => {
    const r = await importProducts(
      [
        baseRow({ rowNumber: 1, costPrice: "1.00" }),
        baseRow({ rowNumber: 2, costPrice: "9.00" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    expect(await db().select().from(s.products)).toHaveLength(0);
  });

  it("يرفض معامل تحويل متعارضاً لنفس الوحدة", async () => {
    const r = await importProducts(
      [
        baseRow({ rowNumber: 1, conversionFactor: "1" }),
        baseRow({ rowNumber: 2, conversionFactor: "2" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
  });

  it("يرفض سعراً متعارضاً لنفس (الوحدة، الفئة)", async () => {
    const r = await importProducts(
      [
        baseRow({ rowNumber: 1, price: "2.00" }),
        baseRow({ rowNumber: 2, price: "5.00" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
  });

  it("لا يرفض SKU مرتبطاً بأكثر من منتج", async () => {
    const r = await importProducts(
      [
        baseRow({ rowNumber: 1, productName: "منتج أ" }),
        baseRow({ rowNumber: 2, productName: "منتج ب" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    expect(r.created).toBe(2);
  });

  it("ينشئ تصنيفاً واحداً لاسمين يختلفان بالحالة فقط", async () => {
    const r = await importProducts(
      [
        baseRow({ rowNumber: 1, sku: "A", productName: "منتج أ", categoryName: "Stationery" }),
        baseRow({ rowNumber: 2, sku: "B", productName: "منتج ب", categoryName: "stationery" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    expect(await db().select().from(s.categories)).toHaveLength(1);
  });
});

// ═════════════════ شريحة تكامل الاستيراد (§٥) — الدلالات المالية الحسّاسة ═════════════════

/** قيود OPENING المسجَّلة في الدفتر (قيد ترسيخ الرصيد الافتتاحي المستورد). */
async function openingEntries() {
  return db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "OPENING"));
}

describe("importCustomers — الرصيد الافتتاحي (§٥.٢)", () => {
  it("ينشئ عميلاً برصيد IQD داخل نفس INSERT + قيد OPENING مرجعي بـdedupeKey", async () => {
    const r = await importCustomers(
      [{ rowNumber: 1, name: "شركة المعارف", phone: "+9647901199308", openingBalance: "2988100", currency: "IQD", legacyCode: "118" }],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    const c = (await db().select().from(s.customers))[0];
    expect(c.currentBalance).toBe("2988100.00");
    expect(c.legacyCode).toBe("118");
    const entries = await openingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe("2988100.00");
    expect(Number(entries[0].customerId)).toBe(Number(c.id));
    expect(entries[0].dedupeKey).toBe(`OPENING:CUSTOMER:${c.id}`);
    expect(entries[0].revenue).toBe("0.00");
    expect(entries[0].profit).toBe("0.00");
    expect(entries[0].notes).toContain("رصيد افتتاحي");
  });

  it("يحوّل رصيد USD بسعر الصرف بدقة decimal.js (تقريب HALF_UP)", async () => {
    // 10.01 × 1390.5 = 13918.905 ⇒ HALF_UP لمنزلتين = 13918.91
    const r = await importCustomers(
      [{ rowNumber: 1, name: "دولاري", openingBalance: "10.01", currency: "USD" }],
      { usdRate: "1390.5" },
      actor,
    );
    expect(r.committed).toBe(true);
    const c = (await db().select().from(s.customers))[0];
    expect(c.currentBalance).toBe("13918.91");
    expect((await openingEntries())[0].amount).toBe("13918.91");
  });

  it("USD بلا usdRate ⇒ فشل الصف ولا كتابة (الكل أو لا شيء)", async () => {
    const r = await importCustomers(
      [{ rowNumber: 1, name: "دولاري", openingBalance: "977899.5", currency: "USD" }],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    expect(r.failed).toBe(1);
    expect(r.rows[0].message).toContain("سعر صرف الدولار");
    expect(await db().select().from(s.customers)).toHaveLength(0);
  });

  it("رصيد ≠ 0 بلا عملة ⇒ فشل الصف (لا افتراض IQD صامت)", async () => {
    const r = await importCustomers([{ rowNumber: 1, name: "بلا عملة", openingBalance: "500" }], {}, actor);
    expect(r.committed).toBe(false);
    expect(r.rows[0].message).toContain("حدّد العملة");
  });

  it("رصيد صفري بلا عملة يمرّ — بلا قيد OPENING", async () => {
    const r = await importCustomers([{ rowNumber: 1, name: "صفري", openingBalance: "0" }], {}, actor);
    expect(r.committed).toBe(true);
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("0.00");
    expect(await openingEntries()).toHaveLength(0);
  });

  it("الرصيد يُطبَّق عند الإنشاء فقط: التحديث يتجاهله برسالة صريحة وبلا قيد", async () => {
    await importCustomers([{ rowNumber: 1, name: "أحمد", phone: "0770111" }], {}, actor);
    const r = await importCustomers(
      [{ rowNumber: 1, name: "أحمد", phone: "0770111", openingBalance: "999", currency: "IQD" }],
      { onExisting: "update" },
      actor,
    );
    expect(r.updated).toBe(1);
    expect(r.rows[0].message).toContain("لا يُطبَّق على موجود");
    expect((await db().select().from(s.customers))[0].currentBalance).toBe("0.00");
    expect(await openingEntries()).toHaveLength(0);
  });

  it("إعادة الاستيراد (skip الافتراضي) لا تكرّر الرصيد ولا قيد OPENING", async () => {
    const row: CustomerImportRow = { rowNumber: 1, name: "مدين", legacyCode: "269", openingBalance: "724700", currency: "IQD" };
    await importCustomers([row], {}, actor);
    const r2 = await importCustomers([row], {}, actor);
    expect(r2.skipped).toBe(1);
    expect(r2.created).toBe(0);
    const all = await db().select().from(s.customers);
    expect(all).toHaveLength(1);
    expect(all[0].currentBalance).toBe("724700.00");
    expect(await openingEntries()).toHaveLength(1);
  });

  it("lastDealtAt تُلحق بالملاحظات وisActive=false يُحترم عند الإنشاء", async () => {
    const r = await importCustomers(
      [{ rowNumber: 1, name: "قديم", legacyCode: "41", isActive: false, lastDealtAt: "2026-01-07", notes: "ملاحظة أصلية" }],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    const c = (await db().select().from(s.customers))[0];
    expect(c.isActive).toBe(false);
    expect(c.notes).toContain("ملاحظة أصلية");
    expect(c.notes).toContain("آخر تعامل (النظام القديم): 2026-01-07");
  });

  it("مطابقة legacyCode تسبق الهاتف: تعديل هاتف لا يولّد طرفاً مزدوجاً برصيد", async () => {
    await importCustomers(
      [{ rowNumber: 1, name: "الأصل", phone: "+9647700000001", legacyCode: "74", openingBalance: "1000", currency: "IQD" }],
      {},
      actor,
    );
    // عميل آخر يملك الهاتف الجديد — يجب ألّا يُطابَق (legacyCode أولاً).
    await db().insert(s.customers).values({ name: "صاحب الهاتف الجديد", phone: "+9647700000002" });
    const r = await importCustomers(
      [{ rowNumber: 1, name: "الأصل", phone: "+9647700000002", legacyCode: "74" }],
      { onExisting: "update" },
      actor,
    );
    expect(r.updated).toBe(1);
    expect(r.created).toBe(0);
    const all = await db().select().from(s.customers);
    expect(all).toHaveLength(2); // لا طرف ثالث مزدوج
    const orig = all.find((c) => c.legacyCode === "74")!;
    expect(orig.phone).toBe("+9647700000002");
    expect(orig.currentBalance).toBe("1000.00"); // الرصيد لم يُمسّ عند التحديث
    expect(await openingEntries()).toHaveLength(1);
  });

  it("skipFailed يكتب الصالح فقط ويُبقي الفاشل في الملخّص (§٥.٤)", async () => {
    const r = await importCustomers(
      [
        { rowNumber: 1, name: "صالح", openingBalance: "100", currency: "IQD" },
        { rowNumber: 2, name: "فاشل", openingBalance: "50", currency: "USD" }, // بلا usdRate
      ],
      { skipFailed: true },
      actor,
    );
    expect(r.committed).toBe(true);
    expect(r.created).toBe(1);
    expect(r.failed).toBe(1);
    const all = await db().select().from(s.customers);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("صالح");
  });
});

describe("importSuppliers — الرصيد الافتتاحي والعكس (§٥.٢)", () => {
  it("invert يعكس الإشارة: سالب الملف (ندين له) ⇒ AP موجب + قيد OPENING للمورد", async () => {
    const r = await importSuppliers(
      [{ rowNumber: 1, name: "معمل المنتظر", openingBalance: "-27749996", currency: "IQD", legacyCode: "73" }],
      { balanceSign: "invert" },
      actor,
    );
    expect(r.committed).toBe(true);
    const sup = (await db().select().from(s.suppliers))[0];
    expect(sup.currentBalance).toBe("27749996.00");
    expect(sup.legacyCode).toBe("73");
    const entries = await openingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe("27749996.00");
    expect(Number(entries[0].supplierId)).toBe(Number(sup.id));
    expect(entries[0].dedupeKey).toBe(`OPENING:SUPPLIER:${sup.id}`);
  });

  it("asIs (الافتراض) يُبقي الإشارة كما في الملف", async () => {
    const r = await importSuppliers(
      [{ rowNumber: 1, name: "مورد بسالب صريح", openingBalance: "-28920682.01", currency: "IQD" }],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    expect((await db().select().from(s.suppliers))[0].currentBalance).toBe("-28920682.01");
  });

  it("invert مع USD: التحويل بسعر الصرف أولاً ثم عكس الإشارة", async () => {
    // -100 USD × 1450 = -145000 ⇒ invert ⇒ +145000
    const r = await importSuppliers(
      [{ rowNumber: 1, name: "مورد دولاري", openingBalance: "-100", currency: "USD" }],
      { usdRate: "1450", balanceSign: "invert" },
      actor,
    );
    expect(r.committed).toBe(true);
    expect((await db().select().from(s.suppliers))[0].currentBalance).toBe("145000.00");
  });
});

describe("reconcile بعد الاستيراد — صفر انحراف (§٥.٢، اختبار إلزامي)", () => {
  it("reconcileCustomerBalances وreconcileSupplierBalances يعودان فارغَين بعد استيراد بأرصدة", async () => {
    await importCustomers(
      [
        { rowNumber: 1, name: "مدين", legacyCode: "1", openingBalance: "2988100", currency: "IQD" },
        { rowNumber: 2, name: "دافع مقدماً", legacyCode: "2", openingBalance: "-500", currency: "IQD" },
        { rowNumber: 3, name: "دولاري", legacyCode: "3", openingBalance: "100.50", currency: "USD" },
      ],
      { usdRate: "1450" },
      actor,
    );
    await importSuppliers(
      [
        { rowNumber: 1, name: "مورد ندين له", legacyCode: "73", openingBalance: "-27749996", currency: "IQD" },
        { rowNumber: 2, name: "مورد صفري", legacyCode: "74", openingBalance: "0", currency: "IQD" },
      ],
      { balanceSign: "invert" },
      actor,
    );
    expect(await reconcileCustomerBalances()).toHaveLength(0);
    expect(await reconcileSupplierBalances()).toHaveLength(0);
  });
});

describe("writeErrorMessage — تعريب أخطاء الكتابة (لا رسائل SQL خام للواجهة)", () => {
  /** يحاكي DrizzleQueryError: رسالة «Failed query: …» تلفّ خطأ mysql2 في cause. */
  const drizzleErr = (code: string, sqlMessage: string) =>
    Object.assign(new Error(`Failed query: insert into \`customers\` (...) values (...) params: أحمد,+9647701234567`), {
      cause: Object.assign(new Error(sqlMessage), { code, sqlMessage }),
    });

  it("اصطدام حارس السباق uq_customer_legacy ⇒ رسالة تعافٍ عربية تذكر القيمة لا القيد", () => {
    const m = writeErrorMessage(drizzleErr("ER_DUP_ENTRY", "Duplicate entry '118' for key 'customers.uq_customer_legacy'"));
    expect(m).toContain("تعارض استيراد متزامن");
    expect(m).toContain("«118»");
    expect(m).not.toContain("Duplicate");
    expect(m).not.toContain("uq_customer_legacy");
  });

  it("رسالة drizzle الخام (Failed query) لا تمرّ ولو حوت نصاً عربياً من بيانات الصفوف", () => {
    const m = writeErrorMessage(drizzleErr("ER_DATA_TOO_LONG", "Data too long for column 'phone' at row 1"));
    expect(m).not.toContain("Failed query");
    expect(m).toContain("الهاتف"); // خريطة errorMap تسمّي العمود بالعربية
  });

  it("ER_DUP_ENTRY عام (غير legacy/باركود) ⇒ رسالة الخريطة العربية العامة", () => {
    const m = writeErrorMessage(drizzleErr("ER_DUP_ENTRY", "Duplicate entry 'x' for key 'customers.PRIMARY'"));
    expect(m).toContain("موجود مسبقاً");
  });

  it("خطأ أعمال عربي من خدماتنا (داخل withTx) يمرّ كما هو", () => {
    expect(writeErrorMessage(new Error("المخزون غير كافٍ لإتمام الحركة"))).toBe("المخزون غير كافٍ لإتمام الحركة");
  });

  // نفس الحماية في المسار العام (errorFormatter عبر toArabicMessage) — كشفته الجولة البصرية:
  // «Failed query» بمعاملات عربية («قطعة») كان يخدع كشف رسالة الأعمال فيتسرّب SQL خاماً للواجهة.
  it("toArabicMessage: «Failed query» بمعاملات عربية لا يمرّ — يُحال لخريطة MySQL", () => {
    const err = drizzleErr("ER_DUP_ENTRY", "Duplicate entry '500' for key 'productUnits.productUnits_barcode_unique'");
    const m = toArabicMessage({ trpcCode: "INTERNAL_SERVER_ERROR", originalMessage: err.message, cause: err });
    expect(m).not.toContain("Failed query");
    expect(m).toContain("موجود مسبقاً");
  });

  it("toArabicMessage: رسالة أعمال عربية حقيقية تمرّ كما هي", () => {
    const m = toArabicMessage({ trpcCode: "BAD_REQUEST", originalMessage: "اسم المنتج مطلوب" });
    expect(m).toBe("اسم المنتج مطلوب");
  });
});

describe("مخططات zod (§٥.١)", () => {
  it("usdRate صفري/سالب/غير رقمي يُرفض في المخطط — الموجب يمرّ", () => {
    expect(usdRateStr.safeParse("0").success).toBe(false);
    expect(usdRateStr.safeParse("0.00").success).toBe(false);
    expect(usdRateStr.safeParse("-1").success).toBe(false);
    expect(usdRateStr.safeParse("abc").success).toBe(false);
    expect(usdRateStr.safeParse("1450.25").success).toBe(true);
  });

  it("openingStock السالب والكسري يُرفضان في مخطط المنتج", () => {
    const base = { rowNumber: 1, productName: "قلم", barcode: "B1" };
    expect(productImportRow.safeParse({ ...base, openingStock: -1 }).success).toBe(false);
    expect(productImportRow.safeParse({ ...base, openingStock: 2.5 }).success).toBe(false);
    expect(productImportRow.safeParse({ ...base, openingStock: 0 }).success).toBe(true);
  });

  it("افتراضات المنتج تُطبَّق في المخطط: تكلفة 0 + وحدة «قطعة» + معامل 1", () => {
    const parsed = productImportRow.parse({ rowNumber: 1, productName: "قلم", barcode: "B1" });
    expect(parsed.costPrice).toBe("0");
    expect(parsed.unitName).toBe("قطعة");
    expect(parsed.conversionFactor).toBe("1");
    expect(parsed.isBaseUnit).toBeUndefined(); // الافتراض المشروط يُحسم في التجميع لا هنا
  });

  it("customerImportRow يقبل الرصيد الموقَّع ويرفض ٣ منازل وتاريخاً مقلوباً", () => {
    const base = { rowNumber: 1, name: "أ" };
    expect(customerImportRow.safeParse({ ...base, openingBalance: "-123.45", currency: "IQD" }).success).toBe(true);
    expect(customerImportRow.safeParse({ ...base, openingBalance: "1.234" }).success).toBe(false);
    expect(customerImportRow.safeParse({ ...base, openingBalance: "[123]" }).success).toBe(false); // الأقواس يحوّلها العميل
    expect(customerImportRow.safeParse({ ...base, lastDealtAt: "07-01-2026" }).success).toBe(false);
    expect(customerImportRow.safeParse({ ...base, lastDealtAt: "2026-01-07" }).success).toBe(true);
  });
});

describe("importProducts — شريحة تكامل الاستيراد (§٥.١/§٥.٣)", () => {
  // عبر parse: تُطبَّق افتراضات المخطط (تكلفة/وحدة/معامل) كما تصل من الراوتر فعلاً.
  const row = (over: Partial<ProductImportRow> & { rowNumber?: number }): ProductImportRow =>
    productImportRow.parse({ rowNumber: 1, productName: "منتج", ...over });

  it("sku من الباركود عند غيابه + الافتراض المشروط لوحدة الأساس + مخزون افتتاحي", async () => {
    const r = await importProducts(
      [row({ barcode: "6935403104236", retailPrice: "3500", openingStock: 4 })],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    const v = (await db().select().from(s.productVariants))[0];
    expect(v.sku).toBe("6935403104236"); // fallback من الباركود
    expect(v.costPrice).toBe("0.00"); // افتراض التكلفة
    const u = (await db().select().from(s.productUnits))[0];
    expect(u.unitName).toBe("قطعة");
    expect(u.isBaseUnit).toBe(true); // صف واحد بلا تحديد ⇒ وحدته هي الأساس
    // المخزون الافتتاحي: حركة ADJUST بمرجع OPENING + رصيد فرع = 4 داخل نفس المعاملة.
    const stock = (await db().select().from(s.branchStock))[0];
    expect(stock.quantity).toBe(4);
    expect(Number(stock.branchId)).toBe(actor.branchId);
    const mv = (await db().select().from(s.inventoryMovements))[0];
    expect(mv.movementType).toBe("ADJUST");
    expect(mv.referenceType).toBe("OPENING");
    const pr = await db().select().from(s.productPrices);
    expect(pr).toHaveLength(1);
    expect(pr[0].priceTier).toBe("RETAIL");
    expect(pr[0].price).toBe("3500.00");
  });

  it("غياب SKU والباركود معاً ⇒ فشل الصف برسالة واضحة", async () => {
    const r = await importProducts([row({ retailPrice: "1000" })], {}, actor);
    expect(r.committed).toBe(false);
    expect(r.rows[0].message).toContain("حدّد SKU أو الباركود");
  });

  it("openingStock صفر لا يولّد حركة مخزون", async () => {
    const r = await importProducts([row({ barcode: "B-ZERO", retailPrice: "1000", openingStock: 0 })], {}, actor);
    expect(r.committed).toBe(true);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect(await db().select().from(s.branchStock)).toHaveLength(0);
  });

  it("صفّان لنفس sku كلاهما بلا تحديد أساس ⇒ فشل برسالة «وحدة أساس واحدة بالضبط»", async () => {
    const r = await importProducts(
      [
        row({ rowNumber: 1, sku: "S1", barcode: "B1", retailPrice: "1000" }),
        row({ rowNumber: 2, sku: "S1", barcode: "B2", unitName: "درزن", conversionFactor: "12", retailPrice: "10000" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    expect(r.rows.some((x) => x.message?.includes("وحدة أساس واحدة بالضبط"))).toBe(true);
  });

  it("الأسعار الثلاثة الصريحة + سعر 0 يُتخطّى (لا يُنشأ سعر للفئة)", async () => {
    const r = await importProducts(
      [row({ sku: "S2", barcode: "B3", retailPrice: "3500", wholesalePrice: "0", governmentPrice: "2500", isBaseUnit: true })],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    const pr = await db().select().from(s.productPrices);
    expect(pr).toHaveLength(2);
    const tiers = pr.map((p) => p.priceTier).sort();
    expect(tiers).toEqual(["GOVERNMENT", "RETAIL"]);
  });

  it("تعارض سعر صريح مع price القديم لنفس الفئة ⇒ فشل؛ والقيمة المتطابقة نصياً تمرّ", async () => {
    const r = await importProducts(
      [row({ sku: "S3", barcode: "B4", retailPrice: "3500", priceTier: "RETAIL", price: "4000", isBaseUnit: true })],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    expect(r.rows[0].message).toContain("سعر متعارض");

    // «3500» و«3500.00» قيمة واحدة بعد التطبيع النصّي — لا تعارض.
    const r2 = await importProducts(
      [row({ sku: "S4", barcode: "B5", retailPrice: "3500", priceTier: "RETAIL", price: "3500.00", isBaseUnit: true })],
      {},
      actor,
    );
    expect(r2.committed).toBe(true);
    expect(await db().select().from(s.productPrices)).toHaveLength(1);
  });

  it("إعادة استيراد ملف أصناف (sku=الباركود بالـfallback) ⇒ متجاوَز لا «باركود مُستخدَم» — الاستئناف ممكن", async () => {
    // ملف المالك بلا عمود SKU: sku ≡ barcode لكل صف، فالموجود مسبقاً يملك الاثنين معاً —
    // تقديم فحص التعارض كان يصنّفه «فاشل» ويُوقف بقية الدفعات (نقيض «إعادة التشغيل آمنة»).
    const rows = [row({ barcode: "RERUN-1", retailPrice: "1000", openingStock: 3 })];
    const r1 = await importProducts(rows, {}, actor);
    expect(r1.committed).toBe(true);
    const r2 = await importProducts(rows, {}, actor);
    expect(r2.failed).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.committed).toBe(false); // لا كتابة — والحوار يميّزها عن الفشل بالعدّادات
    expect(r2.rows[0].message).toContain("موجود مسبقاً");
    // لا ازدواج: منتج واحد ورصيد افتتاحي واحد.
    expect(await db().select().from(s.products)).toHaveLength(1);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(3);
  });

  it("باركود موجود في القاعدة لمتغيّرٍ من منتج آخر (sku مختلف) ⇒ فشل صريح لا تخطٍّ صامت", async () => {
    await importProducts([row({ productName: "الأصل", sku: "OWN-1", barcode: "CLASH-9", retailPrice: "1000" })], {}, actor);
    const r = await importProducts(
      [row({ productName: "دخيل", sku: "OWN-2", barcode: "CLASH-9", retailPrice: "2000" })],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    expect(r.rows[0].status).toBe("failed");
    expect(r.rows[0].message).toContain("باركود");
    expect(await db().select().from(s.products)).toHaveLength(1);
  });

  it("skipFailed يكتب المنتجات الصالحة فقط والفشل على مستوى المنتج كاملاً (§٥.٤)", async () => {
    const r = await importProducts(
      [
        row({ rowNumber: 1, productName: "صالح", sku: "OK1", barcode: "BB1", retailPrice: "1000" }),
        row({ rowNumber: 2, productName: "ناقص" }), // لا sku ولا باركود
      ],
      { skipFailed: true },
      actor,
    );
    expect(r.committed).toBe(true);
    expect(r.created).toBe(1);
    expect(r.failed).toBe(1);
    const all = await db().select().from(s.products);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("صالح");
  });
});
