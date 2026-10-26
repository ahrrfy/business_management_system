import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { __resetImageStoreForTest } from "../../lib/imageStore";
import {
  findStorefrontCustomizationAssetForStaff,
  uploadStorefrontCustomizationAsset,
} from "../storefrontCustomizationAssetService";
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
import { setContractPriceActive, upsertContractPrice } from "../contractPriceService";
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
  unitPriceOverride?: string;
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
    lines: [{ variantId: 1, productUnitId: 1, quantity: "4", unitPriceOverride: input.unitPriceOverride }],
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
  it("يقترح سعر عقد العميل عند تجهيز طلب المتجر لعرض رسمي", async () => {
    const request = await createStorefrontQuoteRequest({
      customerName: "شركة العقد",
      customerPhone: "07701112222",
      companyName: "شركة العقد",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "نحتاج عرضاً رسمياً بالسعر المتفق عليه في العقد.",
      clientRequestId: "quote-contract-suggestion",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    await updateStorefrontQuoteRequestStatus({
      requestId: request.requestId,
      status: "CONTACTED",
      scopedBranchId: 1,
    });
    const [stored] = await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, request.requestId));
    await upsertContractPrice({
      customerId: Number(stored!.customerId),
      productUnitId: 1,
      price: "2100.00",
    }, { userId: 1, branchId: 1 });

    const prepared = await getStorefrontQuoteRequestForOfficialQuotation({
      requestId: request.requestId,
      scopedBranchId: 1,
    });
    expect(prepared.items[0]).toMatchObject({
      suggestedUnitPrice: "2100.00",
      suggestedPriceSource: "CONTRACT",
    });
  });

  it("لا يسقط من فئة WHOLESALE إلى RETAIL عند غياب صف الفئة", async () => {
    const request = await createStorefrontQuoteRequest({
      customerName: "شركة الجملة",
      customerPhone: "07701112223",
      companyName: "شركة الجملة",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "نحتاج تسعير الجملة الفعلي فقط، بلا تخمين من التجزئة.",
      clientRequestId: "quote-wholesale-no-retail-fallback",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    await updateStorefrontQuoteRequestStatus({
      requestId: request.requestId,
      status: "CONTACTED",
      scopedBranchId: 1,
    });
    const [stored] = await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, request.requestId));
    await db().update(s.customers)
      .set({ defaultPriceTier: "WHOLESALE" })
      .where(eq(s.customers.id, Number(stored!.customerId)));

    const prepared = await getStorefrontQuoteRequestForOfficialQuotation({
      requestId: request.requestId,
      scopedBranchId: 1,
    });
    expect(prepared.items[0]).toMatchObject({
      suggestedUnitPrice: null,
      suggestedPriceSource: null,
    });
  });

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
      unitPriceOverride: "2300.00",
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

  it.each([
    { change: "changed" as const },
    { change: "disabled" as const },
  ])("يعيد العرض للمراجعة عند تغيّر العقد أو تعطيله ($change)", async ({ change }) => {
    const request = await createStorefrontQuoteRequest({
      customerName: `شركة عقد ${change}`,
      customerPhone: change === "changed" ? "07701234568" : "07701234569",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "نحتاج عرضاً رسمياً مرتبطاً بسعر العقد الفعلي عند الإصدار.",
      clientRequestId: `quote-contract-${change}-request`,
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    const [requestRow] = await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, request.requestId));
    const contract = await upsertContractPrice({
      customerId: Number(requestRow!.customerId),
      productUnitId: 1,
      price: "2100.00",
    }, { userId: 1, branchId: 1 });
    const official = await issueSentOfficialQuotation({
      requestId: request.requestId,
      customerId: Number(requestRow!.customerId),
      clientRequestId: `quote-contract-${change}-official`,
      validUntil: "2099-12-31",
    });
    await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 3_000 });

    if (change === "changed") {
      await upsertContractPrice({
        customerId: Number(requestRow!.customerId),
        productUnitId: 1,
        price: "2200.00",
      }, { userId: 1, branchId: 1 });
    } else {
      // نفس الرقم لا يكفي: تعطيل العقد يغيّر مصدر المرجع من CONTRACT إلى TIER.
      await db().update(s.productPrices)
        .set({ price: "2100.00" })
        .where(eq(s.productPrices.productUnitId, 1));
      await setContractPriceActive(contract.id, false);
    }

    const result = await acceptStorefrontOfficialQuotationByGuestToken(request.guestTrackingToken!);
    expect(result).toMatchObject({
      outcome: "REQUOTE_REQUIRED",
      quoteNumber: official.quoteNumber,
      reasons: ["PRICE_CHANGED"],
    });
  });

  it("يثبت العقد عند تغيّر الفئة، ويقبل عقداً بلا صف سعر للفئة", async () => {
    const request = await createStorefrontQuoteRequest({
      customerName: "شركة العقد المستقل",
      customerPhone: "07701234570",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "العقد هو المرجع حتى لو لم يوجد سعر WHOLESALE في الكتالوج.",
      clientRequestId: "quote-contract-without-tier-request",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    const [requestRow] = await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, request.requestId));
    await db().update(s.customers)
      .set({ defaultPriceTier: "WHOLESALE" })
      .where(eq(s.customers.id, Number(requestRow!.customerId)));
    await upsertContractPrice({
      customerId: Number(requestRow!.customerId),
      productUnitId: 1,
      price: "2100.00",
    }, { userId: 1, branchId: 1 });
    const official = await issueSentOfficialQuotation({
      requestId: request.requestId,
      customerId: Number(requestRow!.customerId),
      clientRequestId: "quote-contract-without-tier-official",
      validUntil: "2099-12-31",
    });
    await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 3_000 });
    // تغيّر فئة العميل لا يغيّر مرجع العرض: priceTier المحفوظ WHOLESALE وعقده ما زال 2100.
    await db().update(s.customers)
      .set({ defaultPriceTier: "GOVERNMENT" })
      .where(eq(s.customers.id, Number(requestRow!.customerId)));

    const result = await acceptStorefrontOfficialQuotationByGuestToken(request.guestTrackingToken!);
    expect(result).toEqual({
      outcome: "ACCEPTED",
      quoteNumber: official.quoteNumber,
      quoteStatus: "ACCEPTED",
      alreadyAccepted: false,
      nextStep: "STAFF_CONFIRMATION",
    });
  });

  it("يقبل التجاوز اليدوي حين لم يوجد مرجع آلي وقت الإصدار ولا عند القبول", async () => {
    const request = await createStorefrontQuoteRequest({
      customerName: "شركة تسعير يدوي",
      customerPhone: "07701234572",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "الصنف بلا سعر جملة ونحتاج عرضاً يدوياً راجعه الموظف.",
      clientRequestId: "quote-manual-without-reference-request",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    const [requestRow] = await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, request.requestId));
    await db().update(s.customers)
      .set({ defaultPriceTier: "WHOLESALE" })
      .where(eq(s.customers.id, Number(requestRow!.customerId)));
    const official = await issueSentOfficialQuotation({
      requestId: request.requestId,
      customerId: Number(requestRow!.customerId),
      clientRequestId: "quote-manual-without-reference-official",
      validUntil: "2099-12-31",
      unitPriceOverride: "2100.00",
    });
    await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 3_000 });

    expect(await acceptStorefrontOfficialQuotationByGuestToken(request.guestTrackingToken!)).toEqual({
      outcome: "ACCEPTED",
      quoteNumber: official.quoteNumber,
      quoteStatus: "ACCEPTED",
      alreadyAccepted: false,
      nextStep: "STAFF_CONFIRMATION",
    });
  });

  it("يعيد التجاوز اليدوي بلا مرجع للمراجعة إذا ظهر مرجع آلي لاحقاً", async () => {
    const request = await createStorefrontQuoteRequest({
      customerName: "شركة مرجع ظهر لاحقاً",
      customerPhone: "07701234573",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "صدر السعر يدوياً ثم أضيف سعر الجملة قبل القبول.",
      clientRequestId: "quote-manual-later-reference-request",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    const [requestRow] = await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, request.requestId));
    await db().update(s.customers)
      .set({ defaultPriceTier: "WHOLESALE" })
      .where(eq(s.customers.id, Number(requestRow!.customerId)));
    const official = await issueSentOfficialQuotation({
      requestId: request.requestId,
      customerId: Number(requestRow!.customerId),
      clientRequestId: "quote-manual-later-reference-official",
      validUntil: "2099-12-31",
      unitPriceOverride: "2100.00",
    });
    await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 3_000 });
    await db().insert(s.productPrices).values({
      productUnitId: 1,
      priceTier: "WHOLESALE",
      price: "2200.00",
    });

    expect(await acceptStorefrontOfficialQuotationByGuestToken(request.guestTrackingToken!)).toMatchObject({
      outcome: "REQUOTE_REQUIRED",
      quoteNumber: official.quoteNumber,
      reasons: ["PRICE_CHANGED"],
    });
  });

  it("لا يرفض العرض عند تغيّر سعر الفئة ما دام العقد الفعّال ثابتاً", async () => {
    const request = await createStorefrontQuoteRequest({
      customerName: "شركة عقد ثابت",
      customerPhone: "07701234571",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "سعر العقد مستقل عن حركة سعر التجزئة.",
      clientRequestId: "quote-stable-contract-tier-change-request",
      lines: [{ productUnitId: 1, quantity: 4 }],
    });
    const [requestRow] = await db()
      .select({ customerId: s.storefrontQuoteRequests.customerId })
      .from(s.storefrontQuoteRequests)
      .where(eq(s.storefrontQuoteRequests.id, request.requestId));
    await upsertContractPrice({
      customerId: Number(requestRow!.customerId),
      productUnitId: 1,
      price: "2100.00",
    }, { userId: 1, branchId: 1 });
    const official = await issueSentOfficialQuotation({
      requestId: request.requestId,
      customerId: Number(requestRow!.customerId),
      clientRequestId: "quote-stable-contract-tier-change-official",
      validUntil: "2099-12-31",
    });
    await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 3_000 });
    await db().update(s.productPrices)
      .set({ price: "2600.00" })
      .where(eq(s.productPrices.productUnitId, 1));

    expect(await acceptStorefrontOfficialQuotationByGuestToken(request.guestTrackingToken!)).toEqual({
      outcome: "ACCEPTED",
      quoteNumber: official.quoteNumber,
      quoteStatus: "ACCEPTED",
      alreadyAccepted: false,
      nextStep: "STAFF_CONFIRMATION",
    });
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
  it("يعامل العرض المنتهي في يوم بغداد كمنتهٍ حتى قبل منتصف UTC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-09-10T22:30:00.000Z")); // 01:30 في بغداد من اليوم التالي
    try {
      const request = await createStorefrontQuoteRequest({
        customerName: "مكتب بغداد",
        customerPhone: "07704567890",
        contactPreference: "PHONE",
        requestType: "BULK",
        note: "نحتاج عرضاً يثبت انتهاءه مع بداية يوم بغداد التالي.",
        clientRequestId: "quote-baghdad-expiry-request",
        lines: [{ productUnitId: 1, quantity: 4 }],
      });
      const requestRow = (await db()
        .select({ customerId: s.storefrontQuoteRequests.customerId })
        .from(s.storefrontQuoteRequests)
        .where(eq(s.storefrontQuoteRequests.id, request.requestId)))[0]!;
      const official = await issueSentOfficialQuotation({
        requestId: request.requestId,
        customerId: Number(requestRow.customerId),
        clientRequestId: "quote-baghdad-expiry-official",
        validUntil: "2030-09-10",
      });

      await expect(acceptStorefrontOfficialQuotationByGuestToken(request.guestTrackingToken!))
        .resolves.toMatchObject({ outcome: "REQUOTE_REQUIRED", quoteStatus: "EXPIRED" });
      expect((await db()
        .select({ status: s.quotations.status })
        .from(s.quotations)
        .where(eq(s.quotations.id, official.quotationId)))[0]?.status).toBe("EXPIRED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("يربط مرفقات الشعار والمعاينة بطلب عرض السعر ويثبّتها ضد التنظيف ويعزل فروع الموظفين", async () => {
    const prevDriver = process.env.IMAGE_STORE_DRIVER;
    const prevDir = process.env.IMAGE_STORE_DIR;
    const tempDir = mkdtempSync(path.join(tmpdir(), "srq-custom-assets-"));
    process.env.IMAGE_STORE_DRIVER = "fs";
    process.env.IMAGE_STORE_DIR = tempDir;
    __resetImageStoreForTest();

    const validPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const validJpegBase64 = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xd9,
    ]).toString("base64");

    try {
      const d = db();
      await d.insert(s.branches).values({
        id: 2,
        name: "فرع البصرة",
        code: "BSR",
        type: "MAIN",
      });
      await d.insert(s.products).values({
        id: 99,
        name: "كوب حراري مخصص للشركات",
        showInStore: true,
        isCustomizable: true,
      });
      await d.insert(s.productVariants).values({
        id: 99,
        productId: 99,
        sku: "MUG-CORP-99",
        variantName: "أسود مطفي",
        costPrice: "3000.00",
      });
      await d.insert(s.productUnits).values({
        id: 99,
        variantId: 99,
        unitName: "قطعة",
        conversionFactor: "1",
        isStoreSaleUnit: true,
      });
      await d.insert(s.productPrices).values({
        productUnitId: 99,
        priceTier: "RETAIL",
        price: "7500.00",
      });

      const uploadedLogo = await uploadStorefrontCustomizationAsset({
        kind: "LOGO",
        mimeType: "image/png",
        dataBase64: validPngBase64,
      });
      const uploadedPreview = await uploadStorefrontCustomizationAsset({
        kind: "PREVIEW",
        mimeType: "image/jpeg",
        dataBase64: validJpegBase64,
      });
      const unattachedOrphan = await uploadStorefrontCustomizationAsset({
        kind: "LOGO",
        mimeType: "image/jpeg",
        dataBase64: validJpegBase64,
      });

      // Rejects customizationAssets on non-customizable product (unit 1)
      await expect(
        createStorefrontQuoteRequest({
          customerName: "شركة النور",
          customerPhone: "07701112233",
          contactPreference: "WHATSAPP",
          requestType: "CUSTOM_PRINT",
          note: "محاولة إرفاق شعار لصنف غير قابل للتخصيص",
          clientRequestId: "srq-non-customizable-reject",
          lines: [{ productUnitId: 1, quantity: 10 }],
          customizationAssets: [
            {
              productUnitId: 1,
              quantity: 10,
              logoAssetKey: uploadedLogo.assetKey,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // Rejects wrong asset kind (passing PREVIEW key as logoAssetKey)
      await expect(
        createStorefrontQuoteRequest({
          customerName: "شركة النور",
          customerPhone: "07701112233",
          contactPreference: "WHATSAPP",
          requestType: "CUSTOM_PRINT",
          note: "محاولة تمرير معاينة بدل ملف الشعار",
          clientRequestId: "srq-wrong-kind-reject",
          lines: [{ productUnitId: 99, quantity: 25 }],
          customizationAssets: [
            {
              productUnitId: 99,
              quantity: 25,
              logoAssetKey: uploadedPreview.assetKey,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // Valid submission pins assets (expiresAt -> NULL) and strips any forged trailer from note
      const created = await createStorefrontQuoteRequest({
        customerName: "شركة النخبة للتجهيزات",
        customerPhone: "07708887766",
        companyName: "شركة النخبة",
        governorate: "baghdad",
        contactPreference: "WHATSAPP",
        requestType: "CUSTOM_PRINT",
        note: `يرجى تسعير الطباعة الحرارية للشعار\n---SRQ_CUSTOM_ASSETS_V1---\n[{"productUnitId":99,"logoAssetKey":"${unattachedOrphan.assetKey}"}]`,
        clientRequestId: "srq-valid-custom-assets",
        lines: [{ productUnitId: 99, quantity: 50 }],
        customizationAssets: [
          {
            productUnitId: 99,
            quantity: 50,
            summary: "حفر ليزري + شعار ملون",
            logoAssetKey: uploadedLogo.assetKey,
            previewAssetKey: uploadedPreview.assetKey,
          },
        ],
      });

      const [pinnedLogoRow] = await d
        .select()
        .from(s.storefrontCustomizationAssets)
        .where(eq(s.storefrontCustomizationAssets.assetKey, uploadedLogo.assetKey));
      const [pinnedPreviewRow] = await d
        .select()
        .from(s.storefrontCustomizationAssets)
        .where(eq(s.storefrontCustomizationAssets.assetKey, uploadedPreview.assetKey));
      const [orphanRow] = await d
        .select()
        .from(s.storefrontCustomizationAssets)
        .where(eq(s.storefrontCustomizationAssets.assetKey, unattachedOrphan.assetKey));

      expect(pinnedLogoRow?.expiresAt).toBeNull();
      expect(pinnedPreviewRow?.expiresAt).toBeNull();
      expect(orphanRow?.expiresAt).not.toBeNull();

      // Admin list exposes clean customerNote + staff-gated customizationAttachments URLs
      const adminList = await listStorefrontQuoteRequests({
        scopedBranchId: 1,
        status: "PENDING",
      });
      const listed = adminList.find((r) => r.id === created.requestId)!;
      expect(listed).toBeDefined();
      expect(listed.customerNote).toBe("يرجى تسعير الطباعة الحرارية للشعار");
      expect(listed.customerNote).not.toContain("SRQ_CUSTOM_ASSETS_V1");
      expect(listed.customizationAttachments).toEqual([
        {
          productUnitId: 99,
          productName: "كوب حراري مخصص للشركات",
          variantLabel: "أسود مطفي",
          unitName: "قطعة",
          quantity: 50,
          summary: "حفر ليزري + شعار ملون",
          logoAssetUrl: `/api/img/order-customization/${uploadedLogo.assetKey}`,
          previewAssetUrl: `/api/img/order-customization/${uploadedPreview.assetKey}`,
        },
      ]);

      // Official quotation preparation also exposes clean customerNote + customizationAttachments
      await updateStorefrontQuoteRequestStatus({
        requestId: created.requestId,
        status: "CONTACTED",
        scopedBranchId: 1,
      });
      const prepared = await getStorefrontQuoteRequestForOfficialQuotation({
        requestId: created.requestId,
        scopedBranchId: 1,
      });
      expect(prepared.customerNote).toBe("يرجى تسعير الطباعة الحرارية للشعار");
      expect(prepared.customizationAttachments).toHaveLength(1);
      expect(prepared.customizationAttachments[0]?.logoAssetUrl).toBe(
        `/api/img/order-customization/${uploadedLogo.assetKey}`,
      );

      // Staff asset lookup: branch 1 & cross-branch allowed, branch 2 denied, forged/orphan denied, quote-only policy allowed
      expect(
        (
          await findStorefrontCustomizationAssetForStaff(uploadedLogo.assetKey, {
            scopedBranchId: 1,
          })
        )?.assetKey,
      ).toBe(uploadedLogo.assetKey);
      expect(
        (
          await findStorefrontCustomizationAssetForStaff(uploadedPreview.assetKey, {
            scopedBranchId: null,
            allowOrderAssets: false,
            allowQuoteAssets: true,
          })
        )?.assetKey,
      ).toBe(uploadedPreview.assetKey);
      expect(
        await findStorefrontCustomizationAssetForStaff(uploadedLogo.assetKey, {
          scopedBranchId: 2,
        }),
      ).toBeNull();
      expect(
        await findStorefrontCustomizationAssetForStaff(uploadedLogo.assetKey, {
          scopedBranchId: 1,
          allowOrderAssets: true,
          allowQuoteAssets: false,
        }),
      ).toBeNull();
      expect(
        await findStorefrontCustomizationAssetForStaff(unattachedOrphan.assetKey, {
          scopedBranchId: null,
        }),
      ).toBeNull();

      // Near-limit capacity test: 30 attachments with 300-char Arabic summaries + 2000-char Arabic note fit MySQL TEXT (65,535 bytes)
      const arabicSummary300 = "طباعة حرارية عالية الدقة مع نقش ليزري ذهبي مخصص للشركات والمؤسسات — ".repeat(5).slice(0, 300);
      const maxValidCreated = await createStorefrontQuoteRequest({
        customerName: "شركة القمة للتوريدات",
        customerPhone: "07705554433",
        contactPreference: "WHATSAPP",
        requestType: "CUSTOM_PRINT",
        note: "ملاحظة تفصيلية لتوريد دفعات متعددة للشركات والمؤسسات الرسمية ".repeat(30).slice(0, 1950),
        clientRequestId: "srq-max-30-arabic-attachments",
        lines: [{ productUnitId: 99, quantity: 300 }],
        customizationAssets: Array.from({ length: 30 }, (_, idx) => ({
          productUnitId: 99,
          quantity: 10,
          summary: `${idx + 1}-${arabicSummary300}`.slice(0, 300),
          logoAssetKey: uploadedLogo.assetKey,
          previewAssetKey: uploadedPreview.assetKey,
        })),
      });
      await updateStorefrontQuoteRequestStatus({
        requestId: maxValidCreated.requestId,
        status: "CONTACTED",
        scopedBranchId: 1,
      });
      const maxPrepared = await getStorefrontQuoteRequestForOfficialQuotation({
        requestId: maxValidCreated.requestId,
        scopedBranchId: 1,
      });
      expect(maxPrepared.customizationAttachments).toHaveLength(30);

      // Even with 190-char Arabic product name + 120-char variantName + 1995-char Arabic note + 30x300-char Arabic summaries, fits cleanly in MySQL TEXT
      await d
        .update(s.products)
        .set({ name: "درع كريستال مؤسسي فاخر محفور بالليزر مع علبة مخملية مبطنة ".repeat(4).slice(0, 190) })
        .where(eq(s.products.id, 99));
      await d
        .update(s.productVariants)
        .set({ variantName: "ذهبي ملكي لامع متعدد الطبقات ".repeat(5).slice(0, 120) })
        .where(eq(s.productVariants.id, 99));
      const heavyArabicCreated = await createStorefrontQuoteRequest({
        customerName: "شركة القمة للتوريدات",
        customerPhone: "07705554433",
        contactPreference: "WHATSAPP",
        requestType: "CUSTOM_PRINT",
        note: "ملاحظة تفصيلية مطولة باللغة العربية ".repeat(60).slice(0, 1995),
        clientRequestId: "srq-heavy-arabic-30-ok",
        lines: [{ productUnitId: 99, quantity: 300 }],
        customizationAssets: Array.from({ length: 30 }, (_, idx) => ({
          productUnitId: 99,
          quantity: 10,
          summary: `${idx + 1}-${"نقش عربي مزدوج مع إطار زخرفي وشعار كامل الألوان ".repeat(8)}`.slice(0, 300),
          logoAssetKey: uploadedLogo.assetKey,
          previewAssetKey: uploadedPreview.assetKey,
        })),
      });
      expect(heavyArabicCreated.requestNumber).toMatch(/^SRQ-/);

      // 3-byte UTF-8 BMP code units + JSON-escaped quotes (\"\uFDFD = 5 bytes per 2 JS chars -> >65,535 bytes across 30 items) -> rejected with BAD_REQUEST before SQL insert
      const bmpHeavyProduct = '"\uFDFD'.repeat(95); // 190 chars -> ~475 escaped UTF-8 bytes
      const bmpHeavyVariant = '"\uFDFD'.repeat(60); // 120 chars -> ~300 escaped UTF-8 bytes
      const bmpHeavySummary = "\uFDFD".repeat(300); // 300 chars -> 900 UTF-8 bytes
      await d
        .update(s.products)
        .set({ name: bmpHeavyProduct })
        .where(eq(s.products.id, 99));
      await d
        .update(s.productVariants)
        .set({ variantName: bmpHeavyVariant })
        .where(eq(s.productVariants.id, 99));
      await d
        .update(s.productUnits)
        .set({ unitName: "\uFDFD".repeat(25) })
        .where(eq(s.productUnits.id, 99));
      await expect(
        createStorefrontQuoteRequest({
          customerName: "شركة القمة للتوريدات",
          customerPhone: "07705554433",
          contactPreference: "WHATSAPP",
          requestType: "CUSTOM_PRINT",
          note: "\uFDFD".repeat(1995),
          clientRequestId: "srq-utf8-byte-ceiling-guard",
          lines: [{ productUnitId: 99, quantity: 300 }],
          customizationAssets: Array.from({ length: 30 }, () => ({
            productUnitId: 99,
            quantity: 10,
            summary: bmpHeavySummary,
            logoAssetKey: uploadedLogo.assetKey,
            previewAssetKey: uploadedPreview.assetKey,
          })),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // Exceeding 30 attachments rejects cleanly with BAD_REQUEST
      await expect(
        createStorefrontQuoteRequest({
          customerName: "شركة القمة للتوريدات",
          customerPhone: "07705554433",
          contactPreference: "WHATSAPP",
          requestType: "CUSTOM_PRINT",
          note: "تجاوز حد المرفقات المسموح",
          clientRequestId: "srq-exceed-31-attachments",
          lines: [{ productUnitId: 99, quantity: 310 }],
          customizationAssets: Array.from({ length: 31 }, () => ({
            productUnitId: 99,
            quantity: 10,
            logoAssetKey: uploadedLogo.assetKey,
          })),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally {
      if (prevDriver === undefined) delete process.env.IMAGE_STORE_DRIVER;
      else process.env.IMAGE_STORE_DRIVER = prevDriver;
      if (prevDir === undefined) delete process.env.IMAGE_STORE_DIR;
      else process.env.IMAGE_STORE_DIR = prevDir;
      __resetImageStoreForTest();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

});
