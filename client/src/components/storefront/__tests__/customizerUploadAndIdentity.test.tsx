// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uploadMutateAsyncMock = vi.fn();

vi.mock("@/lib/trpc", () => ({
  trpc: {
    storefront: {
      uploadCustomizationAsset: {
        useMutation: () => ({
          mutateAsync: uploadMutateAsyncMock,
          isPending: false,
        }),
      },
    },
  },
}));

import { serializeStorefrontCustomizationIdentity } from "@/pages/store/storefrontCustomization";
import {
  buildStorefrontCustomizationPayload,
  createStorefrontCatalogSeedBucket,
  customizationCartKey,
  type StorefrontCustomization,
  type StorefrontCustomizationConfig,
} from "@/components/storefront/storefrontCustomizationModel";
import {
  loadCart,
  saveCart,
  storefrontCheckoutFingerprint,
  DEFAULT_FORM,
} from "@/components/storefront/storefrontPersistence";
import { addStorefrontCartLine, type CartLine } from "@/components/storefront/storefrontCartMath";
import {
  MAX_CUSTOMIZATION_ASSET_BYTES,
  formatCustomizationUploadError,
  isCustomizationUploadBlockingAddToCart,
  stripDataUrlBase64,
  validateCustomizationAssetFile,
  type CustomizationStudioUploadState,
} from "@/components/storefront/storefrontCustomizationUpload";
import { StorefrontCustomizerStudio } from "@/components/storefront/StorefrontCustomizerStudio";
import { StorefrontProductInformation } from "@/components/storefront/StorefrontProductInformation";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const ONE_PIXEL_PNG_DATA_URL = `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`;

describe("Slice 3 — customizer asset upload, cart identity, studio gating, and catalogSeed", () => {
  let container: HTMLDivElement;
  let root: Root;
  const OriginalImage = globalThis.Image;
  const OriginalFileReader = globalThis.FileReader;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    uploadMutateAsyncMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      ONE_PIXEL_PNG_DATA_URL,
    );

    class MockImage {
      width = 100;
      height = 100;
      crossOrigin = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _src = "";
      get src() {
        return this._src;
      }
      set src(val: string) {
        this._src = val;
        queueMicrotask(() => this.onload?.());
      }
    }
    globalThis.Image = MockImage as unknown as typeof Image;

    class MockFileReader {
      result: string | null = null;
      onload: ((ev: { target: { result: string } }) => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(file: Blob) {
        const mime = file.type || "image/png";
        const dataUrl = `data:${mime};base64,${ONE_PIXEL_PNG_BASE64}`;
        this.result = dataUrl;
        queueMicrotask(() => this.onload?.({ target: { result: dataUrl } }));
      }
    }
    globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    globalThis.Image = OriginalImage;
    globalThis.FileReader = OriginalFileReader;
    vi.restoreAllMocks();
  });

  it("strips data URL prefixes to pure base64 and validates MIME and <= 2 MiB limits", () => {
    expect(stripDataUrlBase64(ONE_PIXEL_PNG_DATA_URL)).toBe(ONE_PIXEL_PNG_BASE64);
    expect(stripDataUrlBase64(`  ${ONE_PIXEL_PNG_BASE64} \n`)).toBe(
      ONE_PIXEL_PNG_BASE64,
    );
    expect(stripDataUrlBase64(ONE_PIXEL_PNG_DATA_URL)).not.toContain("data:");

    expect(
      validateCustomizationAssetFile({
        type: "image/png",
        size: 1024,
        name: "logo.png",
      }),
    ).toEqual({ ok: true, mimeType: "image/png" });
    expect(
      validateCustomizationAssetFile({
        type: "image/jpeg",
        size: MAX_CUSTOMIZATION_ASSET_BYTES,
        name: "logo.jpg",
      }),
    ).toEqual({ ok: true, mimeType: "image/jpeg" });
    expect(
      validateCustomizationAssetFile({
        type: "image/webp",
        size: 2048,
        name: "logo.webp",
      }),
    ).toEqual({ ok: true, mimeType: "image/webp" });

    const svgRes = validateCustomizationAssetFile({
      type: "image/svg+xml",
      size: 512,
      name: "vector.svg",
    });
    expect(svgRes.ok).toBe(false);
    if (!svgRes.ok) {
      expect(svgRes.error).toContain("SVG");
    }

    const tooLargeRes = validateCustomizationAssetFile({
      type: "image/png",
      size: MAX_CUSTOMIZATION_ASSET_BYTES + 1,
      name: "huge.png",
    });
    expect(tooLargeRes.ok).toBe(false);
    if (!tooLargeRes.ok) {
      expect(tooLargeRes.error).toContain("2");
    }

    const unavailableMsg = formatCustomizationUploadError({
      data: { code: "SERVICE_UNAVAILABLE", httpStatus: 503 },
      message: "Service Unavailable",
    });
    expect(unavailableMsg).toContain("غير متاحة");
  });

  it("distinguishes different uploaded logos/previews in cart keys, checkout fingerprints, persistence, and undefined-safe payload", () => {
    const plain: StorefrontCustomization = {
      templateId: 10,
      kind: "PRINT",
      values: { text: "شركة الرؤية" },
    };
    // Backward-compatible exact identity when asset keys are absent
    expect(serializeStorefrontCustomizationIdentity(plain)).toBe(
      JSON.stringify({ templateId: 10, values: { text: "شركة الرؤية" } }),
    );

    const withLogoA: StorefrontCustomization = {
      ...plain,
      logoAssetKey: "customizer/t1/logo/aaaa11112222.png",
      previewAssetKey: "customizer/t1/preview/pppp11112222.png",
    };
    const withLogoB: StorefrontCustomization = {
      ...plain,
      logoAssetKey: "customizer/t1/logo/bbbb33334444.png",
      previewAssetKey: "customizer/t1/preview/pppp33334444.png",
    };

    expect(customizationCartKey(55, withLogoA)).not.toBe(
      customizationCartKey(55, withLogoB),
    );

    let cart = new Map<string, CartLine>();
    cart = addStorefrontCartLine(
      cart,
      {
        productUnitId: 55,
        productId: 7,
        productName: "درع تكريم",
        imageUrl: null,
        unitName: "قطعة",
        isCustomizable: true,
        customization: withLogoA,
      },
      "15000",
    );
    cart = addStorefrontCartLine(
      cart,
      {
        productUnitId: 55,
        productId: 7,
        productName: "درع تكريم",
        imageUrl: null,
        unitName: "قطعة",
        isCustomizable: true,
        customization: withLogoB,
      },
      "15000",
    );
    expect(cart.size).toBe(2);

    const fpA = storefrontCheckoutFingerprint(
      new Map([[Array.from(cart.keys())[0]!, Array.from(cart.values())[0]!]]),
      DEFAULT_FORM,
    );
    const fpB = storefrontCheckoutFingerprint(
      new Map([[Array.from(cart.keys())[1]!, Array.from(cart.values())[1]!]]),
      DEFAULT_FORM,
    );
    expect(fpA).not.toBe(fpB);

    // Save & reload cart preserves logoAssetKey and previewAssetKey
    let stored = "";
    saveCart(cart, {
      setItem: (_k, v) => {
        stored = v;
      },
      removeItem: () => {
        stored = "";
      },
    });
    const reloaded = loadCart({ getItem: () => stored });
    expect(reloaded.size).toBe(2);
    const reloadedCustomizations = Array.from(reloaded.values()).map(
      (line) => line.customization,
    );
    expect(reloadedCustomizations[0]?.logoAssetKey).toBe(withLogoA.logoAssetKey);
    expect(reloadedCustomizations[0]?.previewAssetKey).toBe(
      withLogoA.previewAssetKey,
    );
    expect(reloadedCustomizations[1]?.logoAssetKey).toBe(withLogoB.logoAssetKey);

    // Order payload MUST emit undefined (never null) when asset keys are absent
    const plainPayload = buildStorefrontCustomizationPayload(plain);
    expect(plainPayload).toEqual({
      templateId: 10,
      values: { text: "شركة الرؤية" },
      logoAssetKey: undefined,
      previewAssetKey: undefined,
    });
    expect(plainPayload?.logoAssetKey).not.toBeNull();
    expect(plainPayload?.previewAssetKey).not.toBeNull();

    const assetPayload = buildStorefrontCustomizationPayload(withLogoA);
    expect(assetPayload).toEqual({
      templateId: 10,
      values: { text: "شركة الرؤية" },
      logoAssetKey: "customizer/t1/logo/aaaa11112222.png",
      previewAssetKey: "customizer/t1/preview/pppp11112222.png",
    });
  });

  it("gates StorefrontCustomizerStudio on Boolean(customizationConfig) in StorefrontProductInformation", () => {
    const baseProduct = {
      productId: 99,
      productName: "كوب مطبوع",
      brand: null,
      description: "وصف",
      category: "المطبوعات",
      categoryId: 3,
      unitName: "قطعة",
      productUnitId: 901,
      price: "5000",
      salePrice: null,
      promotionName: null,
      inStock: true,
      stockLeft: 10,
      soldCount: 0,
      imageUrl: null,
      imageUrls: [],
      isCustomizable: true,
      customizationKind: "PRINT" as const,
      customizationTemplate: null,
      isBundle: false,
      bundleItems: [],
      variants: [],
      storeUnits: [],
      ratingAverage: "5.0",
      reviewsCount: 0,
    };

    const validConfig: StorefrontCustomizationConfig = {
      id: 12,
      kind: "PRINT",
      title: "خيارات الطباعة",
      description: null,
      fields: [],
    };

    act(() => {
      root.render(
        <StorefrontProductInformation
          product={baseProduct as never}
          setProductReviewOpenRequest={vi.fn()}
          setSelectedId={vi.fn()}
          selectCategory={vi.fn()}
          detailUnit={null}
          variantQuantities={new Map()}
          setSelectedVariantId={vi.fn()}
          setSelectedStoreUnitId={vi.fn()}
          setVariantQuantity={vi.fn()}
          detailVariant={null}
          customizationConfig={null}
          visibleCustomizationFields={[]}
          customizationValues={{}}
          customizationValidation={null}
          updateCustomizationField={vi.fn()}
          detailMedia={{ urls: undefined, fallbackUrl: null }}
        />,
      );
    });
    expect(container.textContent).toContain("إعداد حقول التخصيص غير مكتمل");
    expect(container.textContent).not.toContain(
      "استوديو المعاينة الحية للطباعة والتخصيص",
    );

    act(() => {
      root.render(
        <StorefrontProductInformation
          product={baseProduct as never}
          setProductReviewOpenRequest={vi.fn()}
          setSelectedId={vi.fn()}
          selectCategory={vi.fn()}
          detailUnit={null}
          variantQuantities={new Map()}
          setSelectedVariantId={vi.fn()}
          setSelectedStoreUnitId={vi.fn()}
          setVariantQuantity={vi.fn()}
          detailVariant={null}
          customizationConfig={validConfig}
          visibleCustomizationFields={[]}
          customizationValues={{}}
          customizationValidation={null}
          updateCustomizationField={vi.fn()}
          detailMedia={{ urls: undefined, fallbackUrl: null }}
        />,
      );
    });
    expect(container.textContent).toContain(
      "استوديو المعاينة الحية للطباعة والتخصيص",
    );
  });

  it("uploads LOGO and PREVIEW with pure base64, removes W1-B local-only warning, and handles 503 retry + add-to-cart blocking", async () => {
    const states: CustomizationStudioUploadState[] = [];
    let latestAssets: { logoAssetKey?: string; previewAssetKey?: string } = {};

    act(() => {
      root.render(
        <StorefrontCustomizerStudio
          productName="دفتر جلدي فاخر"
          onUploadStateChange={(state) => states.push(state)}
          onAssetsChange={(assets) => {
            latestAssets = assets;
          }}
        />,
      );
    });

    // Legacy W1-B local-only warning must be gone
    expect(container.textContent).not.toMatch(/الشعار والصورة لا ترسل مع الطلب/);

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    expect(fileInput.getAttribute("accept")).not.toContain("svg");

    // 1. Simulate 503 failure on initial LOGO upload
    uploadMutateAsyncMock.mockRejectedValueOnce({
      data: { code: "SERVICE_UNAVAILABLE", httpStatus: 503 },
      message: "خدمة رفع المرفقات غير متاحة مؤقتاً",
    });

    const pngFile = new File([new Uint8Array([137, 80, 78, 71])], "company-logo.png", {
      type: "image/png",
    });

    await act(async () => {
      Object.defineProperty(fileInput, "files", {
        value: [pngFile],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(uploadMutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(uploadMutateAsyncMock).toHaveBeenNthCalledWith(1, {
      kind: "LOGO",
      mimeType: "image/png",
      dataBase64: ONE_PIXEL_PNG_BASE64,
    });
    expect(states.at(-1)).toBe("error");
    expect(isCustomizationUploadBlockingAddToCart(states.at(-1)!)).toBe(true);
    expect(container.textContent).toContain("غير متاحة");

    // 2. Click Retry -> succeeds LOGO upload
    uploadMutateAsyncMock.mockResolvedValueOnce({
      assetKey: "customizer/t1/logo/company123456.png",
      sha256: "abc",
      mimeType: "image/png",
      byteLength: 68,
    });

    const retryButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("إعادة المحاولة"),
    );
    expect(retryButton).toBeDefined();

    await act(async () => {
      retryButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(uploadMutateAsyncMock).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("uploaded");
    expect(isCustomizationUploadBlockingAddToCart(states.at(-1)!)).toBe(false);
    expect(latestAssets.logoAssetKey).toBe(
      "customizer/t1/logo/company123456.png",
    );

    // 3. Click Apply -> exports canvas PNG and uploads PREVIEW
    uploadMutateAsyncMock.mockResolvedValueOnce({
      assetKey: "customizer/t1/preview/preview987654.png",
      sha256: "def",
      mimeType: "image/png",
      byteLength: 68,
    });

    const applyButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("اعتماد"),
    );
    expect(applyButton).toBeDefined();

    await act(async () => {
      applyButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(uploadMutateAsyncMock).toHaveBeenCalledTimes(3);
    expect(uploadMutateAsyncMock).toHaveBeenNthCalledWith(3, {
      kind: "PREVIEW",
      mimeType: "image/png",
      dataBase64: ONE_PIXEL_PNG_BASE64,
    });
    expect(latestAssets).toEqual({
      logoAssetKey: "customizer/t1/logo/company123456.png",
      previewAssetKey: "customizer/t1/preview/preview987654.png",
    });
    expect(states.at(-1)).toBe("uploaded");
  });

  it("buckets catalogSeed into deterministic 15-minute windows and wires Storefront.tsx cleanly", () => {
    const windowStart = 15 * 60 * 1000 * 2000;
    expect(createStorefrontCatalogSeedBucket(windowStart)).toBe("sf-2000");
    expect(createStorefrontCatalogSeedBucket(windowStart + 14 * 60 * 1000)).toBe(
      "sf-2000",
    );
    expect(createStorefrontCatalogSeedBucket(windowStart + 15 * 60 * 1000)).toBe(
      "sf-2001",
    );

    const storefrontSource = readFileSync(
      path.resolve(process.cwd(), "client/src/pages/Storefront.tsx"),
      "utf8",
    );
    expect(storefrontSource).toContain(
      "Math.floor(Date.now() / (15 * 60 * 1000))",
    );
    expect(storefrontSource).toContain("buildStorefrontCustomizationPayload");
    expect(storefrontSource).toContain("addressText: address");
    expect(storefrontSource).toContain("notes: form.notes.trim() || undefined");
    expect(storefrontSource).not.toContain("\\nملاحظة:");
  });
});
