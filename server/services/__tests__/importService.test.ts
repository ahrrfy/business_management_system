import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  importCustomers,
  importProducts,
  importSuppliers,
  type CustomerImportRow,
  type ProductImportRow,
  type SupplierImportRow,
} from "../importService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "importBatches",
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

  it("الكل-أو-لا-شيء: تكرار داخل الملف يمنع الكتابة كاملة", async () => {
    const r = await importCustomers(
      [
        { rowNumber: 1, name: "أ", phone: "0770111" },
        { rowNumber: 2, name: "ب", phone: "0770111" },
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(s.customers)).toHaveLength(0);
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

  it("يتخطّى SKU موجوداً مسبقاً", async () => {
    await importProducts([baseRow({})], {}, actor);
    const r = await importProducts([baseRow({ productName: "قلم ٢" })], { onExisting: "skip" }, actor);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(await db().select().from(s.products)).toHaveLength(1);
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
});
