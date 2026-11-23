import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const mockEligibility = vi.hoisted(() => ({
  assertStockedOwnedMaterials: vi.fn(async () => undefined),
}));

vi.mock("../inventory/materialEligibility", () => ({
  assertStockedOwnedMaterials: mockEligibility.assertStockedOwnedMaterials,
}));

import {
  assertNoUnexpectedRecipeSelections,
  loadLineRecipeSelections,
  resolveRecipeLineSelections,
  type ServiceRecipeLine,
} from "../serviceRecipeConsumption";
import {
  formatRecipeSelectionSummary,
  serializeRecipeSelectionsKey,
  stripRecipeSelectionMeta,
} from "@shared/recipeVariantSelection";
import {
  normalizeSalePayloadForCaptureProof,
  normalizeSaleSemanticContract,
} from "@shared/offlineCaptureProof";
import { pruneRecipeSelections } from "../../../client/src/components/recipe/RecipeVariantSelectorList";
import { buildSaleLine, type CartItem } from "../../../client/src/components/pos/posShared";

function mockTxWithVariants(
  rows: Array<{ id: number; productId: number; variantActive: boolean; productActive: boolean }>,
) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => rows,
        }),
      }),
    }),
  } as never;
}

describe("recipe variant selection helpers & server validator", () => {
  it("normalizes, serializes deterministically, and formats selection summaries", () => {
    const metaSelections = [
      { recipeLineId: 20, variantId: 202, materialName: "ورق", label: "أبيض" },
      { recipeLineId: 10, variantId: 105, materialName: "غلاف", label: "أحمر", colorHex: "#dc2626" },
    ];
    expect(stripRecipeSelectionMeta(metaSelections)).toEqual([
      { recipeLineId: 10, variantId: 105 },
      { recipeLineId: 20, variantId: 202 },
    ]);
    expect(serializeRecipeSelectionsKey(metaSelections)).toBe("10:105,20:202");
    expect(serializeRecipeSelectionsKey([metaSelections[1]!, metaSelections[0]!])).toBe("10:105,20:202");
    expect(formatRecipeSelectionSummary(metaSelections)).toBe("ورق: أبيض · غلاف: أحمر");
  });

  it("keeps offline capture proof backward-compatible when recipeSelections are absent and includes them when present", () => {
    const baseSale = {
      branchId: 1,
      shiftId: 2,
      lines: [
        { variantId: 10, productUnitId: 20, quantity: "1", unitPriceOverride: "1000.00" },
      ],
      payment: { amount: "1000.00", method: "CASH" },
      clientRequestId: "req-12345678",
      capturedAt: "2026-11-23T12:00:00.000Z",
      offlineReceiptNumber: "OFF-1",
    };
    const proofWithout = normalizeSalePayloadForCaptureProof(baseSale) as Record<string, unknown>;
    expect("recipeSelections" in (proofWithout.lines as Array<Record<string, unknown>>)[0]!).toBe(false);

    const proofWith = normalizeSalePayloadForCaptureProof({
      ...baseSale,
      lines: [
        {
          ...baseSale.lines[0]!,
          recipeSelections: [{ recipeLineId: 9, variantId: 55 }],
        },
      ],
    }) as Record<string, unknown>;
    expect((proofWith.lines as Array<Record<string, unknown>>)[0]?.recipeSelections).toEqual([
      { recipeLineId: 9, variantId: 55 },
    ]);

    const semantic = normalizeSaleSemanticContract({
      ...baseSale,
      lines: [{ variantId: 10, productUnitId: 20, quantity: "2", unitPriceOverride: "500.00", recipeSelections: [{ recipeLineId: 3, variantId: 44 }] }],
    });
    expect((semantic.lines as Array<Record<string, unknown>>)[0]?.recipeSelections).toEqual([
      { recipeLineId: 3, variantId: 44 },
    ]);
  });

  it("resolves customizable recipe lines by recipeLineId without colliding on shared material product", async () => {
    const recipeLines: ServiceRecipeLine[] = [
      { id: 1, inputVariantId: 100, qtyPerOutputBase: "1.0000", allowVariantChoice: true },
      { id: 2, inputVariantId: 100, qtyPerOutputBase: "2.0000", allowVariantChoice: true },
      { id: 3, inputVariantId: 300, qtyPerOutputBase: "1.0000", allowVariantChoice: false },
    ];
    const tx = mockTxWithVariants([
      { id: 100, productId: 50, variantActive: true, productActive: true },
      { id: 101, productId: 50, variantActive: true, productActive: true },
      { id: 102, productId: 50, variantActive: true, productActive: true },
    ]);

    const resolved = await resolveRecipeLineSelections(tx, recipeLines, [
      { recipeLineId: 1, variantId: 101 },
      { recipeLineId: 2, variantId: 102 },
    ]);

    expect(resolved).toEqual([
      { recipeLineId: 1, variantId: 101, qtyPerOutputBase: "1.0000" },
      { recipeLineId: 2, variantId: 102, qtyPerOutputBase: "2.0000" },
      { recipeLineId: 3, variantId: 300, qtyPerOutputBase: "1.0000" },
    ]);
    expect(mockEligibility.assertStockedOwnedMaterials).toHaveBeenCalledWith(
      tx,
      [101, 102],
      "متغيّر مادة الوصفة المختار",
    );
  });

  it("fails closed with BAD_REQUEST when allowVariantChoice=true has no selection", async () => {
    const recipeLines: ServiceRecipeLine[] = [
      { id: 11, inputVariantId: 100, qtyPerOutputBase: "1.0000", allowVariantChoice: true },
    ];
    await expect(resolveRecipeLineSelections(mockTxWithVariants([]), recipeLines, []))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects forged cross-product variants with BAD_REQUEST", async () => {
    const recipeLines: ServiceRecipeLine[] = [
      { id: 11, inputVariantId: 100, qtyPerOutputBase: "1.0000", allowVariantChoice: true },
    ];
    const tx = mockTxWithVariants([
      { id: 100, productId: 50, variantActive: true, productActive: true },
      { id: 999, productId: 77, variantActive: true, productActive: true },
    ]);

    let caught: unknown;
    try {
      await resolveRecipeLineSelections(tx, recipeLines, [{ recipeLineId: 11, variantId: 999 }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("BAD_REQUEST");
    expect((caught as TRPCError).message).toContain("لا يتبع مادة الوصفة نفسها");
  });

  it("rejects tampering fixed lines, inactive variants, duplicates, or selections without active recipe", async () => {
    const fixedLine: ServiceRecipeLine[] = [
      { id: 12, inputVariantId: 300, qtyPerOutputBase: "1.0000", allowVariantChoice: false },
    ];
    await expect(
      resolveRecipeLineSelections(mockTxWithVariants([]), fixedLine, [{ recipeLineId: 12, variantId: 301 }]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const choiceLine: ServiceRecipeLine[] = [
      { id: 13, inputVariantId: 100, qtyPerOutputBase: "1.0000", allowVariantChoice: true },
    ];
    await expect(
      resolveRecipeLineSelections(mockTxWithVariants([]), choiceLine, [
        { recipeLineId: 13, variantId: 101 },
        { recipeLineId: 13, variantId: 102 },
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const inactiveTx = mockTxWithVariants([
      { id: 100, productId: 50, variantActive: true, productActive: true },
      { id: 104, productId: 50, variantActive: false, productActive: true },
    ]);
    await expect(
      resolveRecipeLineSelections(inactiveTx, choiceLine, [{ recipeLineId: 13, variantId: 104 }]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(() =>
      assertNoUnexpectedRecipeSelections([{ recipeLineId: 1, variantId: 2 }], "الاختبار"),
    ).toThrow(TRPCError);
  });

  it("loadLineRecipeSelections preserves exact per-line variant assignments even when two customizable lines share one material product", async () => {
    const mockDb = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: async () => [
              {
                variantId: 201,
                materialName: "ورق كانسون",
                variantName: "أبيض",
                color: "أبيض",
                colorHex: "#ffffff",
                size: null,
                variantKind: null,
                sku: "CAN-WHT",
              },
              {
                variantId: 202,
                materialName: "ورق كانسون",
                variantName: "أسود",
                color: "أسود",
                colorHex: "#000000",
                size: null,
                variantKind: null,
                sku: "CAN-BLK",
              },
            ],
          }),
        }),
      }),
    };

    const map = await loadLineRecipeSelections(mockDb as never, [
      // Both lines pick the SAME variant (201) -> previously collapsed to 1 row in invoiceItemServiceMaterials
      {
        id: 1,
        variantId: 90,
        recipeSelections: [
          { recipeLineId: 11, variantId: 201 },
          { recipeLineId: 12, variantId: 201 },
        ],
      },
      // Two lines pick DIFFERENT variants in reverse order -> previously could swap on reopen
      {
        id: 2,
        variantId: 90,
        recipeSelections: [
          { recipeLineId: 11, variantId: 202 },
          { recipeLineId: 12, variantId: 201 },
        ],
      },
    ]);

    expect(map.get(1)?.map((s) => ({ recipeLineId: s.recipeLineId, variantId: s.variantId }))).toEqual([
      { recipeLineId: 11, variantId: 201 },
      { recipeLineId: 12, variantId: 201 },
    ]);
    expect(map.get(2)?.map((s) => ({ recipeLineId: s.recipeLineId, variantId: s.variantId, color: s.color }))).toEqual([
      { recipeLineId: 11, variantId: 202, color: "أسود" },
      { recipeLineId: 12, variantId: 201, color: "أبيض" },
    ]);
  });

  it("pruneRecipeSelections drops obsolete recipeLineIds after recipe edit and buildSaleLine preserves stripped recipeSelections", () => {
    const cleaned = pruneRecipeSelections(
      [
        { recipeLineId: 11, variantId: 201, materialName: "ورق", label: "أبيض" },
        { recipeLineId: 99, variantId: 202, materialName: "قديم", label: "أسود" },
      ],
      [
        {
          recipeLineId: 11,
          options: [{ variantId: 201, label: "أبيض", color: "أبيض", colorHex: "#ffffff", availableBase: 5 }],
        },
        {
          recipeLineId: 12,
          options: [{ variantId: 202, label: "أسود", color: "أسود", colorHex: "#000000", availableBase: 5 }],
        },
      ],
    );
    expect(cleaned).toEqual([
      { recipeLineId: 11, variantId: 201, materialName: "ورق", label: "أبيض" },
    ]);

    const cartItem: CartItem = {
      row: {
        variantId: 500,
        productUnitId: 5000,
        productName: "خدمة طباعة",
        unitName: "قطعة",
        price: "2500",
        isService: true,
      } as CartItem["row"],
      qty: 2,
      customLineId: -1,
      recipeSelections: [
        { recipeLineId: 11, variantId: 201, materialName: "ورق", label: "أبيض", colorHex: "#ffffff" },
      ],
    };
    const built = buildSaleLine(cartItem);
    expect(built.recipeSelections).toEqual([{ recipeLineId: 11, variantId: 201 }]);
  });
});
