import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createStorefrontQuoteRequest } from "../storefrontQuoteRequestService";
import {
  listStorefrontQuoteRequests,
  updateStorefrontQuoteRequestStatus,
} from "../storeAdmin/storefrontQuoteRequestAdminService";
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
  // طلب العرض يبقى متاحاً للعميل حتى لو أوقف المدير الشراء المباشر مؤقتاً.
  await d.insert(s.storeSettings).values({
    id: 1,
    fulfillmentBranchId: 1,
    isOpen: false,
  });
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
    await expect(updateStorefrontQuoteRequestStatus({
      requestId: first.requestId,
      status: "PENDING",
      scopedBranchId: 1,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
