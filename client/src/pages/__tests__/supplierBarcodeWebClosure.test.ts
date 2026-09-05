import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeBarcodeInput } from "@shared/barcodeNormalize";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("supplier barcode web closure", () => {
  it("يبقي مسافتي Code39 الداخليتين حرفاً بحرف", () => {
    expect(canonicalizeBarcodeInput("\t1  0095\r")).toBe("1  0095");
  });

  it("يربط إدارة صور الاستوديو فعلياً بـHID ويمنع Enter مزدوجاً", () => {
    const code = source("client/src/components/product-studio/StudioStandaloneImageManagerCard.tsx");
    expect(code).toContain("useBarcodeInput((barcode)");
    expect(code).toContain("barcodeInput.handleKeyDown(e, setQuery)");
    expect(code).toContain("if (e.defaultPrevented) return");
  });

  it("يمرّر كاميرا المخزون إلى نفس حلّ الماسح القاطع", () => {
    const code = source("client/src/pages/Inventory.tsx");
    expect(code).toContain("<CameraScanner");
    expect(code).toContain("handleInventoryBarcode(barcode)");
    expect(code).toContain("!cameraOpen");
  });

  it("يوحّد الكشك على hook الماسح ويقبل رمز مورد من محرفين", () => {
    const code = source("client/src/components/kiosk/KioskView.tsx");
    expect(code).toContain("useBarcodeScanner(handleScan, { minLength: 2, thresholdMs: 120 })");
    expect(code).not.toContain("if (buf.s.length >= 3)");
  });

  it("لا يحصر ملصقات المورد في regex ضيق ويطبّع ما يُطبع", () => {
    const code = source("client/src/pages/BarcodeLabels.tsx");
    expect(code).not.toContain("/^[0-9A-Za-z_-]{4,}$/");
    expect(code).toContain("canonicalizeBarcodeInput(q.barcode)");
    expect(code).toContain("canonicalizeBarcodeInput(a.barcode)");
  });

  it("يجرّب باركود مكوّن البكج الأبجدي قبل fallback البحث", () => {
    const code = source("client/src/components/product/BundleForm.tsx");
    const exact = code.indexOf("await lookupByBarcode(v, { quietNotFound: true })");
    const fallback = code.indexOf("const settled = (hasQuery || hasCategory)");
    expect(exact).toBeGreaterThan(0);
    expect(fallback).toBeGreaterThan(exact);
  });

  it("لا تختار واجهتا العدّ أول مادة عند غموض الهوية", () => {
    for (const path of ["client/src/pages/CountPortal.tsx", "client/src/pages/MyStocktakeWorkspace.tsx"]) {
      const code = source(path);
      expect(code).toContain("resolveProductBarcodeItem(items");
      expect(code).toContain('status === "AMBIGUOUS"');
    }
  });

  it("لا يضيف محرر مواد أمر العمل نتيجة بحث قديمة عند Enter أو مسح HID", () => {
    const code = source("client/src/components/workOrders/WorkOrderMaterialsEditor.tsx");
    expect(code).toContain("useBarcodeInput((code)");
    expect(code).toContain("utils.catalog.byBarcode.fetch");
    expect(code).toContain("!posList.isFetching");
    expect(code).toContain("searchRef.current?.value.trim() === code");
  });

  it("يثبت مالك باركود الشراء بدقة قبل جلب التكلفة", () => {
    const code = source("client/src/components/invoice/ProductSearchBar.tsx");
    expect(code).toContain("utils.catalog.byBarcode.fetch");
    expect(code).toContain("utils.catalog.forPurchase.fetch");
    expect(code).toContain("candidate.productUnitId === row.productUnitId");
    expect(code).not.toContain("if (isPurchase) {\n      setQuery(code)");
  });
});
