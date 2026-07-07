// اختبارات موجات تحديث الأسعار (٧/٧/٢٦): ثوابت الأمان W1..W5 + المعاينة/التطبيق ذرّياً + السجلّ الدائم.
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import {
  applyPriceWave,
  previewPriceWave,
  listPriceWaves,
  getPriceUnitHistory,
} from "../priceWaveService";
import { withTx } from "../tx";

const TABLES = [
  "priceChangeLog", "priceUpdateWaves",
  "promotionTargets", "promotions",
  "productPrices", "productUnits", "productVariants", "products",
  "auditLogs", "categories",
  "users", "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() { await truncateTables(TABLES); }

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.categories).values([{ id: 1, name: "قرطاسية" }, { id: 2, name: "هدايا" }]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم أزرق", categoryId: 1 },
    { id: 2, name: "دفتر ٥٠", categoryId: 1 },
    { id: 3, name: "لعبة تخرّج", categoryId: 2 },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-B", costPrice: "4.00" },
    { id: 2, productId: 2, sku: "NB-50", costPrice: "10.00" },
    { id: 3, productId: 3, sku: "TOY-1", costPrice: "20.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 1, priceTier: "WHOLESALE", price: "8.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "20.00" },
    { productUnitId: 2, priceTier: "WHOLESALE", price: "16.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "50.00" },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("previewPriceWave — قراءة فقط + منطق الحساب", () => {
  it("رفع بنسبة ١٠٪ على الجميع: كل الصفوف يظهر لها newPrice = old × 1.10", async () => {
    const rows = await withTx((tx) => previewPriceWave(tx, {
      filters: {},
      changeType: "INCREASE_PERCENT",
      changeValue: "10",
    }));
    expect(rows.length).toBe(5);
    const pen = rows.find((r) => r.productUnitId === 1 && r.priceTier === "RETAIL");
    expect(pen!.oldPrice).toBe("10.00");
    expect(pen!.newPrice).toBe("11.00");
  });

  it("فلترة بالفئة: فئة قرطاسية فقط (٤ صفوف)", async () => {
    const rows = await withTx((tx) => previewPriceWave(tx, {
      filters: { categoryId: 1 },
      changeType: "INCREASE_PERCENT",
      changeValue: "10",
    }));
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.productUnitId !== 3)).toBe(true);
  });

  it("فلترة بفئة السعر: RETAIL فقط (٣ صفوف)", async () => {
    const rows = await withTx((tx) => previewPriceWave(tx, {
      filters: { priceTier: "RETAIL" },
      changeType: "INCREASE_PERCENT",
      changeValue: "5",
    }));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.priceTier === "RETAIL")).toBe(true);
  });

  it("فلترة بالبحث: 'قلم' يطابق منتجاً واحداً (٢ صفّ)", async () => {
    const rows = await withTx((tx) => previewPriceWave(tx, {
      filters: { productSearch: "قلم" },
      changeType: "INCREASE_PERCENT",
      changeValue: "5",
    }));
    expect(rows.length).toBe(2);
  });

  it("تخفيض بمبلغ ثابت: -2 د.ع لكل وحدة", async () => {
    const rows = await withTx((tx) => previewPriceWave(tx, {
      filters: { priceTier: "RETAIL" },
      changeType: "DECREASE_AMOUNT",
      changeValue: "2",
    }));
    const pen = rows.find((r) => r.productUnitId === 1)!;
    expect(pen.oldPrice).toBe("10.00");
    expect(pen.newPrice).toBe("8.00");
  });

  it("SET_MARGIN: السعر يُشتقّ من التكلفة × (1 + هامش%)", async () => {
    const rows = await withTx((tx) => previewPriceWave(tx, {
      filters: {},
      changeType: "SET_MARGIN",
      changeValue: "50", // هامش ٥٠٪
    }));
    // قلم تكلفته 4 ⇒ 4 × 1.50 = 6
    const pen = rows.find((r) => r.productUnitId === 1 && r.priceTier === "RETAIL");
    expect(pen!.newPrice).toBe("6.00");
  });

  it("W2: خفض بنسبة ٩٩٪ يقصّ السعر إلى 0.01 (لا صفر)", async () => {
    const rows = await withTx((tx) => previewPriceWave(tx, {
      filters: { priceTier: "RETAIL" },
      changeType: "DECREASE_PERCENT",
      changeValue: "99",
    }));
    for (const r of rows) {
      expect(Number(r.newPrice)).toBeGreaterThanOrEqual(0.01);
    }
  });

  it("belowCost=true حين السعر الجديد أقل من التكلفة", async () => {
    // قلم تكلفته 4 ⇒ خفض السعر من 10 إلى 3 = تحت التكلفة
    const rows = await withTx((tx) => previewPriceWave(tx, {
      filters: { productSearch: "قلم", priceTier: "RETAIL" },
      changeType: "DECREASE_AMOUNT",
      changeValue: "7",
    }));
    const pen = rows.find((r) => r.productUnitId === 1)!;
    expect(pen.newPrice).toBe("3.00");
    expect(pen.belowCost).toBe(true);
  });

  it("صفوف بلا تغيير فعلي تُستبعَد من المعاينة", async () => {
    const rows = await withTx((tx) => previewPriceWave(tx, {
      filters: {},
      changeType: "INCREASE_AMOUNT",
      changeValue: "0.001", // تقريب لصفر بعد round2
    }));
    // كل الأسعار مستوى 2 خانة عشرية ⇒ تغيير 0.001 يُقرَّب لصفر ⇒ يُستبعَد
    expect(rows.length).toBe(0);
  });

  it("لا صفوف بلا اسم موجة كذلك", async () => {
    const rows = await withTx((tx) => previewPriceWave(tx, {
      filters: { productSearch: "غير موجود xyz" },
      changeType: "INCREASE_PERCENT",
      changeValue: "10",
    }));
    expect(rows.length).toBe(0);
  });

  it("قيمة صفر مرفوضة", async () => {
    await expect(withTx((tx) => previewPriceWave(tx, {
      filters: {},
      changeType: "INCREASE_PERCENT",
      changeValue: "0",
    }))).rejects.toThrow(/أكبر من صفر/);
  });
});

describe("applyPriceWave — كتابة ذرّية + سجلّ", () => {
  it("رفع بنسبة ١٠٪: productPrices يُحدَّث + priceChangeLog يُدرَج + رأس الموجة يُخزَّن", async () => {
    const before = await db().select().from(s.productPrices);
    const beforeMap = new Map(before.map((r) => [`${r.productUnitId}-${r.priceTier}`, String(r.price)]));

    const res = await withTx((tx) => applyPriceWave(tx, {
      name: "رفع الدولار ٧/٧",
      description: "١٣٥٠ ⇒ ١٤٠٠",
      reason: "ارتفاع سعر الدولار",
      filters: {},
      changeType: "INCREASE_PERCENT",
      changeValue: "10",
    }, 1));

    expect(res.totalRows).toBe(5);
    expect(res.waveId).toBeGreaterThan(0);

    // الأسعار حُدِّثت
    const after = await db().select().from(s.productPrices);
    for (const r of after) {
      const oldP = beforeMap.get(`${r.productUnitId}-${r.priceTier}`)!;
      const expected = (Number(oldP) * 1.10).toFixed(2);
      expect(String(r.price)).toBe(expected);
    }

    // السجلّ يحوي ٥ أسطر مرتبطة بالموجة
    const log = await db().select().from(s.priceChangeLog).where(eq(s.priceChangeLog.waveId, res.waveId));
    expect(log.length).toBe(5);
    for (const l of log) {
      expect(l.reason).toBe("ارتفاع سعر الدولار");
      expect(l.actorUserId).toBe(1);
      expect(l.oldPrice).not.toBeNull();
    }

    // رأس الموجة موجود
    const wave = await db().select().from(s.priceUpdateWaves).where(eq(s.priceUpdateWaves.id, res.waveId));
    expect(wave[0].name).toBe("رفع الدولار ٧/٧");
    expect(wave[0].totalRows).toBe(5);
    expect(wave[0].changeType).toBe("INCREASE_PERCENT");
  });

  it("W3: صفوف تحت التكلفة بلا إذن ⇒ FORBIDDEN + rollback كامل", async () => {
    await expect(withTx((tx) => applyPriceWave(tx, {
      name: "تخفيض خطر",
      filters: { productSearch: "قلم", priceTier: "RETAIL" },
      changeType: "DECREASE_AMOUNT",
      changeValue: "7", // القلم: 10 - 7 = 3 < تكلفة 4
    }, 1))).rejects.toThrow(/تحت التكلفة/);

    // لم يُنشَأ رأس موجة
    const waves = await db().select().from(s.priceUpdateWaves);
    expect(waves.length).toBe(0);
    // ولا سجلّ
    const log = await db().select().from(s.priceChangeLog);
    expect(log.length).toBe(0);
    // ولم يتغيّر السعر
    const pen = await db().select().from(s.productPrices).where(
      and(eq(s.productPrices.productUnitId, 1), eq(s.productPrices.priceTier, "RETAIL"))
    );
    expect(String(pen[0].price)).toBe("10.00");
  });

  it("W3: مع allowBelowCost=true ⇒ يُطبَّق ويُسجَّل", async () => {
    const res = await withTx((tx) => applyPriceWave(tx, {
      name: "تخفيض استثنائي",
      filters: { productSearch: "قلم", priceTier: "RETAIL" },
      changeType: "DECREASE_AMOUNT",
      changeValue: "7",
      allowBelowCost: true,
    }, 1));
    expect(res.totalRows).toBe(1);
    const pen = await db().select().from(s.productPrices).where(
      and(eq(s.productPrices.productUnitId, 1), eq(s.productPrices.priceTier, "RETAIL"))
    );
    expect(String(pen[0].price)).toBe("3.00");
  });

  it("لا صفوف مطابقة ⇒ BAD_REQUEST (لا موجة فارغة)", async () => {
    await expect(withTx((tx) => applyPriceWave(tx, {
      name: "موجة فارغة",
      filters: { productSearch: "لا يوجد xyz" },
      changeType: "INCREASE_PERCENT",
      changeValue: "10",
    }, 1))).rejects.toThrow(/لا شيء/);
  });

  it("اسم فارغ مرفوض", async () => {
    await expect(withTx((tx) => applyPriceWave(tx, {
      name: "",
      filters: {},
      changeType: "INCREASE_PERCENT",
      changeValue: "10",
    }, 1))).rejects.toThrow(/اسم الموجة/);
  });
});

describe("listPriceWaves + getPriceUnitHistory", () => {
  it("قائمة الموجات: الأحدث أوّلاً", async () => {
    await withTx((tx) => applyPriceWave(tx, { name: "موجة ١", filters: {}, changeType: "INCREASE_PERCENT", changeValue: "5" }, 1));
    await withTx((tx) => applyPriceWave(tx, { name: "موجة ٢", filters: {}, changeType: "DECREASE_PERCENT", changeValue: "2" }, 1));
    const rows = await withTx((tx) => listPriceWaves(tx));
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe("موجة ٢"); // الأحدث أوّلاً
  });

  it("تاريخ سعر وحدة: يحصر السجلّ على productUnit واحد", async () => {
    await withTx((tx) => applyPriceWave(tx, {
      name: "رفع",
      filters: {}, changeType: "INCREASE_PERCENT", changeValue: "10",
    }, 1));
    await withTx((tx) => applyPriceWave(tx, {
      name: "خفض",
      filters: { productSearch: "قلم" }, changeType: "DECREASE_PERCENT", changeValue: "5",
    }, 1));
    const pen1History = await withTx((tx) => getPriceUnitHistory(tx, 1));
    // القلم (unit 1) تأثّر بالموجتين ⇒ ٤ سجلات (٢ لكل موجة: RETAIL + WHOLESALE)
    expect(pen1History.length).toBe(4);
    const pen2History = await withTx((tx) => getPriceUnitHistory(tx, 3)); // اللعبة
    // اللعبة تأثّرت بالموجة الأولى فقط (١ سجلّ لـRETAIL)
    expect(pen2History.length).toBe(1);
  });
});
