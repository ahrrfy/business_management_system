import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { eq, sql } from "drizzle-orm";
import {
  createOnlineOrder,
  quoteOnlineOrder,
  trackOnlineOrder,
  trackOnlineOrderByGuestToken,
  trackOnlineOrderForCustomer,
} from "../onlineOrderService";
import { getOnlineOrder } from "../storeAdmin/orderFulfillmentService";
import { saveProductCustomizationTemplate, setProductCustomizationTemplateActive } from "../productCustomizationService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  await truncateAllTables();
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.products).values({ id: 1, name: "دفتر", showInStore: true });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "TRACK-1", costPrice: "100.00" });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
    isStoreSaleUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" });
  await d.insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 20 });
  await d.insert(s.storeSettings).values({ id: 1, fulfillmentBranchId: 1, isOpen: true, freeShippingThreshold: "1.00" });
});

describe("online order tracking ownership", () => {
  it("يثبت تفاصيل التخصيص بنيوياً لكل سطر ولا يدمج تخصيصين مختلفين", async () => {
    await db().update(s.products).set({ isCustomizable: true, productType: "PRINT_SERVICE" }).where(eq(s.products.id, 1));
    await db().insert(s.productCustomizationTemplates).values({ id: 1, productId: 1, kind: "PRINT", title: "تفاصيل الطباعة" });
    await db().insert(s.productCustomizationFields).values([
      { templateId: 1, fieldKey: "text", label: "النص المطلوب", fieldType: "TEXTAREA", isRequired: true, sortOrder: 10, priceDelta: "250.00" },
      { templateId: 1, fieldKey: "color", label: "اللون", fieldType: "TEXT", isRequired: true, sortOrder: 20, priceDelta: "0.00" },
    ]);
    const lines = [
      { productUnitId: 1, quantity: 1, customization: { templateId: 1, values: { text: "شركة الرؤية", color: "أزرق" } } },
      { productUnitId: 1, quantity: 1, customization: { templateId: 1, values: { text: "مكتبة العربية", color: "أحمر" } } },
    ];

    const quote = await quoteOnlineOrder({ governorate: "baghdad", lines });
    expect(quote.lines).toHaveLength(2);
    expect(quote.lines[0]).toMatchObject({ unitPrice: "1250.00", customization: { unitPriceDelta: "250.00" } });
    const created = await createOnlineOrder({
      customerName: "زبون تخصيص",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "بغداد — الكرادة",
      clientRequestId: "custom-selection-structured-lines",
      lines,
    });
    const stored = await db().select().from(s.onlineOrderItems).where(eq(s.onlineOrderItems.onlineOrderId, created.orderId));
    expect(stored).toHaveLength(2);
    expect(stored.map((item) => item.customizationSnapshot?.values.find((value) => value.fieldKey === "text")?.value)).toEqual(["شركة الرؤية", "مكتبة العربية"]);
    await expect(createOnlineOrder({
      customerName: "زبون تخصيص",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "بغداد — الكرادة",
      clientRequestId: "custom-selection-structured-lines",
      lines,
    })).resolves.toMatchObject({ orderId: created.orderId });
  });

  it("يبقي علامة التخصيص صريحة حتى عندما تكون خلاصة الحقول فارغة", async () => {
    await db().update(s.products).set({ isCustomizable: true }).where(eq(s.products.id, 1));
    await db().insert(s.productCustomizationTemplates).values({ id: 1, productId: 1, kind: "GENERAL", title: "تخصيص اختياري" });
    const created = await createOnlineOrder({
      customerName: "زبون تخصيص اختياري",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "بغداد — الكرادة",
      clientRequestId: "empty-customization-summary",
      lines: [{ productUnitId: 1, quantity: 1, customization: { templateId: 1, values: {} } }],
    });
    const detail = await getOnlineOrder(created.orderId, null);
    expect(detail?.items[0]).toMatchObject({ hasCustomization: true, customizationSummary: null });
  });

  it("يرفض فروق أسعار تخصيص غير مالية أو سالبة أو خارج سعة العمود", async () => {
    await db().update(s.products).set({ isCustomizable: true }).where(eq(s.products.id, 1));
    const actor = { userId: 1, branchId: 1, role: "admin" };
    const field = {
      fieldKey: "printType",
      label: "نوع الطباعة",
      fieldType: "SELECT" as const,
      options: [{ value: "normal", label: "عادي", priceDelta: "0" }],
    };
    for (const priceDelta of ["abc", "-1", "0.001", "10000000000000"]) {
      await expect(saveProductCustomizationTemplate({
        productId: 1,
        kind: "PRINT",
        title: "تفاصيل الطباعة",
        fields: [{ ...field, priceDelta }],
      }, actor)).rejects.toThrow(/فرق السعر/);
    }
    await expect(saveProductCustomizationTemplate({
      productId: 1,
      kind: "PRINT",
      title: "تفاصيل الطباعة",
      fields: [{ ...field, options: [{ value: "normal", label: "عادي", priceDelta: "-5" }] }],
    }, actor)).rejects.toThrow(/فرق السعر/);
  });

  it("يمنع إعادة تفعيل قالب موروث بفروق أسعار غير صالحة ويعيد خطأ إعداد مضبوطاً", async () => {
    await db().update(s.products).set({ isCustomizable: true }).where(eq(s.products.id, 1));
    await db().insert(s.productCustomizationTemplates).values({ id: 1, productId: 1, kind: "GENERAL", title: "قالب موروث", isActive: false });
    await db().insert(s.productCustomizationFields).values({
      templateId: 1,
      fieldKey: "style",
      label: "النمط",
      fieldType: "SELECT",
      isRequired: true,
      optionsJson: [{ value: "legacy", label: "قديم", priceDelta: "-5" }],
      priceDelta: "0.00",
    });
    const actor = { userId: 1, branchId: 1, role: "admin" };
    await expect(setProductCustomizationTemplateActive(1, true, actor)).rejects.toThrow(/فرق السعر/);
    expect((await db().select({ isActive: s.productCustomizationTemplates.isActive }).from(s.productCustomizationTemplates).where(eq(s.productCustomizationTemplates.id, 1)))[0]?.isActive).toBe(false);

    await db().update(s.productCustomizationTemplates).set({ isActive: true }).where(eq(s.productCustomizationTemplates.id, 1));
    await expect(quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 1, customization: { templateId: 1, values: { style: "legacy" } } }],
    })).rejects.toThrow(/إعداد فرق السعر/);
  });

  it("يقبل طول الحقل المضبوط حتى عشرة آلاف ثم يفرض حد القالب نفسه", async () => {
    await db().update(s.products).set({ isCustomizable: true, productType: "PRINT_SERVICE" }).where(eq(s.products.id, 1));
    await db().insert(s.productCustomizationTemplates).values({ id: 1, productId: 1, kind: "PRINT", title: "نص طويل" });
    await db().insert(s.productCustomizationFields).values({
      templateId: 1,
      fieldKey: "details",
      label: "التفاصيل",
      fieldType: "TEXTAREA",
      isRequired: true,
      maxLength: 5_000,
      priceDelta: "0.00",
    });
    const accepted = "س".repeat(2_500);
    await expect(quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 1, customization: { templateId: 1, values: { details: accepted } } }],
    })).resolves.toMatchObject({ lines: [{ unitPrice: "1000.00" }] });
    await expect(quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 1, customization: { templateId: 1, values: { details: "س".repeat(5_001) } } }],
    })).rejects.toThrow(/تجاوز الحد/);
  });

  it("يرفض القالب غير المتوافق والقيم المرسلة لحقول مخفية", async () => {
    await db().update(s.products).set({ isCustomizable: true, productType: "PRINT_SERVICE" }).where(eq(s.products.id, 1));
    await db().insert(s.productCustomizationTemplates).values({ id: 1, productId: 1, kind: "GIFT", title: "قالب غير متوافق" });
    await expect(quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 1, customization: { templateId: 1, values: {} } }],
    })).rejects.toThrow(/نوع قالب التخصيص/);

    await db().update(s.productCustomizationTemplates).set({ kind: "PRINT" }).where(eq(s.productCustomizationTemplates.id, 1));
    await db().insert(s.productCustomizationFields).values([
      {
        templateId: 1,
        fieldKey: "mode",
        label: "طريقة التنفيذ",
        fieldType: "SELECT",
        isRequired: true,
        sortOrder: 10,
        optionsJson: [
          { value: "text", label: "نص", priceDelta: "0" },
          { value: "file", label: "ملف", priceDelta: "0" },
        ],
        priceDelta: "0.00",
      },
      {
        templateId: 1,
        fieldKey: "message",
        label: "النص",
        fieldType: "TEXT",
        isRequired: false,
        sortOrder: 20,
        dependencyJson: { fieldKey: "mode", operator: "equals", value: "text" },
        priceDelta: "0.00",
      },
      {
        templateId: 1,
        fieldKey: "signature",
        label: "التوقيع",
        fieldType: "TEXT",
        isRequired: false,
        sortOrder: 30,
        dependencyJson: { fieldKey: "message", operator: "notEquals", value: "blocked" },
        priceDelta: "0.00",
      },
    ]);
    await expect(quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{
        productUnitId: 1,
        quantity: 1,
        customization: { templateId: 1, values: { mode: "file", message: "قيمة مخفية" } },
      }],
    })).rejects.toThrow(/شرط ظهوره/);
    await expect(quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{
        productUnitId: 1,
        quantity: 1,
        customization: { templateId: 1, values: { mode: "file", signature: "قيمة مخفية بالتبعية" } },
      }],
    })).rejects.toThrow(/شرط ظهوره/);
  });

  it("يرفض تجاوز سعة المال في مجموع التخصيص والسعر النهائي وإجمالي السطر", async () => {
    await db().update(s.products).set({ isCustomizable: true, productType: "PRINT_SERVICE" }).where(eq(s.products.id, 1));
    await db().insert(s.productCustomizationTemplates).values({ id: 1, productId: 1, kind: "PRINT", title: "تخصيص مرتفع" });
    await db().insert(s.productCustomizationFields).values([
      { id: 1, templateId: 1, fieldKey: "first", label: "الأول", fieldType: "TEXT", isRequired: true, sortOrder: 10, priceDelta: "9999999999999.99" },
      { id: 2, templateId: 1, fieldKey: "second", label: "الثاني", fieldType: "TEXT", isRequired: true, sortOrder: 20, priceDelta: "1.00" },
    ]);
    const customization = { templateId: 1, values: { first: "أ", second: "ب" } };
    await expect(quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 1, customization }],
    })).rejects.toThrow(/مجموع فروق أسعار/);

    await db().update(s.productCustomizationFields).set({ priceDelta: "0.00" }).where(eq(s.productCustomizationFields.id, 2));
    await expect(quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 1, customization }],
    })).rejects.toThrow(/السعر النهائي بعد التخصيص/);

    await db().update(s.productCustomizationFields).set({ priceDelta: "0.00" }).where(eq(s.productCustomizationFields.id, 1));
    await db().update(s.productPrices).set({ price: "6000000000000.00" }).where(eq(s.productPrices.productUnitId, 1));
    await expect(quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 2, customization }],
    })).rejects.toThrow(/إجمالي هذا السطر/);
  });

  it("يغلق البحث الإرثي برقم متسلسل + هاتف حتى لو عرف المهاجم القيمتين", async () => {
    const created = await createOnlineOrder({
      customerName: "زبون",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "بغداد — الكرادة",
      clientRequestId: "legacy-tracking-must-close",
      lines: [{ productUnitId: 1, quantity: 1 }],
    });

    await expect(trackOnlineOrder(created.orderNumber, "07701234567")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("يصدر رمز ضيف opaque عالي العشوائية ويمكن إعادته بعد replay", async () => {
    const input = {
      customerName: "ضيف",
      customerPhone: "07801234567",
      governorate: "baghdad",
      addressText: "بغداد — المنصور",
      clientRequestId: "guest-tracking-token-replay",
      lines: [{ productUnitId: 1, quantity: 1 }],
    };
    const created = await createOnlineOrder(input);
    expect(created.guestTrackingToken).toMatch(/^[a-f0-9]{32}\.[a-z0-9]+\.[A-Za-z0-9_-]{43}$/);
    expect(created.guestTrackingExpiresAt).toBeInstanceOf(Date);

    const replay = await createOnlineOrder(input);
    expect(replay.guestTrackingToken).toBe(created.guestTrackingToken);
    expect(replay.guestTrackingExpiresAt?.getTime()).toBe(created.guestTrackingExpiresAt?.getTime());
  });

  it("يرفض رمز ضيف مزوراً أو منتهياً ولا يمكن إعادة توجيه رمز طلب إلى طلب آخر", async () => {
    const first = await createOnlineOrder({
      customerName: "الضيف الأول",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "بغداد — الكرادة",
      clientRequestId: "guest-token-order-first",
      lines: [{ productUnitId: 1, quantity: 1 }],
    });
    const second = await createOnlineOrder({
      customerName: "الضيف الثاني",
      customerPhone: "07801234567",
      governorate: "baghdad",
      addressText: "بغداد — المنصور",
      clientRequestId: "guest-token-order-second",
      lines: [{ productUnitId: 1, quantity: 1 }],
    });
    const firstToken = first.guestTrackingToken!;
    const forged = `${firstToken.slice(0, -1)}${firstToken.endsWith("A") ? "B" : "A"}`;
    await expect(trackOnlineOrderByGuestToken(forged)).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect((await trackOnlineOrderByGuestToken(second.guestTrackingToken!)).orderNumber).toBe(second.orderNumber);
    expect((await trackOnlineOrderByGuestToken(firstToken)).orderNumber).toBe(first.orderNumber);

    await db().execute(sql`
      UPDATE onlineOrders
      SET guestTrackingExpiresAt = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)
      WHERE id = ${first.orderId}
    `);
    await expect(trackOnlineOrderByGuestToken(firstToken)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("جلسة عميل لا ترى طلب عميل آخر حتى مع رقم الطلب الصحيح", async () => {
    const first = await createOnlineOrder({
      customerName: "المالك",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "بغداد — الكرادة",
      clientRequestId: "session-owned-order-first",
      lines: [{ productUnitId: 1, quantity: 1 }],
    });
    await createOnlineOrder({
      customerName: "الآخر",
      customerPhone: "07801234567",
      governorate: "baghdad",
      addressText: "بغداد — المنصور",
      clientRequestId: "session-owned-order-second",
      lines: [{ productUnitId: 1, quantity: 1 }],
    });
    const rows = await db().select({ id: s.customers.id, phone: s.customers.phone }).from(s.customers);
    const ownerId = Number(rows.find((row) => row.phone === "+9647701234567")!.id);
    const otherId = Number(rows.find((row) => row.phone === "+9647801234567")!.id);

    expect((await trackOnlineOrderForCustomer(first.orderNumber, ownerId)).orderNumber).toBe(first.orderNumber);
    await expect(trackOnlineOrderForCustomer(first.orderNumber, otherId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("GET القديم غير مركّب في الراوتر بينما مسارا POST الآمنان موجودان", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(
      new URL("../../routers/storefrontRouter.ts", import.meta.url),
      "utf8",
    ));
    expect(source).not.toContain("trackOrder: publicProcedure");
    expect(source).toContain("trackOrderPrivate: storefrontPublicWriteProcedure");
    expect(source).toContain("trackOrderByToken: storefrontPublicWriteProcedure");
    expect(source).toContain("z.string().max(10_000)");
    expect(source).toContain("couponCode: z.string().trim().min(1).max(64).optional()");
  });
});
