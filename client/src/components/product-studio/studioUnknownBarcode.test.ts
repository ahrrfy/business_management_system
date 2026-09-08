import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildStudioBarcodeAliasInput,
  canManageStudioBarcodeAliases,
  getProductUnitResolutionState,
  isUnknownStudioBarcodeFailure,
  linkStudioBarcodeAlias,
  shouldSubmitManualBarcode,
} from "./studioUnknownBarcode";

describe("studio unknown barcode closure", () => {
  it("preserves the supplier barcode byte-for-byte when building the alias request", () => {
    expect(buildStudioBarcodeAliasInput(5827, "1  0095")).toEqual({
      productUnitId: 5827,
      barcode: "1  0095",
      note: "رُبط من استوديو المنتجات",
    });
  });

  it("offers linking only for a genuinely unknown catalog barcode", () => {
    expect(
      isUnknownStudioBarcodeFailure(
        "NOT_FOUND",
        "الرمز الممسوح لا يطابق باركود أيّ منتجٍ أو بديلٍ في الكتالوج",
      ),
    ).toBe(true);
    expect(isUnknownStudioBarcodeFailure("CONFLICT", "الرمز يخص أكثر من منتج")).toBe(false);
    expect(isUnknownStudioBarcodeFailure("NOT_FOUND", "المنتج أو وحدته معطّل")).toBe(false);
  });

  it("uses products or productStudio FULL authority for barcode linking", () => {
    expect(canManageStudioBarcodeAliases("manager", null)).toBe(true);
    expect(canManageStudioBarcodeAliases("print_operator", null)).toBe(true);
    expect(canManageStudioBarcodeAliases("manager", { products: "READ", productStudio: "NONE" })).toBe(false);
    expect(canManageStudioBarcodeAliases("user", { products: "FULL" })).toBe(true);
    expect(canManageStudioBarcodeAliases("user", { productStudio: "FULL" })).toBe(true);
    expect(canManageStudioBarcodeAliases("user", { products: "READ", productStudio: "READ" })).toBe(false);
    expect(canManageStudioBarcodeAliases(undefined, { products: "FULL" })).toBe(false);
  });

  it("resolves the explicitly selected variant and unit before writing the exact alias", async () => {
    const resolveProductUnitId = vi.fn().mockResolvedValue(5827);
    const addAlias = vi.fn().mockResolvedValue(undefined);

    await expect(linkStudioBarcodeAlias(
      {
        authorized: true,
        barcode: "1  0095",
        variantId: 46001,
        unitName: "قطعة",
      },
      { resolveProductUnitId, addAlias },
    )).resolves.toBe(5827);

    expect(resolveProductUnitId).toHaveBeenCalledOnce();
    expect(resolveProductUnitId).toHaveBeenCalledWith({ variantId: 46001, unitName: "قطعة" });
    expect(addAlias).toHaveBeenCalledOnce();
    expect(addAlias).toHaveBeenCalledWith({
      productUnitId: 5827,
      barcode: "1  0095",
      note: "رُبط من استوديو المنتجات",
    });
  });

  it("fails closed before any API call without products or productStudio FULL authority", async () => {
    const resolveProductUnitId = vi.fn();
    const addAlias = vi.fn();

    await expect(linkStudioBarcodeAlias(
      { authorized: false, barcode: "1  0095", variantId: 46001, unitName: "قطعة" },
      { resolveProductUnitId, addAlias },
    )).rejects.toThrow("صلاحية تعديل المنتجات أو استوديو المنتجات");
    expect(resolveProductUnitId).not.toHaveBeenCalled();
    expect(addAlias).not.toHaveBeenCalled();
  });

  it("does not guess a unit when the administrator has not selected one", async () => {
    const resolveProductUnitId = vi.fn();
    const addAlias = vi.fn();

    await expect(linkStudioBarcodeAlias(
      { authorized: true, barcode: "1  0095", variantId: 46001, unitName: "" },
      { resolveProductUnitId, addAlias },
    )).rejects.toThrow("اختر المتغيّر والوحدة");
    expect(resolveProductUnitId).not.toHaveBeenCalled();
    expect(addAlias).not.toHaveBeenCalled();
  });

  it("surfaces resolver transport failures and a stale selected unit without writing an alias", async () => {
    const transportFailure = new Error("انقطع الاتصال أثناء تحديد الوحدة");
    const addAliasAfterTransportFailure = vi.fn();
    await expect(linkStudioBarcodeAlias(
      { authorized: true, barcode: "1  0095", variantId: 46001, unitName: "قطعة" },
      {
        resolveProductUnitId: vi.fn().mockRejectedValue(transportFailure),
        addAlias: addAliasAfterTransportFailure,
      },
    )).rejects.toBe(transportFailure);
    expect(addAliasAfterTransportFailure).not.toHaveBeenCalled();

    const addAliasAfterMissingUnit = vi.fn();
    await expect(linkStudioBarcodeAlias(
      { authorized: true, barcode: "1  0095", variantId: 46001, unitName: "قطعة" },
      {
        resolveProductUnitId: vi.fn().mockResolvedValue(null),
        addAlias: addAliasAfterMissingUnit,
      },
    )).rejects.toThrow("تعذّر تحديد الوحدة المختارة");
    expect(addAliasAfterMissingUnit).not.toHaveBeenCalled();
  });

  it("surfaces alias conflicts after resolution without mutating the selected identity", async () => {
    const conflict = new Error("الباركود مرتبط بوحدة أخرى");
    const resolveProductUnitId = vi.fn().mockResolvedValue(5827);
    const addAlias = vi.fn().mockRejectedValue(conflict);

    await expect(linkStudioBarcodeAlias(
      { authorized: true, barcode: "1  0095", variantId: 46001, unitName: "قطعة" },
      { resolveProductUnitId, addAlias },
    )).rejects.toBe(conflict);
    expect(resolveProductUnitId).toHaveBeenCalledWith({ variantId: 46001, unitName: "قطعة" });
    expect(addAlias).toHaveBeenCalledWith(buildStudioBarcodeAliasInput(5827, "1  0095"));
  });

  it("does not submit Enter twice after the scanner hook consumed it", () => {
    expect(shouldSubmitManualBarcode("Enter", false)).toBe(true);
    expect(shouldSubmitManualBarcode("Enter", true)).toBe(false);
    expect(shouldSubmitManualBarcode("Tab", false)).toBe(false);
  });

  it("maps resolver states so transport errors and missing units never remain loading", () => {
    expect(getProductUnitResolutionState({ isLoading: true, isError: false, productUnitId: null })).toBe("loading");
    expect(getProductUnitResolutionState({ isLoading: false, isError: true, productUnitId: null })).toBe("error");
    expect(getProductUnitResolutionState({ isLoading: false, isError: false, productUnitId: null })).toBe("missing");
    expect(getProductUnitResolutionState({ isLoading: false, isError: false, productUnitId: 5827 })).toBe("ready");
  });

  it("keeps the visible code literal and wires the successful link to retry", () => {
    const resolver = readFileSync(new URL("./StudioUnknownBarcodeResolver.tsx", import.meta.url), "utf8");
    const captureStation = readFileSync(new URL("./StudioCaptureStation.tsx", import.meta.url), "utf8");
    const productEdit = readFileSync(new URL("../../pages/ProductEdit.tsx", import.meta.url), "utf8");

    expect(resolver.match(/whitespace-pre-wrap/g)?.length).toBeGreaterThanOrEqual(3);
    expect(resolver).toContain("linkStudioBarcodeAlias(");
    expect(resolver).toContain("await onLinked(barcode)");
    expect(captureStation).toContain("setCode(variables.barcode)");
    expect(captureStation).toContain("shouldSubmitManualBarcode(event.key, event.defaultPrevented)");
    expect(productEdit).toContain('unitResolutionState === "error"');
    expect(productEdit).toContain("void unitIdQ.refetch()");
  });
});
