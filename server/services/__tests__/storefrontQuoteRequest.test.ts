import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  acceptStorefrontOfficialQuotationByGuestToken,
  acceptStorefrontOfficialQuotationForCustomer,
  createStorefrontQuoteRequest,
  trackStorefrontQuoteRequestByGuestToken,
  trackStorefrontQuoteRequestForCustomer,
} from "../storefrontQuoteRequestService";
import {
  getStorefrontQuoteRequestForOfficialQuotation,
  listStorefrontQuoteRequests,
  updateStorefrontQuoteRequestStatus,
} from "../storeAdmin/storefrontQuoteRequestAdminService";
import { createQuotation, setQuotationStatus } from "../quotationService";
import { truncateAllTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function seedCatalog() {
  const d = db();
  await d.insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await d.insert(s.users).values({
    id: 1,
    openId: "storefront_quote_test_manager",
    name: "مدير عروض المتجر",
    role: "manager",
    loginMethod: "local",
    branchId: 1,
  });
  await d.insert(s.products).values({
    id: 1,
    name: "ورق طباعة A4",
    showInStore: true,
  });
  await d.insert(s.productVariants).values([
    {
      id: 1,
      productId: 1,
      sku: "A4-WHITE",
      variantName: "أبيض",
      costPrice: "100.00",
    },
    {
      id: 2,
      productId: 1,
      sku: "A4-COLOR",
      color: "ملون",
      costPrice: "100.00",
    },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "رزمة",
      conversionFactor: "500",
      isStoreSaleUnit: true,
    },
    {
      id: 2,
      variantId: 2,
      unitName: "رزمة",
      conversionFactor: "500",
      isStoreSaleUnit: true,
    },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "2500.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "2500.00" },
  ]);
  // طلب العرض يبقى متاحاً للعميل حتى لو أوقف المدير الشراء المباشر مؤقتاً.
  await d.insert(s.storeSettings).values({
    id: 1,
    fulfillmentBranchId: 1,
    isOpen: false,
  });
}

async function issueSentOfficialQuotation(input: {
  requestId: number;
  customerId: number;
  clientRequestId: string;
  validUntil?: string | null;
}) {
  await updateStorefrontQuoteRequestStatus({
    requestId: input.requestId,
    status: "CONTACTED",
    scopedBranchId: 1,
  });
  const official = await createQuotation({
    branchId: 1,
    customerId: input.customerId,
    storefrontQuoteRequestId: input.requestId,
    clientRequestId: input.clientRequestId,
    validUntil: input.validUntil ?? null,
    lines: [{ variantId: 1, productUnitId: 1, quantity: "4" }],
  }, { userId: 1, branchId: 1, role: "manager" });
  await setQuotationStatus(
    official.quotationId,
    "SENT",
    { userId: 1, branchId: 1, role: "manager" },
  );
  return official;
}

beforeEach(async () => {
  await truncateAllTables();
  await seedCatalog();
});

describe("storefront quote requests", () => {
  it("يلتقط طلب الشركات كصورة احتياج فقط بلا طلب بيع أو حجز مخزون", async () => {
    const created = await createStorefrontQuoteRequest({
      customerName: "شركة الرافدين",
      customerPhone: "07701234567",
      companyName: "شركة الرافدين للتجهيزات",
      governorate: "baghdad",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "نحتاج تجهيز القرطاسية للفصل الدراسي القادم مع طباعة شعار الشركة.",
      clientRequestId: "quote-business-first-request",
      lines: [
        { productUnitId: 1, quantity: 4 },
        { productUnitId: 2, quantity: 3 },
      ],
    });

    expect(created).toMatchObject({ idempotentReplay: false });
    expect(created.requestNumber).toMatch(/^SRQ-\d+$/);
    expect(created.guestTrackingToken).toMatch(/^[a-f0-9]{32}\.[a-z0-9]+\.[A-Za-z0-9_-]{43}$/);
    expect(created.guestTrackingExpiresAt).toBeInstanceOf(Date);
    expect(await db().select().from(s.onlineOrders)).toHaveLength(0);
    expect(await db().select().from(s.branchStock)).toHaveLength(0);

    const request = (await db()
      .select()
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, created.requestId)))[0]!;
    expect(request).toMatchObject({
      requestNumber: created.requestNumber,
      status: "PENDING",
      requestType: "BUSINESS",
      customerNote: "نحتاج تجهيز القرطاسية للفصل الدراسي القادم مع طباعة شعار الشركة.",
    });
    const items = await db()
      .select()
      .from(s.storefrontQuoteRequestItems)
      .where(eq(s.storefrontQuoteRequestItems.quoteRequestId, created.requestId));
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ productName: "ورق طباعة A4", unitName: "رزمة", quantity: 4, baseQuantity: 2000 }),
      expect.objectContaining({ productName: "ورق طباعة A4", unitName: "رزمة", quantity: 3, baseQuantity: 1500 }),
    ]));
    const tracking = await trackStorefrontQuoteRequestByGuestToken(
      created.guestTrackingToken!,
    );
    expect(tracking).toMatchObject({
      requestNumber: created.requestNumber,
      status: "PENDING",
      requestType: "BUSINESS",
    });
    expect(tracking.items).toHaveLength(2);
    expect(tracking).not.toHaveProperty("staffNote");
  });

  it("يعيد نفس طلب العميل عند إعادة الإرسال ويقيّد متابعته بفرع الموظف", async () => {
    const input = {
      customerName: "مكتب النور",
      customerPhone: "07801234567",
      contactPreference: "PHONE" as const,
      requestType: "BULK" as const,
      note: "نريد عرضاً لكمية جملة من الملفات والأقلام.",
      clientRequestId: "quote-idempotent-request",
      lines: [{ productUnitId: 1, quantity: 12 }],
    };
    const first = await createStorefrontQuoteRequest(input);
    const replay = await createStorefrontQuoteRequest(input);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(await db().select().from(s.storefrontQuoteRequests)).toHaveLength(1);

    const visible = await listStorefrontQuoteRequests({ scopedBranchId: 1 });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ requestNumber: first.requestNumber, customerName: "مكتب النور" });
    expect(await listStorefrontQuoteRequests({ scopedBranchId: 2 })).toHaveLength(0);

    await updateStorefrontQuoteRequestStatus({
      requestId: first.requestId,
      status: "CONTACTED",
      staffNote: "سيتم التواصل عبر الهاتف صباحاً.",
      scopedBranchId: 1,
    });
    const request = (await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, first.requestId)))[0]!;
    const owned = await trackStorefrontQuoteRequestForCustomer(
      first.requestNumber,
      Number(request.customerId),
    );
    expect(owned.status).toBe("CONTACTED");
    expect(owned).not.toHaveProperty("staffNote");
    await expect(updateStorefrontQuoteRequestStatus({
      requestId: first.requestId,
      status: "PENDING",
      scopedBranchId: 1,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(updateStorefrontQuoteRequestStatus({
      requestId: first.requestId,
      status: "QUOTED",
      scopedBranchId: 1,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يرفض رمز الضيف المزور ولا يسمح لجلسة عميل آخر بتخمين رقم SRQ", async () => {
    const first = await createStorefrontQuoteRequest({
      customerName: "شركة الفرات",
      customerPhone: "07701234567",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "نحتاج تجهيز قرطاسية وطباعة بطاقات للموظفين.",
      clientRequestId: "quote-guest-token-first",
      lines: [{ productUnitId: 1, quantity: 3 }],
    });
    const second = await createStorefrontQuoteRequest({
      customerName: "مكتب دجلة",
      customerPhone: "07801234567",
      contactPreference: "PHONE",
      requestType: "BULK",
      note: "نحتاج ملفات وأقلاماً لكمية فصل كامل.",
      clientRequestId: "quote-guest-token-second",
      lines: [{ productUnitId: 2, quantity: 4 }],
    });
    const forged = `${first.guestTrackingToken!.slice(0, -1)}${first.guestTrackingToken!.endsWith("A") ? "B" : "A"}`;
    await expect(trackStorefrontQuoteRequestByGuestToken(forged)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      (await trackStorefrontQuoteRequestByGuestToken(second.guestTrackingToken!))
        .requestNumber,
    ).toBe(second.requestNumber);

    const firstRequest = (await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, first.requestId)))[0]!;
    await expect(
      trackStorefrontQuoteRequestForCustomer(
        second.requestNumber,
        Number(firstRequest.customerId),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("يربط العرض الرسمي الوحيد بطلب مراجع في معاملة واحدة ولا ينقل السعر من لقطة الطلب", async () => {
    const request = await createStorefrontQuoteRequest({
      customerName: "شركة دجلة للتجهيز",
      customerPhone: "07701234567",
      companyName: "شركة دجلة للتجهيز",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "نريد تسعيراً رسمياً لورق الطباعة مع إمكانية مراجعة السعر النهائي.",
      clientRequestId: "quote-official-link-source",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    await updateStorefrontQuoteRequestStatus({
      requestId: request.requestId,
      status: "CONTACTED",
      scopedBranchId: 1,
    });
    const source = await getStorefrontQuoteRequestForOfficialQuotation({
      requestId: request.requestId,
      scopedBranchId: 1,
    });
    expect(source).toMatchObject({
      requestNumber: request.requestNumber,
      customerPriceTier: "RETAIL",
      items: [expect.objectContaining({
        productUnitId: 1,
        variantId: 1,
        quantity: 4,
        suggestedUnitPrice: "2500.00",
        isCurrentCatalogLine: true,
      })],
    });

    const official = await createQuotation({
      branchId: 1,
      customerId: source.customerId!,
      storefrontQuoteRequestId: request.requestId,
      clientRequestId: "quote-official-link-created",
      lines: [{
        variantId: 1,
        productUnitId: 1,
        quantity: "4",
        // سعر الموظف هنا مختلف عمداً عن السعر المقترح للكتالوج: المصدر ليس سعراً ملزماً.
        unitPriceOverride: "2300.00",
      }],
    }, { userId: 1, branchId: 1, role: "manager" });
    expect(official.total).toBe("9200.00");

    const linked = (await db()
      .select()
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, request.requestId)))[0]!;
    expect(linked).toMatchObject({
      status: "QUOTED",
      officialQuotationId: official.quotationId,
    });
    const ownerTracking = await trackStorefrontQuoteRequestForCustomer(
      request.requestNumber,
      source.customerId!,
    );
    expect(ownerTracking).toMatchObject({
      officialQuotation: {
        quoteNumber: official.quoteNumber,
        validUntil: null,
        status: "DRAFT",
      },
    });
    expect(ownerTracking.officialQuotation).not.toHaveProperty("total");
    expect(await db().select().from(s.onlineOrders)).toHaveLength(0);
    await expect(createQuotation({
      branchId: 1,
      customerId: source.customerId!,
      storefrontQuoteRequestId: request.requestId,
      clientRequestId: "quote-official-link-duplicate",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "2300.00" }],
    }, { userId: 1, branchId: 1, role: "manager" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يسجّل قبول المالك للعرض المرسل بعد فحصه من دون فاتورة أو حجز مخزون", async () => {
    const request = await createStorefrontQuoteRequest({
      customerName: "شركة الندى",
      customerPhone: "07701234567",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "نحتاج عرضاً رسمياً لأربع رزم ورق مع تسليم لاحق بعد تأكيد فريق المبيعات.",
      clientRequestId: "quote-customer-acceptance-request",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    const requestRow = (await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, request.requestId)))[0]!;
    const official = await issueSentOfficialQuotation({
      requestId: request.requestId,
      customerId: Number(requestRow.customerId),
      clientRequestId: "quote-customer-acceptance-official",
      validUntil: "2099-12-31",
    });
    await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 3_000 });

    const accepted = await acceptStorefrontOfficialQuotationByGuestToken(
      request.guestTrackingToken!,
    );
    expect(accepted).toEqual({
      outcome: "ACCEPTED",
      quoteNumber: official.quoteNumber,
      quoteStatus: "ACCEPTED",
      alreadyAccepted: false,
      nextStep: "STAFF_CONFIRMATION",
    });
    const quote = (await db()
      .select({ status: s.quotations.status })
      .from(s.quotations)
      .where(eq(s.quotations.id, official.quotationId)))[0]!;
    expect(quote.status).toBe("ACCEPTED");
    expect(await db().select().from(s.onlineOrders)).toHaveLength(0);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.reservationStock)).toHaveLength(0);
    expect((await db().select().from(s.branchStock))[0]?.quantity).toBe(3_000);

    const replay = await acceptStorefrontOfficialQuotationForCustomer(
      request.requestNumber,
      Number(requestRow.customerId),
    );
    expect(replay).toMatchObject({ outcome: "ACCEPTED", alreadyAccepted: true });
    expect((await trackStorefrontQuoteRequestForCustomer(
      request.requestNumber,
      Number(requestRow.customerId),
    )).officialQuotation).toMatchObject({ status: "ACCEPTED" });
  });

  it("يعيد العرض للمراجعة عند تغيّر السعر أو التوفر ولا يثبّت بيعاً", async () => {
    const request = await createStorefrontQuoteRequest({
      customerName: "مكتب البيان",
      customerPhone: "07801234567",
      contactPreference: "PHONE",
      requestType: "BULK",
      note: "نحتاج عرضاً لكمية رزم ورق مع مراجعة السعر المتفق عليه قبل القبول.",
      clientRequestId: "quote-requote-check-request",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    const requestRow = (await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, request.requestId)))[0]!;
    const official = await issueSentOfficialQuotation({
      requestId: request.requestId,
      customerId: Number(requestRow.customerId),
      clientRequestId: "quote-requote-check-official",
      validUntil: "2099-12-31",
    });
    await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 3_000 });
    await db().update(s.productPrices)
      .set({ price: "2600.00" })
      .where(eq(s.productPrices.productUnitId, 1));

    const priceChanged = await acceptStorefrontOfficialQuotationByGuestToken(
      request.guestTrackingToken!,
    );
    expect(priceChanged).toMatchObject({
      outcome: "REQUOTE_REQUIRED",
      quoteNumber: official.quoteNumber,
      quoteStatus: "SENT",
      reasons: ["PRICE_CHANGED"],
      nextStep: "CONTACT_STAFF",
    });

    await db().update(s.productPrices)
      .set({ price: "2500.00" })
      .where(eq(s.productPrices.productUnitId, 1));
    await db().update(s.branchStock)
      .set({ quantity: 1_999 })
      .where(eq(s.branchStock.variantId, 1));
    const unavailable = await acceptStorefrontOfficialQuotationByGuestToken(
      request.guestTrackingToken!,
    );
    expect(unavailable).toMatchObject({
      outcome: "REQUOTE_REQUIRED",
      quoteStatus: "SENT",
      reasons: ["UNAVAILABLE"],
    });
    expect((await db()
      .select({ status: s.quotations.status })
      .from(s.quotations)
      .where(eq(s.quotations.id, official.quotationId)))[0]?.status).toBe("SENT");
    expect(await db().select().from(s.onlineOrders)).toHaveLength(0);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.reservationStock)).toHaveLength(0);
  });

  it("لا يقبل التخمين بين العملاء أو رمز الضيف المزور ويحوّل العرض المنتهي إلى إعادة تسعير", async () => {
    const owner = await createStorefrontQuoteRequest({
      customerName: "شركة الصفا",
      customerPhone: "07701234567",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "نحتاج متابعة طلب عرض منفصل باسم الشركة مع موافقة المشتريات لاحقاً.",
      clientRequestId: "quote-accept-owner-request",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    const target = await createStorefrontQuoteRequest({
      customerName: "مكتب زاد",
      customerPhone: "07801234567",
      contactPreference: "PHONE",
      requestType: "BULK",
      note: "نحتاج عرضاً منتهياً للتحقق من أن القبول لا يتجاوز تاريخ الصلاحية.",
      clientRequestId: "quote-accept-expired-request",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    const [ownerRow, targetRow] = await Promise.all([owner.requestId, target.requestId].map(async (requestId) => (
      (await db()
        .select({ customerId: s.storefrontQuoteRequests.customerId })
        .from(s.storefrontQuoteRequests)
        .where(eq(s.storefrontQuoteRequests.id, requestId)))[0]!
    )));
    const official = await issueSentOfficialQuotation({
      requestId: target.requestId,
      customerId: Number(targetRow.customerId),
      clientRequestId: "quote-accept-expired-official",
      validUntil: "2000-01-01",
    });

    await expect(acceptStorefrontOfficialQuotationForCustomer(
      target.requestNumber,
      Number(ownerRow.customerId),
    )).rejects.toMatchObject({ code: "NOT_FOUND" });
    const forged = `${target.guestTrackingToken!.slice(0, -1)}${target.guestTrackingToken!.endsWith("A") ? "B" : "A"}`;
    await expect(acceptStorefrontOfficialQuotationByGuestToken(forged)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const expired = await acceptStorefrontOfficialQuotationByGuestToken(
      target.guestTrackingToken!,
    );
    expect(expired).toEqual({
      outcome: "REQUOTE_REQUIRED",
      quoteNumber: official.quoteNumber,
      quoteStatus: "EXPIRED",
      reasons: ["EXPIRED"],
      nextStep: "CONTACT_STAFF",
    });
    expect((await db()
      .select({ status: s.quotations.status })
      .from(s.quotations)
      .where(eq(s.quotations.id, official.quotationId)))[0]?.status).toBe("EXPIRED");
    expect(await db().select().from(s.onlineOrders)).toHaveLength(0);
    expect(await db().select().from(s.invoices)).toHaveLength(0);
  });
});
