import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getReceptionDuplicateOrders } from "../reception/duplicateOrders";

const actor = { userId: 1, branchId: 1, role: "cashier" };
const phone = "+9647701234567";
function db() {
  const d = getDb();
  if (!d) throw new Error("test DB unavailable");
  return d;
}

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "الفرع", code: "OTHER", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values({
      id: 1,
      openId: "duplicate-reception",
      name: "موظف استقبال",
      role: "cashier",
      branchId: 1,
    });
  await db()
    .insert(s.customers)
    .values({
      id: 1,
      name: "عميل",
      phone,
      phone2: "+9647801234567",
      currentBalance: "0",
    });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "دفتر" },
      { id: 2, name: "طباعة", isService: true },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "DUP-BLUE", costPrice: "100" },
      { id: 2, productId: 1, sku: "DUP-RED", costPrice: "100" },
      { id: 3, productId: 2, sku: "DUP-PRINT", costPrice: "0" },
    ]);
  await db()
    .insert(s.productUnits)
    .values([
      {
        id: 1,
        variantId: 1,
        unitName: "قطعة",
        conversionFactor: "1",
        isBaseUnit: true,
      },
      { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12" },
      {
        id: 3,
        variantId: 2,
        unitName: "قطعة",
        conversionFactor: "1",
        isBaseUnit: true,
      },
      {
        id: 4,
        variantId: 3,
        unitName: "ورقة",
        conversionFactor: "1",
        isBaseUnit: true,
      },
    ]);
});

async function draft(
  id: number,
  extra: Partial<typeof s.receptionDrafts.$inferInsert> = {},
) {
  await db()
    .insert(s.receptionDrafts)
    .values({
      id,
      draftNumber: `DRF-${id}`,
      branchId: 1,
      commitRequestId: randomUUID(),
      createdBy: 1,
      contactPhone: phone,
      channel: "WHATSAPP",
      total: "12000",
      ...extra,
    });
  await db()
    .insert(s.receptionDraftLines)
    .values({
      draftId: id,
      lineKind: "GOODS",
      variantId: 1,
      productUnitId: 2,
      quantity: "1",
      unitPrice: "12000",
      lineTotal: "12000",
    });
}
async function online(
  id: number,
  branchId = 1,
  extra: Partial<s.InsertOnlineOrder> = {},
) {
  await db()
    .insert(s.onlineOrders)
    .values({
      id,
      orderNumber: `ORD-${id}`,
      customerId: 1,
      branchId,
      subtotal: "12000",
      total: "12000",
      status: "PROCESSING",
      ...extra,
    });
  await db()
    .insert(s.onlineOrderItems)
    .values({
      onlineOrderId: id,
      variantId: 1,
      productUnitId: 1,
      quantity: "12",
      baseQuantity: 12,
      unitPrice: "1000",
      total: "12000",
    });
}

describe("reception duplicate orders DB integration", () => {
  it("detects WhatsApp/Instagram/saved drafts/store and exposes issued invoice without changing records", async () => {
    await draft(10, { contactPhone: "٠٧٧٠١٢٣٤٥٦٧" });
    await draft(11, {
      channel: "INSTAGRAM",
      customerId: 1,
      contactPhone: null,
    });
    await db()
      .insert(s.invoices)
      .values({
        id: 1,
        invoiceNumber: "INV-DUP",
        sourceType: "ONLINE",
        sourceId: "duplicate-test",
        branchId: 1,
        customerId: 1,
        subtotal: "12000",
        total: "12000",
        status: "PENDING",
      });
    await online(20, 1, { invoiceId: 1 });
    const result = await getReceptionDuplicateOrders(
      {
        branchId: 1,
        phone: "009647701234567",
        lines: [
          { variantId: 1, productUnitId: 1, quantity: "6" },
          { variantId: 1, productUnitId: 1, quantity: "6" },
        ],
        total: "12000",
      },
      actor,
    );
    expect(result.checked).toBe(true);
    expect(result.matches).toHaveLength(3);
    expect(result.matches.map((m) => m.channel).sort()).toEqual([
      "INSTAGRAM",
      "STORE",
      "WHATSAPP",
    ]);
    expect(result.matches.every((m) => m.matchLevel === "EXACT")).toBe(true);
    expect(
      result.matches.find((m) => m.kind === "ONLINE")?.invoice,
    ).toMatchObject({ id: 1, number: "INV-DUP", status: "PENDING" });
    expect(
      (await db().select().from(s.receptionDrafts)).every(
        (d) => d.status === "OPEN",
      ),
    ).toBe(true);
    expect((await db().select().from(s.onlineOrders))[0].status).toBe(
      "PROCESSING",
    );
    expect(await db().select().from(s.inventoryMovements)).toEqual([]);
    expect(await db().select().from(s.accountingEntries)).toEqual([]);
    expect(await db().select().from(s.receipts)).toEqual([]);
  });
  it("enforces branch isolation and validates reference IDs independently of matching phone", async () => {
    await draft(10, { branchId: 2 });
    await online(20, 2);
    const result = await getReceptionDuplicateOrders(
      {
        branchId: 1,
        phone,
        lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }],
        total: "12000",
      },
      actor,
    );
    expect(result.matches).toEqual([]);
    await expect(
      getReceptionDuplicateOrders(
        { branchId: 1, reference: { kind: "DRAFT", id: 10 }, phone },
        actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getReceptionDuplicateOrders(
        { branchId: 1, reference: { kind: "ONLINE", id: 20 } },
        { ...actor, role: "admin" },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getReceptionDuplicateOrders({ branchId: 2, phone }, actor),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("uses stored reference phone/content/total and includes its recorded secondary phone", async () => {
    await draft(10, { customerId: 1, contactPhone: null });
    await draft(11, { contactPhone: "٠٧٨٠١٢٣٤٥٦٧", channel: "INSTAGRAM" });
    const result = await getReceptionDuplicateOrders(
      {
        branchId: 1,
        reference: { kind: "DRAFT", id: 10 },
        phone: "+9647909999999",
        lines: [{ variantId: 2, productUnitId: 3, quantity: "7" }],
        total: "1",
      },
      actor,
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      id: 11,
      matchLevel: "EXACT",
      valueDifference: "0.00",
    });
  });
  it("ignores cancelled/delivered orders and does not rely on equal values or service titles", async () => {
    await draft(10, { status: "CANCELLED" });
    await online(20, 1, { status: "DELIVERED" });
    await draft(11);
    await db()
      .update(s.receptionDraftLines)
      .set({
        lineKind: "PRINT",
        variantId: 3,
        productUnitId: 4,
        title: "طباعة",
      })
      .where(eq(s.receptionDraftLines.draftId, 11));
    expect(
      (
        await getReceptionDuplicateOrders(
          {
            branchId: 1,
            phone,
            lines: [
              {
                lineKind: "PRINT",
                variantId: 3,
                productUnitId: 4,
                quantity: "1",
                title: "طباعة",
              },
            ],
            total: "12000",
          },
          actor,
        )
      ).matches,
    ).toEqual([]);
    expect(
      (
        await getReceptionDuplicateOrders(
          {
            branchId: 1,
            phone,
            lines: [{ variantId: 2, productUnitId: 3, quantity: "1" }],
            total: "12000",
          },
          actor,
        )
      ).matches,
    ).toEqual([]);
  });
  it("excludes draft/source work-order siblings and detects an independent matching work order", async () => {
    await draft(10);
    await db()
      .update(s.receptionDraftLines)
      .set({ lineKind: "CUSTOM", customizationText: "[المقاس] A4\nعمار" })
      .where(eq(s.receptionDraftLines.draftId, 10));
    await db()
      .insert(s.workOrders)
      .values([
        {
          id: 30,
          orderNumber: "WO-SOURCE",
          branchId: 1,
          draftId: 10,
          contactPhone: phone,
          receptionChannel: "WHATSAPP",
          baseVariantId: 1,
          baseProductUnitId: 2,
          baseBaseQuantity: 12,
          baseConsumesInventory: true,
          quantity: 1,
          title: "دفتر",
          customizationText: "[المقاس] A4\nعمار",
          salePrice: "12000",
        },
        {
          id: 31,
          orderNumber: "WO-INDEPENDENT",
          branchId: 1,
          contactPhone: phone,
          receptionChannel: "INSTAGRAM",
          baseVariantId: 1,
          baseProductUnitId: 1,
          baseBaseQuantity: 12,
          baseConsumesInventory: true,
          quantity: 12,
          title: "دفتر",
          customizationText: "[المقاس] A4\nعمار",
          salePrice: "12000",
        },
      ]);
    const result = await getReceptionDuplicateOrders(
      { branchId: 1, reference: { kind: "DRAFT", id: 10 } },
      actor,
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      id: 31,
      kind: "WORK_ORDER",
      matchLevel: "EXACT",
    });
    const live = await getReceptionDuplicateOrders(
      {
        branchId: 1,
        phone,
        excludeDraftId: 10,
        lines: [
          {
            lineKind: "CUSTOM",
            variantId: 1,
            productUnitId: 2,
            quantity: "1",
            customizationText: "[المقاس] A4\nعمار",
          },
        ],
        total: "12000",
      },
      actor,
    );
    expect(live.matches.map((m) => m.id)).toEqual([31]);
  });
  it("rejects a mismatch on phone even when basket and value are identical", async () => {
    await draft(10, { contactPhone: "+9647901234567" });
    expect(
      (
        await getReceptionDuplicateOrders(
          {
            branchId: 1,
            phone,
            lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }],
            total: "12000",
          },
          actor,
        )
      ).matches,
    ).toEqual([]);
  });
  it("uses an existing customer identity hint only after verifying the incoming secondary phone", async () => {
    await online(20);
    const result = await getReceptionDuplicateOrders(
      {
        branchId: 1,
        phone: "٠٧٨٠١٢٣٤٥٦٧",
        customerId: 1,
        lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }],
        total: "12000",
      },
      actor,
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      id: 20,
      kind: "ONLINE",
      matchLevel: "EXACT",
    });
    const spoofed = await getReceptionDuplicateOrders(
      {
        branchId: 1,
        phone: "+9647909999999",
        customerId: 1,
        lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }],
        total: "12000",
      },
      actor,
    );
    expect(spoofed.matches).toEqual([]);
    expect(
      (
        await getReceptionDuplicateOrders(
          {
            branchId: 1,
            phone: "07801234567",
            customerId: 999,
            lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }],
            total: "12000",
          },
          actor,
        )
      ).matches,
    ).toEqual([]);
  });
  it("flags a complete storefront customization matching reception text for employee review", async () => {
    await online(20);
    await db()
      .update(s.onlineOrderItems)
      .set({
        variantId: 3,
        productUnitId: 4,
        quantity: "1",
        baseQuantity: 1,
        customizationSnapshot: {
          templateId: 5,
          kind: "PRINT",
          title: "طباعة",
          unitPriceDelta: "0",
          values: [
            {
              fieldKey: "name",
              label: "الاسم",
              value: "عمار",
              displayValue: "عمار",
            },
            {
              fieldKey: "size",
              label: "المقاس",
              value: "A4",
              displayValue: "A4",
            },
          ],
        },
      })
      .where(eq(s.onlineOrderItems.onlineOrderId, 20));
    const input = {
      branchId: 1,
      phone,
      lines: [
        {
          lineKind: "CUSTOM" as const,
          variantId: 3,
          productUnitId: 4,
          quantity: "1",
          title: "طباعة",
          customizationText: "[المقاس] A4\nعمار",
        },
      ],
      total: "12000",
    };
    expect(
      (await getReceptionDuplicateOrders(input, actor)).matches[0],
    ).toMatchObject({
      id: 20,
      matchLevel: "PARTIAL",
      contentsMatch: false,
      customizationNeedsReview: true,
    });
    expect(
      (
        await getReceptionDuplicateOrders(
          {
            ...input,
            lines: [
              { ...input.lines[0], customizationText: "[المقاس] A3\nعمار" },
            ],
          },
          actor,
        )
      ).matches,
    ).toEqual([]);
  });
  it("includes additional remote work-order channels without changing walk-in cashier behavior", async () => {
    await db()
      .insert(s.workOrders)
      .values(
        (["PHONE", "TIKTOK", "OTHER", "WALK_IN"] as const).map(
          (channel, i) => ({
            id: 30 + i,
            orderNumber: `WO-CHANNEL-${i}`,
            branchId: 1,
            contactPhone: phone,
            receptionChannel: channel,
            baseVariantId: 3,
            baseProductUnitId: 4,
            baseBaseQuantity: 1,
            baseConsumesInventory: false,
            quantity: 1,
            title: "طباعة",
            customizationText: "[المقاس] A4\nعمار",
            salePrice: "12000",
          }),
        ),
      );
    const result = await getReceptionDuplicateOrders(
      {
        branchId: 1,
        phone,
        lines: [
          {
            lineKind: "CUSTOM",
            variantId: 3,
            productUnitId: 4,
            quantity: "1",
            customizationText: "[المقاس] A4\nعمار",
          },
        ],
        total: "12000",
      },
      actor,
    );
    expect(result.matches.map((m) => m.channel).sort()).toEqual([
      "OTHER",
      "PHONE",
      "TIKTOK",
    ]);
    expect(result.truncated).toBe(false);
  });
});
