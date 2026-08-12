/**
 * هدايا/مجّانيّات داخل فاتورة البيع (هجرة 0149).
 *
 * الثابت الحاكم الذي تحرسه هذه الاختبارات:
 *   `invoices.costTotal` = `SALE.cost` = تكلفة **البنود المدفوعة وحدها**،
 *   وتكلفة البنود المُهداة تعيش في قيد `GIFT_OUT` وحده (إيراد=0، ربح=−التكلفة).
 * كسرُ هذا الثابت يعني إمّا اعترافاً مزدوجاً بالتكلفة (مرّةً في COGS ومرّةً مصروفَ هدايا) أو
 * تبخّرها كلّياً — وكلاهما ينفخ/يهبط الربح بلا أثرٍ ظاهر. وكلُّ قارئٍ قائمٍ للتكلفة يعتمد على
 * تطابق الطرفين (`COALESCE(ic.cost, i.costTotal)` في تقارير المبيعات، عكس التكلفة الكامل في
 * مرتجع التوصيل)، فالثابت ليس تجميلاً بل شرطُ صحّةِ ما بُنِي فوقه.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnSale } from "../returnService";
import { createSale } from "../saleService";

const actor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys",
  "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
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
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([{ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" }]);
  await d.insert(s.products).values([{ id: 1, name: "قلم" }, { id: 2, name: "طابعة" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" },
    // صنفٌ غالٍ لاختبار عتبة الإهداء (تكلفته وحدها تتجاوز ٥٠٬٠٠٠).
    { id: 2, productId: 2, sku: "PRN-1", costPrice: "60000.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "90000.00" },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "زبون", defaultPriceTier: "RETAIL", currentBalance: "0" });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 10 },
  ]);
}

async function entryOf(invoiceId: number, entryType: "SALE" | "RETURN" | "GIFT_OUT") {
  return await db()
    .select()
    .from(s.accountingEntries)
    .where(and(eq(s.accountingEntries.invoiceId, invoiceId), eq(s.accountingEntries.entryType, entryType)));
}

/** بيع نقديّ: ٥ أقلام مدفوعة (١٠ للقطعة، تكلفة ٤) + قلمان هديّةً (تكلفة ٤ للقطعة). */
async function sellWithGift(extra: Record<string, unknown> = {}) {
  return await createSale(
    {
      branchId: 1,
      customerId: 1,
      sourceType: "POS",
      lines: [
        { variantId: 1, productUnitId: 1, quantity: "5" },
        { variantId: 1, productUnitId: 1, quantity: "2", isGift: true },
      ],
      ...extra,
    },
    actor,
  );
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("سطر الهدية داخل فاتورة البيع", () => {
  it("يُخزَّن بسعر صفر ووسمِ هدية، بينما تبقى لقطة تكلفته الحقيقية", async () => {
    const sale = await sellWithGift();
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    const gift = items.find((i) => i.isGift)!;
    const paid = items.find((i) => !i.isGift)!;

    expect(items).toHaveLength(2);
    expect(Number(gift.unitPrice)).toBe(0);
    expect(Number(gift.total)).toBe(0);
    // لقطة التكلفة محفوظة كاملةً — هي أساس مصروف الهدية وعكسِه عند الإرجاع.
    expect(Number(gift.unitCost)).toBeCloseTo(4, 2);
    expect(Number(paid.total)).toBeCloseTo(50, 2);
  });

  it("لا يدخل إجمالي الفاتورة: الزبون يدفع ثمن المدفوع وحده", async () => {
    const sale = await sellWithGift();
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(Number(inv.subtotal)).toBeCloseTo(50, 2);
    expect(Number(inv.total)).toBeCloseTo(50, 2);
  });

  it("الثابت: invoices.costTotal = SALE.cost = تكلفة البنود المدفوعة وحدها", async () => {
    const sale = await sellWithGift();
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    const [saleEntry] = await entryOf(sale.invoiceId, "SALE");

    expect(Number(inv.costTotal)).toBeCloseTo(20, 2); // ٥×٤ — بلا تكلفة الهدية
    expect(Number(saleEntry.cost)).toBeCloseTo(Number(inv.costTotal), 2);
    expect(Number(saleEntry.revenue)).toBeCloseTo(50, 2);
    expect(Number(saleEntry.profit)).toBeCloseTo(30, 2); // ربحٌ حقيقيّ غير منقوصٍ بتكلفة الهدية
  });

  it("تكلفة الهدية تُرحَّل قيدَ GIFT_OUT واحداً: إيراد صفر وربحٌ سالبٌ بقدر التكلفة", async () => {
    const sale = await sellWithGift();
    const gifts = await entryOf(sale.invoiceId, "GIFT_OUT");

    expect(gifts).toHaveLength(1); // حارس dedupeKey: قيد هدايا واحد لكل فاتورة
    expect(Number(gifts[0].revenue)).toBe(0);
    expect(Number(gifts[0].cost)).toBeCloseTo(8, 2); // ٢×٤
    expect(Number(gifts[0].profit)).toBeCloseTo(-8, 2);
    expect(Number(gifts[0].amount)).toBeCloseTo(8, 2);
  });

  it("مجموع أثر الدفتر = الربح الحقيقي (لا اعتراف مزدوج بالتكلفة ولا تبخّرها)", async () => {
    const sale = await sellWithGift();
    const [saleEntry] = await entryOf(sale.invoiceId, "SALE");
    const [giftEntry] = await entryOf(sale.invoiceId, "GIFT_OUT");
    // إيراد ٥٠ − تكلفة مبيعات ٢٠ − هدايا ٨ = ٢٢.
    expect(Number(saleEntry.profit) + Number(giftEntry.profit)).toBeCloseTo(22, 2);
    // والتكلفة الكلّية المعترَف بها = تكلفة كلّ ما خرج من المخزن (٧ أقلام × ٤).
    expect(Number(saleEntry.cost) + Number(giftEntry.cost)).toBeCloseTo(28, 2);
  });

  it("الهدية تُخصَم من المخزون فعلياً كسائر البنود", async () => {
    await sellWithGift();
    const stock = (await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0];
    expect(stock.quantity).toBe(100 - 7); // ٥ مدفوعة + ٢ هدية
  });

  it("لا تُفعّل بوّابة «تحت التكلفة»/«خصم يدويّ» — مجّانيّتها مقصودة ومصنَّفة", async () => {
    // بلا priceOverrideApproved: قبل الإصلاح كان سطرٌ بسعر صفر انحرافاً ١٠٠٪ عن المرجع ⇒ رفض.
    await expect(sellWithGift()).resolves.toBeTruthy();
  });
});

describe("حوكمة الإهداء داخل الفاتورة (عتبة تكلفة الهدية)", () => {
  const expensiveGift = {
    branchId: 1,
    customerId: 1,
    sourceType: "POS" as const,
    lines: [
      { variantId: 1, productUnitId: 1, quantity: "5" },
      { variantId: 2, productUnitId: 2, quantity: "1", isGift: true }, // تكلفة ٦٠٬٠٠٠ > العتبة
    ],
  };

  it("هديةٌ تتجاوز تكلفتُها العتبة تُرفض بلا تفويض مدير", async () => {
    await expect(createSale(expensiveGift, actor)).rejects.toThrow(/تتجاوز حدّ الإهداء|موافقة مدير/);
  });

  it("لا تُنشئ فاتورةً ولا قيداً عند الرفض (المعاملة تتراجع كاملةً)", async () => {
    await createSale(expensiveGift, actor).catch(() => undefined);
    const invs = await db().select().from(s.invoices);
    const entries = await db().select().from(s.accountingEntries);
    expect(invs).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("تمرّ بموافقة مدير، وتُرحَّل تكلفتها كاملةً مصروفَ هدايا", async () => {
    const sale = await createSale({ ...expensiveGift, priceOverrideApproved: true }, actor);
    const [giftEntry] = await entryOf(sale.invoiceId, "GIFT_OUT");
    expect(Number(giftEntry.cost)).toBeCloseTo(60000, 2);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(Number(inv.total)).toBeCloseTo(50, 2); // الزبون يدفع الأقلام وحدها
  });
});

describe("مرتجع فاتورة فيها هدية", () => {
  async function giftItemId(invoiceId: number) {
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, invoiceId));
    return Number(items.find((i) => i.isGift)!.id);
  }

  it("إرجاع الهدية إلى الرفّ يعكس مصروفها في وعائه لا في COGS", async () => {
    const sale = await sellWithGift();
    const itemId = await giftItemId(sale.invoiceId);
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 2 }], restock: true }, actor);

    const [ret] = await entryOf(sale.invoiceId, "RETURN");
    expect(Number(ret.revenue)).toBe(0); // لم يُدفَع شيء ⇒ لا استرداد
    expect(Number(ret.cost)).toBe(0); // تكلفة الهدية ليست في وعاء COGS فلا تُعكَس منه

    const gifts = await entryOf(sale.invoiceId, "GIFT_OUT");
    const netGiftCost = gifts.reduce((a, g) => a + Number(g.cost), 0);
    expect(netGiftCost).toBeCloseTo(0, 2); // ٨ عند البيع − ٨ عند الإرجاع
  });

  it("الهدية التالفة (بلا إعادة للرفّ) تبقى مصروفاً — البضاعة ذهبت فعلاً", async () => {
    const sale = await sellWithGift();
    const itemId = await giftItemId(sale.invoiceId);
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: itemId, baseQuantity: 2 }], restock: false }, actor);

    const gifts = await entryOf(sale.invoiceId, "GIFT_OUT");
    expect(gifts).toHaveLength(1); // لا قيد عكسٍ
    expect(Number(gifts[0].cost)).toBeCloseTo(8, 2);
  });

  it("إرجاع البند المدفوع وحده لا يمسّ وعاء الهدايا", async () => {
    const sale = await sellWithGift();
    const items = await db().select().from(s.invoiceItems).where(eq(s.invoiceItems.invoiceId, sale.invoiceId));
    const paidId = Number(items.find((i) => !i.isGift)!.id);
    await returnSale({ invoiceId: sale.invoiceId, lines: [{ invoiceItemId: paidId, baseQuantity: 5 }], restock: true }, actor);

    const [ret] = await entryOf(sale.invoiceId, "RETURN");
    expect(Number(ret.revenue)).toBeCloseTo(-50, 2);
    expect(Number(ret.cost)).toBeCloseTo(-20, 2);
    const gifts = await entryOf(sale.invoiceId, "GIFT_OUT");
    expect(gifts).toHaveLength(1); // الهدية باقية عند الزبون ⇒ مصروفها باقٍ
    expect(Number(gifts[0].cost)).toBeCloseTo(8, 2);
  });
});

describe("أجرة التوصيل في فاتورة البيع", () => {
  it("تُحفَظ وتدخل الإجمالي والإيراد بلا تكلفة", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
        deliveryFee: "3000",
      },
      actor,
    );
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    const [saleEntry] = await entryOf(sale.invoiceId, "SALE");

    expect(Number(inv.deliveryFee)).toBeCloseTo(3000, 2);
    expect(Number(inv.total)).toBeCloseTo(3050, 2);
    expect(Number(saleEntry.revenue)).toBeCloseTo(3050, 2);
    expect(Number(saleEntry.cost)).toBeCloseTo(20, 2); // التوصيل إيرادٌ بلا تكلفة بضاعة
  });

  it("«توصيل مجاني» = صفر: لا إيراد توصيل ولا أثر على الإجمالي", async () => {
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
        deliveryFee: "0",
      },
      actor,
    );
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, sale.invoiceId)))[0];
    expect(Number(inv.deliveryFee)).toBe(0);
    expect(Number(inv.total)).toBeCloseTo(50, 2);
  });
});
