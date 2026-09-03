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
  it("يرفض منتجاً قابلاً للتخصيص ما دام عقد الطلب لا يثبت selectionDetails بنيوياً", async () => {
    await db().update(s.products).set({ isCustomizable: true }).where(eq(s.products.id, 1));
    const lines = [{ productUnitId: 1, quantity: 1 }];

    await expect(quoteOnlineOrder({ governorate: "baghdad", lines })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(createOnlineOrder({
      customerName: "زبون تخصيص",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "بغداد — الكرادة",
      clientRequestId: "custom-selection-must-fail-closed",
      lines,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.onlineOrders)).toHaveLength(0);
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
  });
});
