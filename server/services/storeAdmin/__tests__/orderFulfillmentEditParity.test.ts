import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { appRouter } from "../../../routers";
import { hashCouponCode } from "../../couponService";
import { createOnlineOrder } from "../../onlineOrderService";
import { truncateAllTables } from "../../__tests__/__testUtils__";
import {
  composeOrderShippingAddress,
  getOnlineOrder,
  updateOnlineOrder,
} from "../orderFulfillmentService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function makeAdminCaller() {
  const [admin] = await db()
    .select()
    .from(s.users)
    .where(eq(s.users.id, 1))
    .limit(1);
  if (!admin) throw new Error("Seeded admin user #1 missing");
  return appRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1" },
    res: {},
    user: admin,
    sessionId: null,
  } as never);
}

async function seedStoreWithDynamicZones() {
  const d = db();
  await d.insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await d.insert(s.users).values({
    id: 1,
    openId: "fulfillment-edit-admin",
    name: "مدير المتجر",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await d.insert(s.products).values({
    id: 1,
    name: "حقيبة مدرسية",
    showInStore: true,
  });
  await d.insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "BAG-01",
    color: "كحلي",
    costPrice: "2000.00",
  });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
    isStoreSaleUnit: true,
  });
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "4500.00" },
    { productUnitId: 1, priceTier: "WHOLESALE", price: "3500.00" },
  ]);
  await d.insert(s.branchStock).values({
    branchId: 1,
    variantId: 1,
    quantity: 30,
  });
  await d.insert(s.storeSettings).values({
    id: 1,
    fulfillmentBranchId: 1,
    isOpen: true,
    freeShippingThreshold: "50000.00",
    freeShippingThresholdGovernorates: "60000.00",
  });
  await d.insert(s.deliveryZones).values([
    {
      id: 10,
      code: "baghdad",
      name: "بغداد المركز المحدث",
      isActive: true,
      displayOrder: 1,
    },
    {
      id: 11,
      code: "basra",
      name: "البصرة المحدثة",
      isActive: true,
      displayOrder: 2,
    },
    {
      id: 12,
      code: "kirkuk",
      name: "كركوك الموقوفة",
      isActive: false,
      displayOrder: 3,
    },
  ]);
  await d.insert(s.deliveryPricingRules).values([
    {
      id: 100,
      zoneId: 10,
      ruleType: "FLAT_FEE",
      baseFee: "4000.00",
      isActive: true,
    },
    {
      id: 101,
      zoneId: 11,
      ruleType: "FLAT_FEE",
      baseFee: "9000.00",
      isActive: true,
    },
    {
      id: 102,
      zoneId: 12,
      ruleType: "FLAT_FEE",
      baseFee: "11000.00",
      isActive: true,
    },
  ]);
}

describe("orderFulfillmentService — transaction safety & admin edit parity", () => {
  beforeEach(async () => {
    await truncateAllTables();
    await seedStoreWithDynamicZones();
  });

  it("contains zero raw sql`COMMIT` or sql`ROLLBACK` statements inside orderFulfillmentService.ts", () => {
    const filePath = path.resolve(
      __dirname,
      "../orderFulfillmentService.ts",
    );
    const source = readFileSync(filePath, "utf8");
    expect(source).not.toMatch(/sql`\s*COMMIT\s*`/i);
    expect(source).not.toMatch(/sql`\s*ROLLBACK\s*`/i);
  });

  it("preserves retail-subtotal free shipping threshold in Baghdad and applies dynamic zone fee in governorates on address-only edits", async () => {
    // 12 units: retail = 12 * 4500 = 54,000 (>= Baghdad 50,000, < Governorates 60,000)
    // wholesale = 12 * 3500 = 42,000 (discount = 12,000)
    const created = await createOnlineOrder({
      customerName: "أحمد علي",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "المنصور شارع 14",
      notes: "قرب الصيدلية",
      lines: [{ productUnitId: 1, quantity: 12 }],
    });
    expect(created.subtotal).toBe("42000.00");
    expect(created.deliveryFree).toBe(true);
    expect(created.deliveryFee).toBe("0.00");
    expect(created.total).toBe("42000.00");

    // Address-only edit in Baghdad (items === undefined) MUST keep free shipping (retail 54,000 >= 50,000)
    const editedBaghdad = await updateOnlineOrder(
      {
        id: created.orderId,
        scopedBranchId: 1,
        shippingAddress: "المنصور شارع 16",
      },
      1,
    );
    expect(editedBaghdad.subtotal).toBe("42000.00");
    expect(editedBaghdad.deliveryFee).toBe("0.00");
    expect(editedBaghdad.total).toBe("42000.00");

    const rowAfterBaghdad = (
      await db()
        .select()
        .from(s.onlineOrders)
        .where(eq(s.onlineOrders.id, created.orderId))
        .limit(1)
    )[0]!;
    expect(rowAfterBaghdad.deliveryFree).toBe(true);
    expect(String(rowAfterBaghdad.deliveryWaivedAmount)).toBe("4000.00");
    // Street-only update (notes omitted) MUST preserve the customer's existing note!
    expect(rowAfterBaghdad.shippingAddress).toBe("المنصور شارع 16\nملاحظة: قرب الصيدلية");

    // Switching governorate to Basra (threshold 60,000 > retail 54,000) charges dynamic DB fee 9,000 (not static 8,000)
    const editedBasra = await updateOnlineOrder(
      {
        id: created.orderId,
        scopedBranchId: 1,
        governorate: "basra",
      },
      1,
    );
    expect(editedBasra.subtotal).toBe("42000.00");
    expect(editedBasra.deliveryFee).toBe("9000.00");
    expect(editedBasra.total).toBe("51000.00");
  });

  it("updates pricingBenefitType, pricingBenefitLabel, and pricingBenefitDiscount when items are edited across wholesale threshold", async () => {
    const created = await createOnlineOrder({
      customerName: "سارة محمد",
      customerPhone: "07702223344",
      governorate: "baghdad",
      addressText: "الكرادة داخل",
      lines: [{ productUnitId: 1, quantity: 12 }],
    });

    // Reduce from 12 -> 5 units: drops below wholesale minimum (12), clears WHOLESALE benefit
    await updateOnlineOrder(
      {
        id: created.orderId,
        scopedBranchId: 1,
        items: [{ productUnitId: 1, quantity: 5 }],
      },
      1,
    );

    const afterDrop = (
      await db()
        .select()
        .from(s.onlineOrders)
        .where(eq(s.onlineOrders.id, created.orderId))
        .limit(1)
    )[0]!;
    expect(afterDrop.pricingBenefitType).toBe("NONE");
    expect(afterDrop.pricingBenefitLabel).toBeNull();
    expect(String(afterDrop.pricingBenefitDiscount)).toBe("0.00");
    expect(String(afterDrop.subtotal)).toBe("22500.00");
    expect(String(afterDrop.shippingCost)).toBe("4000.00");
    expect(String(afterDrop.total)).toBe("26500.00");

    // Increase from 5 -> 12 units: restores WHOLESALE benefit fields
    await updateOnlineOrder(
      {
        id: created.orderId,
        scopedBranchId: 1,
        items: [{ productUnitId: 1, quantity: 12 }],
      },
      1,
    );

    const afterRestore = (
      await db()
        .select()
        .from(s.onlineOrders)
        .where(eq(s.onlineOrders.id, created.orderId))
        .limit(1)
    )[0]!;
    expect(afterRestore.pricingBenefitType).toBe("WHOLESALE");
    expect(afterRestore.pricingBenefitLabel).toBe("سعر الجملة التلقائي");
    expect(String(afterRestore.pricingBenefitDiscount)).toBe("12000.00");
    expect(String(afterRestore.subtotal)).toBe("42000.00");
    expect(String(afterRestore.shippingCost)).toBe("0.00");
    expect(String(afterRestore.total)).toBe("42000.00");
  });

  it("prevents duplicate '\\nملاحظة:' segments while preserving notes on street-only edits and stripping cleared notes", async () => {
    expect(
      composeOrderShippingAddress(
        "المنصور\nملاحظة: ملاحظة قديمة",
        "المنصور\nملاحظة: ملاحظة قديمة",
        "ملاحظة محدثة",
      ),
    ).toBe("المنصور\nملاحظة: ملاحظة محدثة");

    expect(
      composeOrderShippingAddress(
        "المنصور\nملاحظة: ملاحظة قديمة",
        undefined,
        "اتصل قبل الوصول",
      ),
    ).toBe("المنصور\nملاحظة: اتصل قبل الوصول");

    // Street-only update (inputNotes === undefined) MUST preserve existing note
    expect(
      composeOrderShippingAddress(
        "المنصور شارع 14\nملاحظة: قرب الصيدلية",
        "المنصور شارع 16",
        undefined,
      ),
    ).toBe("المنصور شارع 16\nملاحظة: قرب الصيدلية");

    // Explicit clear (notes = null or "") MUST strip note even if inputShippingAddress still carried an embedded note
    expect(
      composeOrderShippingAddress(
        "المنصور\nملاحظة: ملاحظة قديمة",
        "المنصور\nملاحظة: ملاحظة قديمة",
        null,
      ),
    ).toBe("المنصور");

    expect(
      composeOrderShippingAddress(
        "المنصور\nملاحظة: ملاحظة قديمة",
        "المنصور\nملاحظة: ملاحظة قديمة",
        "",
      ),
    ).toBe("المنصور");
  });

  it("rolls back newly created customer atomically if ATP stock check fails during updateOnlineOrder and leaves GET_LOCK free", async () => {
    const created = await createOnlineOrder({
      customerName: "عميل أول",
      customerPhone: "07703334455",
      governorate: "baghdad",
      addressText: "اليرموك",
      lines: [{ productUnitId: 1, quantity: 2 }],
    });

    const newPhoneRaw = "07709998877";
    const newPhoneE164 = "+9647709998877";

    // Request 99 units (> 30 in stock) while also changing phone to a brand-new customer phone
    await expect(
      updateOnlineOrder(
        {
          id: created.orderId,
          scopedBranchId: 1,
          customerName: "عميل جديد يجب أن يتراجع",
          customerPhone: newPhoneRaw,
          items: [{ productUnitId: 1, quantity: 99 }],
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Because raw COMMIT was removed and the whole tx rolled back, no orphan customer row exists!
    const orphanCustomers = await db()
      .select({ id: s.customers.id })
      .from(s.customers)
      .where(eq(s.customers.phone, newPhoneE164));
    expect(orphanCustomers).toHaveLength(0);

    const lockFreeRes = (await db().execute(
      sql`SELECT IS_FREE_LOCK('online-customer:upsert') AS freeUpsert, IS_FREE_LOCK(${`online-customer:${newPhoneE164}`}) AS freePhone`,
    )) as unknown;
    const freeRow = Array.isArray(lockFreeRes)
      ? (lockFreeRes[0] as Array<{ freeUpsert?: number; freePhone?: number }> | undefined)?.[0]
      : (lockFreeRes as { rows?: Array<{ freeUpsert?: number; freePhone?: number }> })?.rows?.[0];
    expect(Number(freeRow?.freeUpsert)).toBe(1);
    expect(Number(freeRow?.freePhone)).toBe(1);
  });

  it("deduplicates concurrent phone rebinds across two orders to a single customer row", async () => {
    const orderA = await createOnlineOrder({
      customerName: "طلب أ",
      customerPhone: "07701110001",
      governorate: "baghdad",
      addressText: "زيونة",
      lines: [{ productUnitId: 1, quantity: 1 }],
    });
    const orderB = await createOnlineOrder({
      customerName: "طلب ب",
      customerPhone: "07701110002",
      governorate: "baghdad",
      addressText: "الجادرية",
      lines: [{ productUnitId: 1, quantity: 1 }],
    });

    const sharedTargetPhone = "07705556677";
    const sharedTargetE164 = "+9647705556677";

    await Promise.all([
      updateOnlineOrder(
        {
          id: orderA.orderId,
          scopedBranchId: 1,
          customerName: "عميل موحد",
          customerPhone: sharedTargetPhone,
        },
        1,
      ),
      updateOnlineOrder(
        {
          id: orderB.orderId,
          scopedBranchId: 1,
          customerName: "عميل موحد",
          customerPhone: sharedTargetPhone,
        },
        1,
      ),
    ]);

    const matchingCustomers = await db()
      .select({ id: s.customers.id })
      .from(s.customers)
      .where(eq(s.customers.phone, sharedTargetE164));
    expect(matchingCustomers).toHaveLength(1);

    const updatedOrders = await db()
      .select({ id: s.onlineOrders.id, customerId: s.onlineOrders.customerId })
      .from(s.onlineOrders);
    expect(updatedOrders).toHaveLength(2);
    expect(updatedOrders[0]!.customerId).toBe(matchingCustomers[0]!.id);
    expect(updatedOrders[1]!.customerId).toBe(matchingCustomers[0]!.id);
  });

  it("rebinds multiple orders concurrently to distinct new phone numbers without ER_LOCK_DEADLOCK", async () => {
    const orders = [];
    for (let i = 1; i <= 4; i++) {
      orders.push(
        await createOnlineOrder({
          customerName: `صاحب طلب ${i}`,
          customerPhone: `0770112000${i}`,
          governorate: "baghdad",
          addressText: `عنوان ${i}`,
          lines: [{ productUnitId: 1, quantity: 1 }],
        }),
      );
    }

    const distinctNewPhones = ["07708880004", "07708880001", "07708880003", "07708880002"];
    await Promise.all(
      orders.map((ord, idx) =>
        updateOnlineOrder(
          {
            id: ord.orderId,
            scopedBranchId: 1,
            customerName: `مستلم محدث ${idx + 1}`,
            customerPhone: distinctNewPhones[idx]!,
          },
          1,
        ),
      ),
    );

    const updatedOrders = await db()
      .select({ id: s.onlineOrders.id, customerId: s.onlineOrders.customerId })
      .from(s.onlineOrders);
    const distinctCustomerIds = new Set(updatedOrders.map((o) => o.customerId));
    expect(distinctCustomerIds.size).toBe(4);
  });

  it("returns dynamic deliveryZones, pricingBenefit metadata, couponFreeShipping, and item retailUnitPrice in getOnlineOrder", async () => {
    await db().insert(s.promotions).values({
      id: 50,
      name: "شحن مجاني ترحيبي",
      type: "AMOUNT",
      discountPercent: "0.00",
      discountAmount: "0.00",
      freeShipping: true,
      shippingDiscountAmount: "0.00",
      scope: "ALL",
      effectiveFrom: new Date("2026-01-01"),
      effectiveTo: new Date("2027-01-01"),
      branchId: 1,
      customerTier: "RETAIL",
      minLineAmount: "0.00",
      priority: 100,
      isActive: true,
      applicationMode: "COUPON",
      isStoreManaged: true,
    });
    await db().insert(s.couponPrograms).values({
      id: 50,
      promotionId: 50,
      name: "كوبون شحن مجاني",
      status: "ACTIVE",
      branchId: 1,
      validFrom: new Date("2026-01-01"),
      validTo: new Date("2027-01-01"),
      perCouponLimit: 5,
      perCustomerLimit: 5,
      codePrefix: "SHIPFREE",
      createdBy: 1,
    });
    await db().insert(s.coupons).values({
      id: 50,
      programId: 50,
      code: "SHIPFREE1",
      codeHash: hashCouponCode("SHIPFREE1"),
      status: "ACTIVE",
    });

    const created = await createOnlineOrder({
      customerName: "هدى كريم",
      customerPhone: "07704445566",
      governorate: "basra",
      addressText: "العشار",
      couponCode: "SHIPFREE1",
      lines: [{ productUnitId: 1, quantity: 2 }],
    });

    const detail = await getOnlineOrder(created.orderId, 1);
    expect(detail).not.toBeNull();
    expect(detail!.couponFreeShipping).toBe(true);
    expect(detail!.pricingBenefitType).toBe("COUPON");
    expect(detail!.items[0]!.retailUnitPrice).toBe("4500.00");

    const baghdadZone = detail!.deliveryZones.find((z) => z.id === "baghdad");
    const basraZone = detail!.deliveryZones.find((z) => z.id === "basra");
    const kirkukZone = detail!.deliveryZones.find((z) => z.id === "kirkuk");

    expect(baghdadZone).toMatchObject({
      id: "baghdad",
      name: "بغداد المركز المحدث",
      deliveryFee: 4000,
      isActive: true,
    });
    expect(basraZone).toMatchObject({
      id: "basra",
      name: "البصرة المحدثة",
      deliveryFee: 9000,
      isActive: true,
    });
    expect(kirkukZone).toMatchObject({
      id: "kirkuk",
      deliveryFee: 11000,
      isActive: false,
    });

    await expect(
      updateOnlineOrder(
        {
          id: created.orderId,
          scopedBranchId: 1,
          governorate: "kirkuk",
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accepts custom active deliveryZones via storeAdmin.orders.update router and preserves configured fee if zone is later deactivated", async () => {
    await db().insert(s.deliveryZones).values({
      id: 13,
      code: "baghdad-karkh",
      name: "بغداد — الكرخ",
      isActive: true,
      displayOrder: 4,
    });
    await db().insert(s.deliveryPricingRules).values({
      id: 103,
      zoneId: 13,
      ruleType: "FLAT_FEE",
      baseFee: "3500.00",
      isActive: true,
    });

    const created = await createOnlineOrder({
      customerName: "زيد سامي",
      customerPhone: "07706667788",
      governorate: "baghdad",
      addressText: "المنصور",
      lines: [{ productUnitId: 1, quantity: 2 }], // 9,000 IQD (< 50,000 threshold)
    });

    const caller = await makeAdminCaller();
    const updatedCustom = await caller.storeAdmin.orders.update({
      id: created.orderId,
      governorate: "baghdad-karkh",
      shippingAddress: "حي الجامعة",
      notes: "قرب جامع المأمون",
    });

    expect(updatedCustom.subtotal).toBe("9000.00");
    expect(updatedCustom.deliveryFee).toBe("3500.00");
    expect(updatedCustom.total).toBe("12500.00");

    // Deactivate baghdad-karkh after the order is already assigned to it
    await db()
      .update(s.deliveryZones)
      .set({ isActive: false })
      .where(eq(s.deliveryZones.id, 13));

    const detailAfterDeactivation = await getOnlineOrder(created.orderId, 1);
    const karkhOption = detailAfterDeactivation?.deliveryZones.find(
      (z) => z.id === "baghdad-karkh",
    );
    expect(karkhOption).toMatchObject({
      id: "baghdad-karkh",
      deliveryFee: 3500,
      isActive: false,
    });

    // Editing street address / item quantity WITHOUT switching governorate must preserve 3,500 fee (not drop to 0)
    const editedSameDeactivatedZone = await caller.storeAdmin.orders.update({
      id: created.orderId,
      shippingAddress: "حي الجامعة محلة 630",
      items: [{ productUnitId: 1, quantity: 3 }], // 13,500 IQD + 3,500 fee = 17,000
    });
    expect(editedSameDeactivatedZone.subtotal).toBe("13500.00");
    expect(editedSameDeactivatedZone.deliveryFee).toBe("3500.00");
    expect(editedSameDeactivatedZone.total).toBe("17000.00");

    const persistedRow = (
      await db()
        .select()
        .from(s.onlineOrders)
        .where(eq(s.onlineOrders.id, created.orderId))
        .limit(1)
    )[0]!;
    expect(persistedRow.shippingAddress).toBe(
      "حي الجامعة محلة 630\nملاحظة: قرب جامع المأمون",
    );
  });
});
