import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { confirmConsignmentDelivery } from "../delivery/courier";
import { hashCouponCode, issueBounceBackCouponTx } from "../couponService";
import { money } from "../money";
import { createOnlineOrder, quoteOnlineOrder } from "../onlineOrderService";
import { returnSale } from "../returnService";
import { cancelSale } from "../sale/cancel";
import { correctSale } from "../sale/correct";
import { createSale } from "../saleService";
import {
  claimOnlineOrder,
  markOnlineOrderPrepared,
  setOnlineOrderStatus,
} from "../storeAdmin/orderFulfillmentService";
import { dispatchOnlineOrder } from "../storeAdmin/dispatchOnlineOrder";
import {
  awardDeliveredOnlineOrderPoints,
  listLoyaltyLedgerEntries,
  redeemStorefrontLoyaltyPoints,
  saveLoyaltyProgram,
} from "../storeAdmin/loyaltyService";
import { getStoreAnalytics } from "../storeAdmin/storeAnalyticsService";
import { getStoreCustomers } from "../storeAdmin/storeCustomerService";
import {
  signStorefrontCustomerSession,
  storefrontCustomerBenefits,
} from "../storefrontCustomerIdentityService";
import { withTx } from "../tx";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

const ADMIN_ACTOR = { userId: 1, branchId: 1, role: "admin" as const };
const CUSTOMER_PHONE = "+9647701112233";

async function seedFixture() {
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "w4-finance-loyalty-test-secret-key-32chars!!";
  const d = db();
  await d.insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await d.insert(s.users).values({
    id: 1,
    openId: "w4-loyalty-admin",
    name: "مدير المتجر",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
    isOwner: true,
    isActive: true,
  });
  await d.insert(s.shifts).values({
    id: 1,
    userId: 1,
    branchId: 1,
    status: "OPEN",
    openedAt: new Date(),
    openGuard: "1:1",
    openingBalance: "100000.00",
  });
  await d.insert(s.customers).values({
    id: 101,
    name: "زينب العميلة",
    phone: CUSTOMER_PHONE,
    customerType: "فرد",
    defaultPriceTier: "RETAIL",
    currentBalance: "0.00",
    creditLimit: "9999999.00",
    isActive: true,
    sessionVersion: 0,
  });
  await d.insert(s.products).values([
    { id: 1, name: "طقم دفاتر جامعية", showInStore: true },
    { id: 2, name: "علبة أقلام حبر", showInStore: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "NB-SET-1", costPrice: "2000.00" },
    { id: 2, productId: 2, sku: "PEN-BOX-2", costPrice: "2500.00" },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
    },
    {
      id: 2,
      variantId: 2,
      unitName: "علبة",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
    },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "5000.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "6000.00" },
  ]);
  await d.insert(s.branchStock).values([
    { branchId: 1, variantId: 1, quantity: 200 },
    { branchId: 1, variantId: 2, quantity: 200 },
  ]);
  await d.insert(s.deliveryParties).values({
    id: 1,
    name: "مندوب بغداد السريع",
    partyType: "INDIVIDUAL",
    branchId: 1,
    isActive: true,
  });
  await d.insert(s.storeSettings).values({
    id: 1,
    fulfillmentBranchId: 1,
    isOpen: true,
    freeShippingThreshold: "1000000.00", // نبقي أجرة التوصيل فعالة (5000 د.ع لبغداد) لفحص استبعاد الشحن
  });
  await saveLoyaltyProgram(
    {
      name: "برنامج ولاء الرؤية",
      status: "ACTIVE",
      pointsPerIqd: "0.010000", // نقطة لكل 100 د.ع (20,000 د.ع -> 200 نقطة)
      iqdDiscountPerPoint: "50.00", // 100 نقطة -> 5,000 د.ع
      minRedeemPoints: 50,
      maxRedeemPercent: 50, // خصم 5,000 د.ع يتطلب حد أدنى للطلب 10,000 د.ع
      expiresAfterDays: 90,
    },
    1,
  );
}

async function createAndDeliverOrder(input: {
  lines: Array<{ productUnitId: number; quantity: number }>;
  couponCode?: string;
  requestId: string;
}) {
  const quote = await quoteOnlineOrder({
    governorate: "baghdad",
    couponCode: input.couponCode,
    authenticatedCustomer: { customerId: 101, phone: CUSTOMER_PHONE },
    lines: input.lines,
  });
  const created = await createOnlineOrder({
    customerName: "زينب العميلة",
    customerPhone: CUSTOMER_PHONE,
    governorate: "baghdad",
    addressText: "بغداد — الكرادة الشرقية",
    couponCode: input.couponCode,
    authenticatedCustomer: { customerId: 101, phone: CUSTOMER_PHONE },
    clientRequestId: input.requestId,
    lines: input.lines,
    expectedGrandTotal: quote.total,
  });
  await claimOnlineOrder(
    {
      id: created.orderId,
      scopedBranchId: null,
    },
    ADMIN_ACTOR,
  );
  await markOnlineOrderPrepared(
    {
      id: created.orderId,
      scopedBranchId: null,
    },
    ADMIN_ACTOR,
  );
  const dispatched = await dispatchOnlineOrder(
    {
      onlineOrderId: created.orderId,
      partyId: 1,
    },
    ADMIN_ACTOR,
  );
  await confirmConsignmentDelivery(
    {
      consignmentId: dispatched.consignmentId!,
      clientRequestId: `deliver-${input.requestId}`,
      statementWitness: {
        partyId: 1,
        statementNumber: `STMT-${input.requestId}`,
        kind: "STAFF_CONFIRMED",
      },
    },
    ADMIN_ACTOR,
  );
  return {
    orderId: created.orderId,
    orderNumber: created.orderNumber,
    invoiceId: dispatched.invoiceId,
    quote,
  };
}

beforeEach(async () => {
  await truncateAllTables();
  await seedFixture();
});

describe("Wave 4 — دورة حياة دفتر الولاء المتكاملة (اكتساب صافٍ · مرتجعات متعددة · تصحيح · استبدال)", () => {
  it("يمنح نقاط الطلب المسلّم على صافي البضاعة بعد الخصم مع استبعاد أجرة الشحن وعدم خصم القسيمة مرتين وبلا تكرار", async () => {
    const d = db();
    // 1) طلب بدون كوبون: 4 × 5,000 = 20,000 بضاعة + 5,000 شحن = 25,000 إجمالي
    const first = await createAndDeliverOrder({
      lines: [{ productUnitId: 1, quantity: 4 }],
      requestId: "w4-earn-excl-shipping-1",
    });
    expect(Number(first.quote.deliveryFee)).toBeGreaterThan(0);
    expect(first.quote.subtotal).toBe("20000.00");

    // إعادة استدعاء المنح داخل معاملة ثانية يجب أن تكون خاملة تماماً (idempotent)
    const duplicate = await withTx((tx) =>
      awardDeliveredOnlineOrderPoints(tx, {
        onlineOrderId: first.orderId,
        customerId: 101,
        total: first.quote.total,
      }),
    );
    expect(duplicate).toBeNull();

    let account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    // 20,000 × 0.01 = 200.00 (وليس 250.00 مع الشحن!)
    expect(account.pointsBalance).toBe("200.00");

    const earnEntries = await d
      .select()
      .from(s.loyaltyLedgerEntries)
      .where(eq(s.loyaltyLedgerEntries.onlineOrderId, first.orderId));
    expect(earnEntries).toHaveLength(1);
    expect(earnEntries[0]).toMatchObject({
      entryType: "ORDER_EARN",
      pointsDelta: "200.00",
      balanceAfter: "200.00",
      idempotencyKey: `earn:order:${first.orderId}`,
    });

    // 2) طلب يستخدم قسيمة خصم 3,000 د.ع على بضاعة 20,000 د.ع (صافي البضاعة = 17,000 د.ع + شحن)
    await d.insert(s.promotions).values({
      id: 50,
      name: "قسيمة ترويجية 3000",
      type: "AMOUNT",
      discountPercent: "0.00",
      discountAmount: "3000.00",
      maxDiscountAmount: "3000.00",
      minOrderSpend: "10000.00",
      scope: "ALL",
      effectiveFrom: new Date("2026-01-01"),
      effectiveTo: new Date("2027-01-01"),
      minLineAmount: "0.00",
      priority: 50,
      isActive: true,
      applicationMode: "COUPON",
      isStoreManaged: false,
    });
    await d.insert(s.couponPrograms).values({
      id: 50,
      promotionId: 50,
      name: "برنامج 3000",
      status: "ACTIVE",
      validFrom: new Date("2026-01-01"),
      validTo: new Date("2027-01-01"),
      perCouponLimit: 1,
      perCustomerLimit: 10,
      codePrefix: "PRM",
      createdBy: 1,
    });
    await d.insert(s.coupons).values({
      id: 50,
      programId: 50,
      code: "PRM-3000",
      codeHash: hashCouponCode("PRM-3000"),
      customerId: 101,
      status: "ACTIVE",
    });

    const second = await createAndDeliverOrder({
      lines: [{ productUnitId: 1, quantity: 4 }],
      couponCode: "PRM-3000",
      requestId: "w4-earn-with-coupon-2",
    });
    expect(second.quote.subtotal).toBe("17000.00");

    account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    // 200.00 + (17,000 × 0.01 = 170.00) = 370.00 (لا نخصم القسيمة مرة ثانية!)
    expect(account.pointsBalance).toBe("370.00");
  });

  it("يدعم مرتجعين جزئيين متتاليين ثم مرتجعاً أخيراً على نفس الطلب دون ER_DUP_ENTRY وبنفس معدل الاكتساب الأصلي", async () => {
    const d = db();
    const delivered = await createAndDeliverOrder({
      lines: [{ productUnitId: 1, quantity: 4 }], // 20,000 د.ع -> 200.00 نقطة
      requestId: "w4-multi-partial-returns",
    });

    // تعديل معدل البرنامج لاحقاً إلى 5 أضعاف لا يجوز أن يقتطع نقاطاً أكثر مما اكتسبه العميل فعلاً!
    const prog = (await d.select().from(s.loyaltyPrograms))[0]!;
    await saveLoyaltyProgram(
      {
        id: Number(prog.id),
        name: prog.name,
        status: "ACTIVE",
        pointsPerIqd: "0.050000",
        iqdDiscountPerPoint: "50.00",
        minRedeemPoints: 50,
        maxRedeemPercent: 50,
        expiresAfterDays: 90,
      },
      1,
    );

    const invItem = (
      await d
        .select()
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, delivered.invoiceId))
    )[0]!;

    // مرتجع جزئي أول: قطعة واحدة (5,000 د.ع) -> يتبقى 15,000 د.ع (150 نقطة، استرداد -50.00)
    await returnSale(
      {
        invoiceId: delivered.invoiceId,
        lines: [{ invoiceItemId: Number(invItem.id), baseQuantity: 1 }],
        refund: null,
        clientRequestId: "w4-ret-partial-1",
      },
      ADMIN_ACTOR,
    );

    let account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("150.00");

    // مرتجع جزئي ثانٍ على نفس الطلب: قطعة ثانية (5,000 د.ع) -> يتبقى 10,000 د.ع (100 نقطة، استرداد -50.00)
    await returnSale(
      {
        invoiceId: delivered.invoiceId,
        lines: [{ invoiceItemId: Number(invItem.id), baseQuantity: 1 }],
        refund: null,
        clientRequestId: "w4-ret-partial-2",
      },
      ADMIN_ACTOR,
    );

    account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("100.00");

    // مرتجع باقي الكمية (قطعتان = 10,000 د.ع) -> صافي 0 د.ع (0 نقطة، استرداد -100.00)
    await returnSale(
      {
        invoiceId: delivered.invoiceId,
        lines: [{ invoiceItemId: Number(invItem.id), baseQuantity: 2 }],
        refund: null,
        clientRequestId: "w4-ret-full-rest",
      },
      ADMIN_ACTOR,
    );

    account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("0.00");

    const ledgerRows = await d
      .select()
      .from(s.loyaltyLedgerEntries)
      .where(eq(s.loyaltyLedgerEntries.onlineOrderId, delivered.orderId))
      .orderBy(asc(s.loyaltyLedgerEntries.id));
    expect(ledgerRows.map((r) => [r.entryType, r.pointsDelta, r.balanceAfter])).toEqual([
      ["ORDER_EARN", "200.00", "200.00"],
      ["ORDER_REVERSE", "-50.00", "150.00"],
      ["ORDER_REVERSE", "-50.00", "100.00"],
      ["ORDER_REVERSE", "-100.00", "0.00"],
    ]);
  });

  it("يستردّ فرق النقاط بدقة عند تصحيح فاتورة طلب متجر مسلّم (correctSale) دون استرداد كامل كاذب أثناء العكس الداخلي", async () => {
    const d = db();
    const delivered = await createAndDeliverOrder({
      lines: [{ productUnitId: 1, quantity: 3 }], // 15,000 د.ع -> 150.00 نقطة
      requestId: "w4-sale-correct-order",
    });

    // بعد تسليم الإرسالية وتوريد العهدة محاسبياً، نُصحّح الفاتورة إلى قطعتين
    await d
      .update(s.deliveryConsignments)
      .set({
        parcelStatus: "DELIVERED",
        status: "DELIVERED",
        moneyStatus: "SETTLED",
        settledAt: new Date(),
      })
      .where(eq(s.deliveryConsignments.invoiceId, delivered.invoiceId));

    const corrected = await correctSale(
      {
        originalInvoiceId: delivered.invoiceId,
        notes: "تعديل الكمية بعد المراجعة إلى قطعتين",
        clientRequestId: "w4-correct-inv-1",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], // 10,000 د.ع -> يجب أن يبقى 100.00 نقطة
      },
      ADMIN_ACTOR,
    );

    const account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("100.00");

    const ledgerRows = await d
      .select()
      .from(s.loyaltyLedgerEntries)
      .where(eq(s.loyaltyLedgerEntries.onlineOrderId, delivered.orderId))
      .orderBy(asc(s.loyaltyLedgerEntries.id));
    expect(ledgerRows).toHaveLength(2);
    expect(ledgerRows[1]).toMatchObject({
      entryType: "ORDER_REVERSE",
      pointsDelta: "-50.00",
      balanceAfter: "100.00",
      idempotencyKey: `rev:order:${delivered.orderId}:corr:${corrected.correctedInvoiceId}`,
    });
  });

  it("لا يُسقط مرتجع المبيعات إذا سبق للعميل استبدال جزء من نقاطه، بل يقتطع المتاح ويُسقف الرصيد عند 0.00", async () => {
    const d = db();
    const delivered = await createAndDeliverOrder({
      lines: [{ productUnitId: 1, quantity: 2 }], // 10,000 د.ع -> 100.00 نقطة
      requestId: "w4-clamp-order",
    });

    const sessionToken = await signStorefrontCustomerSession({
      customerId: 101,
      firebaseUid: "uid-zainab-101",
      phone: CUSTOMER_PHONE,
      sessionVersion: 0,
    });
    const redeemed = await redeemStorefrontLoyaltyPoints({
      customerSessionToken: sessionToken,
      points: 80,
      clientRequestId: "redeem-before-return-80",
    });
    expect(redeemed.pointsBalance).toBe("20.00");

    const invItem = (
      await d
        .select()
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, delivered.invoiceId))
    )[0]!;

    // الآن تُرجع العميلة الطلب كاملاً (المطلوب استرداده 100 نقطة بينما الرصيد المتاح 20 نقطة فقط!)
    const ret = await returnSale(
      {
        invoiceId: delivered.invoiceId,
        lines: [{ invoiceItemId: Number(invItem.id), baseQuantity: 2 }],
        refund: null,
        clientRequestId: "w4-return-after-redeem",
      },
      ADMIN_ACTOR,
    );
    expect(ret.fullyReturned).toBe(true);

    const account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("0.00");

    const ledgerRows = await d
      .select()
      .from(s.loyaltyLedgerEntries)
      .where(eq(s.loyaltyLedgerEntries.customerId, 101))
      .orderBy(asc(s.loyaltyLedgerEntries.id));
    expect(ledgerRows.map((r) => [r.entryType, r.pointsDelta, r.balanceAfter])).toEqual([
      ["ORDER_EARN", "100.00", "100.00"],
      ["REDEEM", "-80.00", "20.00"],
      ["ORDER_REVERSE", "-20.00", "0.00"],
    ]);
    expect(ledgerRows[2]!.note).toContain("80.00");
  });

  it("يعتمد تاريخ بغداد (Asia/Baghdad) في storefrontCustomerBenefits عند منتصف الليل الصيفي (22:30 UTC)", async () => {
    const d = db();
    await d.insert(s.promotions).values([
      {
        id: 61,
        name: "عرض غد بغداد",
        type: "AMOUNT",
        discountAmount: "1000.00",
        discountPercent: "0.00",
        scope: "ALL",
        effectiveFrom: new Date("2026-07-16T00:00:00.000Z"),
        effectiveTo: new Date("2026-07-20T00:00:00.000Z"),
        minLineAmount: "0.00",
        isActive: true,
        applicationMode: "COUPON",
      },
      {
        id: 62,
        name: "عرض أمس بغداد المنتهي",
        type: "AMOUNT",
        discountAmount: "1000.00",
        discountPercent: "0.00",
        scope: "ALL",
        effectiveFrom: new Date("2026-07-10T00:00:00.000Z"),
        effectiveTo: new Date("2026-07-15T00:00:00.000Z"),
        minLineAmount: "0.00",
        isActive: true,
        applicationMode: "COUPON",
      },
    ]);
    await d.insert(s.couponPrograms).values([
      {
        id: 61,
        promotionId: 61,
        name: "قسيمة سارية في بغداد 16 تموز",
        status: "ACTIVE",
        validFrom: new Date("2026-07-16T00:00:00.000Z"),
        validTo: new Date("2026-07-20T00:00:00.000Z"),
        perCouponLimit: 1,
        perCustomerLimit: 10,
        codePrefix: "BGD",
        createdBy: 1,
      },
      {
        id: 62,
        promotionId: 62,
        name: "قسيمة منتهية في بغداد 15 تموز",
        status: "ACTIVE",
        validFrom: new Date("2026-07-10T00:00:00.000Z"),
        validTo: new Date("2026-07-15T00:00:00.000Z"),
        perCouponLimit: 1,
        perCustomerLimit: 10,
        codePrefix: "EXP",
        createdBy: 1,
      },
    ]);
    await d.insert(s.coupons).values([
      {
        id: 61,
        programId: 61,
        code: "BGD-ACTIVE-16",
        codeHash: hashCouponCode("BGD-ACTIVE-16"),
        customerId: 101,
        status: "ACTIVE",
      },
      {
        id: 62,
        programId: 62,
        code: "BGD-EXPIRED-15",
        codeHash: hashCouponCode("BGD-EXPIRED-15"),
        customerId: 101,
        status: "ACTIVE",
      },
    ]);

    // 2026-07-15T22:30:00Z = 2026-07-16 الساعة 01:30 صباحاً بتوقيت بغداد!
    const benefits = await storefrontCustomerBenefits(
      { customerId: 101, phone: CUSTOMER_PHONE },
      { now: new Date("2026-07-15T22:30:00.000Z") },
    );
    expect(benefits.coupons.map((c) => c.code)).toEqual(["BGD-ACTIVE-16"]);
  });

  it("يستبدل النقاط بقسيمة شخصية فورية مع حماية الإعادة (idempotency) والحد الأدنى للطلب وقابلية الاستبدال المتكرر لطلب ثانٍ + دفتر الإدارة", async () => {
    // نكسب 300 نقطة (60,000 د.ع × 0.01 = 600 نقطة؟ 6 × 5,000 = 30,000 د.ع -> 300 نقطة)
    const delivered = await createAndDeliverOrder({
      lines: [{ productUnitId: 1, quantity: 6 }], // 30,000 د.ع -> 300.00 نقطة
      requestId: "w4-redeem-seed-order",
    });

    const sessionToken = await signStorefrontCustomerSession({
      customerId: 101,
      firebaseUid: "uid-zainab-101",
      phone: CUSTOMER_PHONE,
      sessionVersion: 0,
    });

    // رفض أقل من الحد الأدنى (minRedeemPoints = 50)
    await expect(
      redeemStorefrontLoyaltyPoints({
        customerSessionToken: sessionToken,
        points: 20,
        clientRequestId: "redeem-too-low-20",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // رفض تجاوز الرصيد المتاح (300)
    await expect(
      redeemStorefrontLoyaltyPoints({
        customerSessionToken: sessionToken,
        points: 500,
        clientRequestId: "redeem-too-high-500",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // استبدال أول: 100 نقطة -> خصم 5,000 د.ع، حد أدنى للطلب 10,000 د.ع (maxRedeemPercent = 50%)
    const firstRedeem = await redeemStorefrontLoyaltyPoints({
      customerSessionToken: sessionToken,
      points: 100,
      clientRequestId: "redeem-req-first-100",
    });
    expect(firstRedeem).toMatchObject({
      outcome: "ISSUED",
      discountIqd: "5000.00",
      minOrderSpendIqd: "10000.00",
      pointsRedeemed: 100,
      pointsBalance: "200.00",
    });
    expect(firstRedeem.code).toMatch(/^LOY-/);

    // إعادة نفس clientRequestId تعيد نفس الرمز ولا تخصم 100 نقطة إضافية
    const replayed = await redeemStorefrontLoyaltyPoints({
      customerSessionToken: sessionToken,
      points: 100,
      clientRequestId: "redeem-req-first-100",
    });
    expect(replayed).toMatchObject({
      outcome: "REPLAYED",
      code: firstRedeem.code,
      discountIqd: "5000.00",
      pointsBalance: "200.00",
    });

    // سلة أقل من 10,000 د.ع (قطعة واحدة بـ6,000 د.ع) تُرفض بسبب minOrderSpend
    await expect(
      quoteOnlineOrder({
        governorate: "baghdad",
        couponCode: firstRedeem.code,
        authenticatedCustomer: { customerId: 101, phone: CUSTOMER_PHONE },
        lines: [{ productUnitId: 2, quantity: 1 }], // 6,000 < 10,000
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // استخدام القسيمة الأولى على طلب متعدد القطع (2 × 6,000 = 12,000 د.ع) -> يُسقف الخصم عند 5,000 د.ع
    const orderWithCoupon1 = await createAndDeliverOrder({
      lines: [{ productUnitId: 2, quantity: 2 }], // 12,000 - 5,000 = 7,000 صافي (يكسب 70 نقطة إضافية!)
      couponCode: firstRedeem.code,
      requestId: "w4-order-using-loy-1",
    });
    expect(orderWithCoupon1.quote.couponDiscount).toBe("5000.00");
    expect(orderWithCoupon1.quote.subtotal).toBe("7000.00");

    // استبدال ثانٍ لنفس العميلة (100 نقطة أخرى) واستخدامها في طلب ثانٍ بنجاح (perCustomerLimit لا يمنع التكرار!)
    const secondRedeem = await redeemStorefrontLoyaltyPoints({
      customerSessionToken: sessionToken,
      points: 100,
      clientRequestId: "redeem-req-second-100",
    });
    expect(secondRedeem.outcome).toBe("ISSUED");
    expect(secondRedeem.code).not.toBe(firstRedeem.code);

    const quote2 = await quoteOnlineOrder({
      governorate: "baghdad",
      couponCode: secondRedeem.code,
      authenticatedCustomer: { customerId: 101, phone: CUSTOMER_PHONE },
      lines: [{ productUnitId: 2, quantity: 2 }],
    });
    expect(quote2.couponDiscount).toBe("5000.00");
    expect(quote2.subtotal).toBe("7000.00");

    // فحص قراءة دفتر حركات الولاء للإدارة
    const adminLedger = await listLoyaltyLedgerEntries({ limit: 20 });
    expect(adminLedger.length).toBeGreaterThanOrEqual(4);
    expect(adminLedger.some((row) => row.entryType === "REDEEM" && row.customerName === "زينب العميلة")).toBe(true);
    expect(
      adminLedger.some(
        (row) => row.entryType === "ORDER_EARN" && row.orderNumber === delivered.orderNumber,
      ),
    ).toBe(true);
  });

  it("يتجاهل طلبات الضيوف/الحسابات المحذوفة بأمان، ويقبل المرتجع الكامل عند نفاد الرصيد 100% (pointsDelta = 0.00)، ويرفض تعارض clientRequestId", async () => {
    const d = db();

    // 1) حارس customerId الفارغ + طلب لعميل محذوف/معطّل ينتقل إلى DELIVERED عبر setOnlineOrderStatus دون أي سقوط أو قيد ولاء
    const nullOrderEarned = await withTx((tx) =>
      awardDeliveredOnlineOrderPoints(tx, {
        onlineOrderId: 999999,
        customerId: null,
        total: "15000.00",
      }),
    );
    expect(nullOrderEarned).toBeNull();

    await d.insert(s.customers).values({
      id: 909,
      name: "عميل محذوف",
      phone: "+9647809998877",
      customerType: "فرد",
      defaultPriceTier: "RETAIL",
      currentBalance: "0.00",
      creditLimit: "0.00",
      isActive: false,
      deletedAt: new Date(),
      sessionVersion: 1,
    });
    const [guestInsert] = await d.insert(s.onlineOrders).values({
      orderNumber: "WEB-GUEST-001",
      customerId: 909,
      branchId: 1,
      governorate: "baghdad",
      shippingAddress: "بغداد — المنصور",
      status: "SHIPPED",
      subtotal: "10000.00",
      shippingCost: "5000.00",
      total: "15000.00",
    });
    const guestOrderId = Number(guestInsert.insertId);
    const guestTransition = await setOnlineOrderStatus(
      { id: guestOrderId, status: "DELIVERED", scopedBranchId: null },
      1,
    );
    expect(guestTransition.to).toBe("DELIVERED");
    const deletedCustomerLedger = await d
      .select()
      .from(s.loyaltyLedgerEntries)
      .where(eq(s.loyaltyLedgerEntries.customerId, 909));
    expect(deletedCustomerLedger).toHaveLength(0);

    // 2) العميل يكسب 100 نقطة، يستبدل 100% منها (الرصيد = 0.00)، ثم يختبر تعارض clientRequestId ثم المرتجع الكامل
    const delivered = await createAndDeliverOrder({
      lines: [{ productUnitId: 1, quantity: 2 }], // 10,000 د.ع -> 100.00 نقطة
      requestId: "w4-full-spend-before-return",
    });

    const sessionToken = await signStorefrontCustomerSession({
      customerId: 101,
      firebaseUid: "uid-zainab-101",
      phone: CUSTOMER_PHONE,
      sessionVersion: 0,
    });
    const redeemedAll = await redeemStorefrontLoyaltyPoints({
      customerSessionToken: sessionToken,
      points: 100,
      clientRequestId: "redeem-full-100-key",
    });
    expect(redeemedAll.pointsBalance).toBe("0.00");

    // إعادة استخدام نفس clientRequestId بعدد نقاط مختلف (50 بدل 100) يُرفض بـ CONFLICT
    await expect(
      redeemStorefrontLoyaltyPoints({
        customerSessionToken: sessionToken,
        points: 50,
        clientRequestId: "redeem-full-100-key",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // إرجاع كامل البضاعة والرصيد 0.00 -> ينجح البيع المرتجع ويُسجل قيد ORDER_REVERSE بقيمة 0.00 مع توثيق العجز 100.00
    const invItem = (
      await d
        .select()
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, delivered.invoiceId))
    )[0]!;
    const ret = await returnSale(
      {
        invoiceId: delivered.invoiceId,
        lines: [{ invoiceItemId: Number(invItem.id), baseQuantity: 2 }],
        refund: null,
        clientRequestId: "w4-return-zero-balance",
      },
      ADMIN_ACTOR,
    );
    expect(ret.fullyReturned).toBe(true);

    const account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("0.00");

    const ledgerRows = await d
      .select()
      .from(s.loyaltyLedgerEntries)
      .where(eq(s.loyaltyLedgerEntries.customerId, 101))
      .orderBy(asc(s.loyaltyLedgerEntries.id));
    expect(ledgerRows.map((r) => [r.entryType, r.pointsDelta, r.balanceAfter])).toEqual([
      ["ORDER_EARN", "100.00", "100.00"],
      ["REDEEM", "-100.00", "0.00"],
      ["ORDER_REVERSE", "0.00", "0.00"],
    ]);
    expect(ledgerRows[2]!.note).toContain("100.00");
  });

  it("يحافظ على حالة الطلب DELIVERED ومؤشرات التحليلات وإنفاق العميل عند تصحيح فاتورة طلب متجر (لأعلى ثم مرتجعات جزئية متتابعة)", async () => {
    const d = db();
    const delivered = await createAndDeliverOrder({
      lines: [{ productUnitId: 1, quantity: 3 }], // 15,000 د.ع -> 150.00 نقطة
      requestId: "w4-upward-correct-then-returns",
    });

    await d
      .update(s.deliveryConsignments)
      .set({
        parcelStatus: "DELIVERED",
        status: "DELIVERED",
        moneyStatus: "SETTLED",
        settledAt: new Date(),
      })
      .where(eq(s.deliveryConsignments.invoiceId, delivered.invoiceId));

    // تصحيح لأعلى: من 3 قطع (15,000 د.ع) إلى 5 قطع (25,000 د.ع)
    const upward = await correctSale(
      {
        originalInvoiceId: delivered.invoiceId,
        notes: "زيادة الكمية إلى 5 قطع بعد المراجعة",
        clientRequestId: "w4-correct-upward-1",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
      },
      ADMIN_ACTOR,
    );

    // 1) حالة الطلب الإلكتروني يجب أن تبقى DELIVERED (لا تتحول خطأً إلى CANCELLED أثناء العكس الداخلي!)
    const orderAfterCorrect = (
      await d
        .select()
        .from(s.onlineOrders)
        .where(eq(s.onlineOrders.id, delivered.orderId))
    )[0]!;
    expect(orderAfterCorrect.status).toBe("DELIVERED");
    expect(Number(orderAfterCorrect.invoiceId)).toBe(upward.correctedInvoiceId);

    // 2) التحليلات وإنفاق العميل يعكسان الفاتورة المصحّحة (25,000 د.ع) والطلب المُسلّم (1 لا 0!)
    const todayBaghdad = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Baghdad",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const analyticsAfterUpward = await getStoreAnalytics({
      scopedBranchId: 1,
      fromYmd: todayBaghdad,
      toYmd: todayBaghdad,
    });
    expect(analyticsAfterUpward.kpis.deliveredOrders).toBe(1);
    expect(analyticsAfterUpward.kpis.cancelledOrders).toBe(0);
    expect(analyticsAfterUpward.kpis.revenue).toBe("25000.00");
    expect(analyticsAfterUpward.kpis.deliveredRevenue).toBe("25000.00");

    const customersAfterUpward = await getStoreCustomers({ scopedBranchId: 1 });
    const zRow = customersAfterUpward.rows.find((r) => r.customerId === 101)!;
    expect(zRow.deliveredOrders).toBe(1);
    expect(zRow.spend).toBe("25000.00");

    // 3) التصحيح لأعلى لا يمنح نقاطاً إضافية مزدوجة ولا يخصم نقاطاً (يبقى 150.00)
    let account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("150.00");

    const newInvItem = (
      await d
        .select()
        .from(s.invoiceItems)
        .where(eq(s.invoiceItems.invoiceId, upward.correctedInvoiceId))
    )[0]!;

    // 4) مرتجع جزئي أول على الفاتورة البديلة: قطعتان (10,000 د.ع) -> يتبقى 15,000 د.ع (= أصل الاكتساب) -> استرداد 0 نقطة
    await returnSale(
      {
        invoiceId: upward.correctedInvoiceId,
        lines: [{ invoiceItemId: Number(newInvItem.id), baseQuantity: 2 }],
        refund: null,
        clientRequestId: "w4-ret-after-upward-1",
      },
      ADMIN_ACTOR,
    );
    account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("150.00");

    // 5) مرتجع جزئي ثانٍ على الفاتورة البديلة: قطعة واحدة (5,000 د.ع) -> يتبقى 10,000 د.ع (< 15,000 د.ع) -> استرداد -50.00 نقطة
    await returnSale(
      {
        invoiceId: upward.correctedInvoiceId,
        lines: [{ invoiceItemId: Number(newInvItem.id), baseQuantity: 1 }],
        refund: null,
        clientRequestId: "w4-ret-after-upward-2",
      },
      ADMIN_ACTOR,
    );
    account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("100.00");
  });

  it("يستردّ كامل النقاط المكتسبة عند إلغاء فاتورة طلب متجر عبر cancelSale", async () => {
    const d = db();

    const sale = await createSale(
      {
        branchId: 1,
        customerId: 101,
        sourceType: "ONLINE",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], // 10,000 د.ع
      },
      ADMIN_ACTOR,
    );
    const [ordRes] = await d.insert(s.onlineOrders).values({
      orderNumber: "ORD-CANCEL-LOY-1",
      customerId: 101,
      branchId: 1,
      invoiceId: sale.invoiceId,
      subtotal: "10000.00",
      shippingCost: "0.00",
      taxAmount: "0.00",
      total: "10000.00",
      status: "SHIPPED",
      clientRequestId: "w4-cancel-sale-order-1",
    });
    const orderId = Number((ordRes as { insertId: number }).insertId);

    // منح نقاط الطلب عند إتمام التسليم المباشر
    await setOnlineOrderStatus(
      { id: orderId, status: "DELIVERED", scopedBranchId: null },
      ADMIN_ACTOR.userId,
    );
    let account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("100.00");

    // تحويل حالة الطلب إلى PROCESSING بلا عهدة قبل إلغاء الفاتورة عبر cancelSale
    await d
      .update(s.onlineOrders)
      .set({ status: "PROCESSING" })
      .where(eq(s.onlineOrders.id, orderId));

    await cancelSale(
      {
        invoiceId: sale.invoiceId,
        refundPaymentMethod: "CASH",
        reason: "إلغاء فاتورة الطلب بعد المراجعة",
      },
      ADMIN_ACTOR,
    );

    account = (
      await d
        .select()
        .from(s.loyaltyAccounts)
        .where(eq(s.loyaltyAccounts.customerId, 101))
    )[0]!;
    expect(account.pointsBalance).toBe("0.00");

    const cancelLedger = await d
      .select()
      .from(s.loyaltyLedgerEntries)
      .where(eq(s.loyaltyLedgerEntries.onlineOrderId, orderId))
      .orderBy(asc(s.loyaltyLedgerEntries.id));
    expect(cancelLedger.map((r) => [r.entryType, r.pointsDelta, r.balanceAfter])).toEqual([
      ["ORDER_EARN", "100.00", "100.00"],
      ["ORDER_REVERSE", "-100.00", "0.00"],
    ]);
  });

  it("يدعم مفتاح clientRequestId بطول 80 حرفاً مع معرّف عميل bigint طويل دون خطأ ER_DATA_TOO_LONG مع حماية الإعادة", async () => {
    const d = db();
    const bigCustomerId = 100_000_000_000_101;
    const bigPhone = "+9647708889991";
    await d.insert(s.customers).values({
      id: bigCustomerId,
      name: "عميل بمعرّف كبير",
      phone: bigPhone,
      customerType: "فرد",
      defaultPriceTier: "RETAIL",
      currentBalance: "0.00",
      creditLimit: "9999999.00",
      isActive: true,
      sessionVersion: 0,
    });
    const program = (await d.select().from(s.loyaltyPrograms))[0]!;
    await d.insert(s.loyaltyAccounts).values({
      programId: Number(program.id),
      customerId: bigCustomerId,
      pointsBalance: "250.00",
    });

    const bigSession = await signStorefrontCustomerSession({
      customerId: bigCustomerId,
      firebaseUid: "uid-big-customer",
      phone: bigPhone,
      sessionVersion: 0,
    });
    const maxLenRequestId = `req-${"x".repeat(76)}`; // 80 chars exact
    expect(maxLenRequestId).toHaveLength(80);

    const issuedBig = await redeemStorefrontLoyaltyPoints({
      customerSessionToken: bigSession,
      points: 100,
      clientRequestId: maxLenRequestId,
    });
    expect(issuedBig.outcome).toBe("ISSUED");
    expect(issuedBig.pointsBalance).toBe("150.00");

    const replayedBig = await redeemStorefrontLoyaltyPoints({
      customerSessionToken: bigSession,
      points: 100,
      clientRequestId: maxLenRequestId,
    });
    expect(replayedBig.outcome).toBe("REPLAYED");
    expect(replayedBig.code).toBe(issuedBig.code);
    expect(replayedBig.pointsBalance).toBe("150.00");
  });

  it("لا تحجب برامج قسائم الولاء المولّدة (أكثر من 10 قيم استبدال مختلفة) برنامج قسيمة العودة العام النشط في issueBounceBackCouponTx", async () => {
    const d = db();
    const validFrom = new Date("2025-01-01T00:00:00.000Z");

    const [promoRes] = await d.insert(s.promotions).values({
      name: "عرض قسيمة العودة العام",
      description: "خصم 2,500 د.ع للزيارة القادمة",
      type: "AMOUNT",
      discountPercent: "0.00",
      discountAmount: "2500.00",
      maxDiscountAmount: "2500.00",
      minLineAmount: "0.00",
      minOrderSpend: "10000.00",
      scope: "ALL",
      effectiveFrom: validFrom,
      effectiveTo: null,
      customerTier: null,
      branchId: null,
      freeShipping: false,
      shippingDiscountAmount: "0.00",
      priority: 50,
      isActive: true,
      applicationMode: "COUPON",
      isStoreManaged: false,
      createdBy: 1,
    });
    const bouncePromoId = Number((promoRes as { insertId: number }).insertId);

    const [progRes] = await d.insert(s.couponPrograms).values({
      promotionId: bouncePromoId,
      name: "برنامج هدية العودة العام",
      status: "ACTIVE",
      branchId: null,
      validFrom,
      validTo: null,
      perCouponLimit: 1,
      perCustomerLimit: 10,
      isFirstOrderSelfService: false,
      codePrefix: "NEXT",
      designJson: {
        isAutoBounceBack: true,
        bounceBackHeadline: "هدية العودة",
        bounceBackPrefix: "NEXT",
        autoBounceBackMinInvoice: "15000.00",
      },
      createdBy: 1,
    });
    const bounceProgramId = Number((progRes as { insertId: number }).insertId);

    // إضافة برنامج كوبونات عام لاحق بـ isAutoBounceBack: false للتأكد من عدم التقاطه في SQL
    await d.insert(s.couponPrograms).values({
      promotionId: bouncePromoId,
      name: "برنامج كوبونات عادي بلا عودة تلقائية",
      status: "ACTIVE",
      branchId: null,
      validFrom,
      validTo: null,
      perCouponLimit: 1,
      perCustomerLimit: 10,
      isFirstOrderSelfService: false,
      codePrefix: "REG",
      designJson: {
        isAutoBounceBack: false,
        bounceBackHeadline: "لا ينبغي إصداره",
      },
      createdBy: 1,
    });

    const loyaltyProgram = (await d.select().from(s.loyaltyPrograms))[0]!;
    await d.insert(s.loyaltyAccounts).values({
      programId: Number(loyaltyProgram.id),
      customerId: 101,
      pointsBalance: "5000.00",
    });

    const customerSession = await signStorefrontCustomerSession({
      customerId: 101,
      firebaseUid: "uid-customer-101-crowding",
      phone: CUSTOMER_PHONE,
      sessionVersion: 0,
    });

    // تنفيذ 12 عملية استبدال بقيم نقاط مختلفة (100..111) لتوليد 12 برنامج LOY عام أحدث من برنامج العودة
    for (let pts = 100; pts <= 111; pts += 1) {
      const redeemed = await redeemStorefrontLoyaltyPoints({
        customerSessionToken: customerSession,
        points: pts,
        clientRequestId: `w4-crowding-redeem-${pts}`,
      });
      expect(redeemed.outcome).toBe("ISSUED");
    }

    const loyPrograms = await d
      .select({ id: s.couponPrograms.id })
      .from(s.couponPrograms)
      .where(eq(s.couponPrograms.codePrefix, "LOY"));
    expect(loyPrograms).toHaveLength(12);
    for (const lp of loyPrograms) {
      expect(Number(lp.id)).toBeGreaterThan(bounceProgramId);
    }

    // تحت الحد الأدنى للفاتورة (10,000 < 15,000) لا تصدر قسيمة عودة
    const belowMin = await withTx((tx) =>
      issueBounceBackCouponTx(tx, {
        branchId: 1,
        customerId: 101,
        customerTier: "RETAIL",
        invoiceTotal: money("10000.00"),
      }),
    );
    expect(belowMin).toBeNull();

    // عند استيفاء الحد الأدنى تصدر قسيمة العودة رغم وجود 12 برنامج LOY أحدث + برنامج REG
    const issuedBounce = await withTx((tx) =>
      issueBounceBackCouponTx(tx, {
        branchId: 1,
        customerId: 101,
        customerTier: "RETAIL",
        invoiceTotal: money("20000.00"),
      }),
    );
    expect(issuedBounce).not.toBeNull();
    expect(issuedBounce?.headline).toBe("هدية العودة");
    expect(issuedBounce?.code).toMatch(/^NEXT-[A-Z0-9]{5}-[A-Z0-9]{5}$/);

    const storedBounceCoupon = (
      await d
        .select()
        .from(s.coupons)
        .where(eq(s.coupons.codeHash, hashCouponCode(issuedBounce!.code)))
    )[0];
    expect(storedBounceCoupon).toBeDefined();
    expect(Number(storedBounceCoupon?.programId)).toBe(bounceProgramId);

    // التحقق من تجاهل designJson الفارغ {} وبقاء أولوية الفرع المحدد (branchId=1) على البرنامج العام (branchId=null)
    await d.insert(s.couponPrograms).values({
      promotionId: bouncePromoId,
      name: "برنامج بتصميم فارغ",
      status: "ACTIVE",
      branchId: 1,
      validFrom,
      validTo: null,
      perCouponLimit: 1,
      perCustomerLimit: 10,
      isFirstOrderSelfService: false,
      codePrefix: "EMPTY",
      designJson: {},
      createdBy: 1,
    });
    const [branchProgRes] = await d.insert(s.couponPrograms).values({
      promotionId: bouncePromoId,
      name: "برنامج هدية العودة لفرع الرئيسي",
      status: "ACTIVE",
      branchId: 1,
      validFrom,
      validTo: null,
      perCouponLimit: 1,
      perCustomerLimit: 10,
      isFirstOrderSelfService: false,
      codePrefix: "BR1",
      designJson: {
        isAutoBounceBack: true,
        bounceBackHeadline: "هدية الفرع الرئيسي",
        bounceBackPrefix: "BR1",
        autoBounceBackMinInvoice: "15000.00",
      },
      createdBy: 1,
    });
    const branchBounceProgramId = Number((branchProgRes as { insertId: number }).insertId);

    const issuedBranchBounce = await withTx((tx) =>
      issueBounceBackCouponTx(tx, {
        branchId: 1,
        customerId: 101,
        customerTier: "RETAIL",
        invoiceTotal: money("20000.00"),
      }),
    );
    expect(issuedBranchBounce).not.toBeNull();
    expect(issuedBranchBounce?.headline).toBe("هدية الفرع الرئيسي");
    expect(issuedBranchBounce?.code).toMatch(/^BR1-[A-Z0-9]{5}-[A-Z0-9]{5}$/);

    const storedBranchCoupon = (
      await d
        .select()
        .from(s.coupons)
        .where(eq(s.coupons.codeHash, hashCouponCode(issuedBranchBounce!.code)))
    )[0];
    expect(Number(storedBranchCoupon?.programId)).toBe(branchBounceProgramId);
  });
});
