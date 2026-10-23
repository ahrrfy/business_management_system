// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  params: {} as { id?: string },
  search: "",
  navigatedTo: null as string | null,
  me: {
    id: 1,
    name: "مدير المبيعات",
    role: "manager",
    branchId: 1,
    isOwner: false,
  } as any,
  editQuotation: undefined as any,
  sourceQuoteRequest: undefined as any,
  posCatalog: [
    {
      productId: 101,
      variantId: 201,
      productUnitId: 301,
      productName: "كتاب IELTS TO SUCCESS",
      variantName: null,
      color: null,
      size: null,
      colorHex: null,
      variantKind: null,
      sku: "BK-IELTS-01",
      barcode: "6281000000301",
      unitName: "قطعة",
      conversionFactor: "1",
      branchId: 1,
      stockBase: 15,
      reservedBase: 2,
      availableBase: 13,
      isService: false,
      isPrintService: false,
      isBundle: false,
      allowBackorder: false,
      price: "6000",
      isContractPrice: false,
      costPriceBase: "4000",
    },
  ],
  stockSnapshotCalls: 0,
  stockPollGeneration: 0,
  extraChunkFetch: vi.fn(
    async (
      { branchId, productUnitIds }: { branchId: number; productUnitIds: number[] },
      _opts?: { staleTime?: number },
    ) => ({
      branchId,
      rows: productUnitIds.map((id) => ({
        branchId,
        productUnitId: id,
        stockBase: 20,
        reservedBase: 0,
        availableBase: 20,
        openedAt: null,
        isService: false,
        allowBackorder: false,
      })),
    }),
  ),
  stockRowsOverride: null as null | ((productUnitIds: number[], branchId: number) => any[]),
  unstableUtils: false,
  pasteItems: null as any[] | null,
  createdPayloads: [] as any[],
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/quotations/new", (to: string) => { mockState.navigatedTo = to; }],
  useSearch: () => mockState.search,
  useParams: () => mockState.params,
  Link: ({ children, href, ...rest }: any) => React.createElement("a", { href, ...rest }, children),
}));

vi.mock("@/hooks/useUnsavedGuard", () => ({
  useUnsavedGuard: vi.fn(),
  bypassUnsavedGuard: vi.fn(),
}));

vi.mock("@/hooks/useBarcodeScanner", () => ({
  useBarcodeScanner: vi.fn(),
}));

vi.mock("@/lib/invoiceTransfer", () => ({
  copyInvoiceItems: vi.fn(),
  hasInvoiceTransfer: () => Boolean(mockState.pasteItems && mockState.pasteItems.length > 0),
  takeInvoiceItems: () => mockState.pasteItems,
}));

vi.mock("@/lib/confirm", () => ({
  confirm: vi.fn(async () => true),
}));

vi.mock("@/lib/notify", () => ({
  notify: {
    ok: vi.fn(),
    err: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    errBig: vi.fn(),
  },
}));

const stableStockByUnitIdsUtil = {
  fetch: (input: { branchId: number; productUnitIds: number[] }, opts?: { staleTime?: number }) =>
    mockState.extraChunkFetch(input, opts),
  invalidate: vi.fn(async () => {}),
};

const stableUtils = {
  catalog: {
    stockByUnitIds: stableStockByUnitIdsUtil,
    byBarcode: { fetch: vi.fn(async () => null) },
    byUnitIds: { fetch: vi.fn(async () => ({ rows: [] })) },
  },
  quotations: {
    list: { invalidate: vi.fn(async () => {}) },
    get: { invalidate: vi.fn(async () => {}) },
  },
  sales: {
    list: { invalidate: vi.fn(async () => {}) },
  },
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () =>
      mockState.unstableUtils
        ? {
            ...stableUtils,
            catalog: {
              ...stableUtils.catalog,
              stockByUnitIds: { ...stableStockByUnitIdsUtil },
            },
          }
        : stableUtils,
    auth: {
      me: {
        useQuery: () => ({ data: mockState.me, isLoading: false }),
      },
    },
    branches: {
      list: {
        useQuery: () => ({
          data: [{ id: 1, name: "الفرع الرئيسي", code: "HQ", isActive: true }],
          isLoading: false,
        }),
      },
    },
    customers: {
      search: {
        useQuery: () => ({ data: [{ id: 10, name: "شركة النور", phone: "07701234567", balance: "0", priceTier: "RETAIL" }], isLoading: false }),
      },
      get: {
        useQuery: () => ({ data: null, isLoading: false }),
      },
    },
    suppliers: {
      search: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
      get: {
        useQuery: () => ({ data: null, isLoading: false }),
      },
    },
    system: {
      getTaxSettings: {
        useQuery: () => ({ data: { enabledByDefault: false, defaultTaxRatePercent: "0" }, isLoading: false }),
      },
    },
    catalog: {
      posList: {
        useQuery: (_input: any, opts?: { enabled?: boolean }) => ({
          data: opts?.enabled === false ? [] : mockState.posCatalog,
          isLoading: false,
          isFetching: false,
        }),
      },
      forPurchase: {
        useQuery: () => ({ data: [], isLoading: false, isFetching: false }),
      },
      stockByUnitIds: {
        useQuery: (input: { branchId: number; productUnitIds: number[] }, opts?: { enabled?: boolean }) => {
          if (opts?.enabled === false || input.productUnitIds.length === 0) {
            return { data: undefined, isLoading: false, isFetching: false };
          }
          mockState.stockSnapshotCalls += 1;
          const rows = mockState.stockRowsOverride
            ? mockState.stockRowsOverride(input.productUnitIds, input.branchId)
            : input.productUnitIds.map((unitId) => ({
                branchId: input.branchId,
                productUnitId: unitId,
                stockBase: 15,
                reservedBase: 2,
                availableBase: 13,
                openedAt: null,
                isService: false,
                allowBackorder: false,
              }));
          // Return a stable snapshot per (branchId + unitIds) just like TanStack Query cache
          const cacheKey = `${input.branchId}:${input.productUnitIds.join(",")}`;
          if (!(stableStockByUnitIdsUtil as any).__cache) {
            (stableStockByUnitIdsUtil as any).__cache = new Map();
          }
          const cache: Map<string, any> = (stableStockByUnitIdsUtil as any).__cache;
          if (!cache.has(cacheKey)) {
            cache.set(cacheKey, { branchId: input.branchId, rows });
          }
          return {
            data: cache.get(cacheKey),
            dataUpdatedAt: 1_700_000_000_000 + mockState.stockPollGeneration * 15_000,
            isLoading: false,
            isFetching: false,
          };
        },
      },
    },
    reservations: {
      activeAllocations: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
    },
    sales: {
      lineInsights: {
        useQuery: () => ({ data: null, isLoading: false, isFetching: false, isPlaceholderData: false }),
      },
    },
    quotations: {
      get: {
        useQuery: (_input: any, opts?: { enabled?: boolean }) => ({
          data: opts?.enabled ? mockState.editQuotation : undefined,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      create: {
        useMutation: (opts?: any) => ({
          isPending: false,
          mutate: (payload: any) => {
            mockState.createdPayloads.push(payload);
            opts?.onSuccess?.({ quotationId: 901 });
          },
        }),
      },
      update: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
      convert: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
    },
    storeAdmin: {
      quoteRequests: {
        prepareOfficialQuotation: {
          useQuery: (_input: any, opts?: { enabled?: boolean }) => ({
            data: opts?.enabled ? mockState.sourceQuoteRequest : undefined,
            isLoading: false,
            isError: false,
          }),
        },
      },
    },
  },
}));

vi.mock("@/sentry", () => ({
  captureClientException: vi.fn(),
}));

import { ErrorBoundary } from "@/components/ErrorBoundary";
import QuotationNew from "@/pages/QuotationNew";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

describe("QuotationNew — إضافة منتج ومزامنة المخزون بدون انهيار", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockState.params = {};
    mockState.search = "";
    mockState.navigatedTo = null;
    mockState.editQuotation = undefined;
    mockState.sourceQuoteRequest = undefined;
    mockState.stockSnapshotCalls = 0;
    mockState.stockPollGeneration = 0;
    mockState.stockRowsOverride = null;
    mockState.unstableUtils = false;
    mockState.me = {
      id: 1,
      name: "مدير المبيعات",
      role: "manager",
      branchId: 1,
      isOwner: false,
    };
    mockState.pasteItems = null;
    mockState.createdPayloads = [];
    mockState.extraChunkFetch.mockClear();
    (stableStockByUnitIdsUtil as any).__cache = new Map();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    queryClient.clear();
    consoleErrorSpy.mockRestore();
  });

  function renderPage() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ErrorBoundary>
            <QuotationNew />
          </ErrorBoundary>
        </QueryClientProvider>,
      );
    });
  }

  function setNativeInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("يضيف المنتج من البحث الموحّد ويطبّق لقطة المخزون دون الدخول في حلقة تصيير لانهائية أو شاشة خطأ", async () => {
    renderPage();
    expect(host.textContent).not.toContain("حدث خطأ غير متوقع");

    const searchInput = host.querySelector<HTMLInputElement>("input[aria-label='بحث المنتجات']");
    expect(searchInput).not.toBeNull();

    await act(async () => {
      setNativeInputValue(searchInput!, "كتاب");
      await new Promise((resolve) => setTimeout(resolve, 210));
    });

    const option = [...host.querySelectorAll("div")].find(
      (el) => el.textContent?.includes("كتاب IELTS TO SUCCESS") && el.getAttribute("class")?.includes("cursor-pointer"),
    );
    expect(option).toBeDefined();

    await act(async () => {
      option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.textContent).not.toContain("حدث خطأ غير متوقع");
    expect(host.textContent).toContain("كتاب IELTS TO SUCCESS");
    expect(mockState.stockSnapshotCalls).toBeLessThan(10);
  });

  it("يفتح مسودة عرض سعر للتعديل مع بنودها ومخزونها الحي دون انهيار", async () => {
    mockState.params = { id: "55" };
    mockState.editQuotation = {
      id: 55,
      status: "DRAFT",
      quoteNumber: "QT-2610-0055",
      quoteDate: "2026-10-23",
      customerId: 10,
      branchId: 1,
      priceTier: "RETAIL",
      validUntil: "2026-11-23",
      notes: "ملاحظة تجريبية",
      discountAmount: "0",
      taxRatePercent: "0",
      items: [
        {
          productId: 101,
          variantId: 201,
          productUnitId: 301,
          productName: "كتاب IELTS TO SUCCESS",
          variantName: null,
          sku: "BK-IELTS-01",
          barcode: null,
          unitName: "قطعة",
          quantity: "2",
          conversionFactor: "1",
          unitPrice: "6000.00",
          referenceUnitPrice: "6000.00",
          priceSource: "TIER",
          costBase: "4000.00",
          discountAmount: "0",
        },
      ],
    };

    renderPage();

    expect(host.textContent).not.toContain("حدث خطأ غير متوقع");
    expect(host.textContent).toContain("تعديل عرض سعر");
    expect(host.textContent).toContain("كتاب IELTS TO SUCCESS");
    expect(mockState.stockSnapshotCalls).toBeLessThan(10);
  });

  it("يحوّل طلب تسعير المتجر إلى مسودة عرض رسمي دون حلقة تصيير لانهائية", async () => {
    mockState.search = "?storeQuoteRequestId=42";
    mockState.sourceQuoteRequest = {
      id: 42,
      requestNumber: "SQR-0042",
      branchId: 1,
      customerId: 10,
      customerPriceTier: "WHOLESALE",
      companyName: "مكتبة الرافدين",
      governorate: "بغداد",
      customerNote: "يرجى التسعير السريع",
      items: [
        {
          isCurrentCatalogLine: true,
          productId: 101,
          variantId: 201,
          productUnitId: 301,
          productName: "كتاب IELTS TO SUCCESS",
          currentVariantName: null,
          variantLabel: null,
          sku: "BK-IELTS-01",
          currentUnitName: "قطعة",
          unitName: "قطعة",
          quantity: 3,
          conversionFactor: "1",
          suggestedUnitPrice: "5500.00",
          suggestedPriceSource: "TIER",
        },
      ],
    };

    renderPage();

    expect(host.textContent).not.toContain("حدث خطأ غير متوقع");
    expect(host.textContent).toContain("عرض رسمي من الطلب SQR-0042");
    expect(host.textContent).toContain("كتاب IELTS TO SUCCESS");
  });

  it("يجلب دفعات المخزون الإضافية (> 500 وحدة) مرة واحدة ولا ينهار لو تعثّرت دفعة إضافية شبكياً", async () => {
    mockState.pasteItems = Array.from({ length: 505 }, (_, idx) => ({
      productId: 1000 + idx,
      variantId: 2000 + idx,
      productUnitId: 3000 + idx,
      name: `صنف دفعي ${idx + 1}`,
      sku: `SKU-${idx + 1}`,
      barcode: null,
      unit: "قطعة",
      qty: 1,
      conversionFactor: "1",
      stockBase: 5,
      isService: idx === 504,
      allowBackorder: idx === 503,
      price: "1000",
      referencePrice: "1000",
      priceSource: "TIER" as const,
      costBase: "500",
      discount: "0",
      discountType: "amount" as const,
      note: "",
    }));
    mockState.extraChunkFetch.mockRejectedValueOnce(new Error("NETWORK_TIMEOUT"));

    renderPage();

    const pasteButton = [...host.querySelectorAll("button")].find((btn) => btn.textContent?.includes("لصق"));
    expect(pasteButton).toBeDefined();

    await act(async () => {
      pasteButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain("حدث خطأ غير متوقع");
    expect(mockState.extraChunkFetch).toHaveBeenCalledTimes(1);
    expect(mockState.extraChunkFetch).toHaveBeenCalledWith(
      {
        branchId: 1,
        productUnitIds: [3500, 3501, 3502, 3503, 3504],
      },
      { staleTime: 0 },
    );
  });

  it("لا يسقط في ErrorBoundary عند كتابة فاصلة عشرية جزئية '.' في سعر البند", async () => {
    mockState.pasteItems = [
      {
        productId: 101,
        variantId: 201,
        productUnitId: 301,
        name: "كتاب IELTS TO SUCCESS",
        sku: "BK-IELTS-01",
        barcode: null,
        unit: "قطعة",
        qty: 1,
        conversionFactor: "1",
        stockBase: 15,
        price: ".",
        referencePrice: "6000",
        priceSource: "MANUAL" as const,
        costBase: "4000",
        discount: "0",
        discountType: "amount" as const,
        note: "",
      },
    ];

    renderPage();

    const pasteButton = [...host.querySelectorAll("button")].find((btn) => btn.textContent?.includes("لصق"));
    expect(pasteButton).toBeDefined();

    await act(async () => {
      pasteButton!.click();
    });

    expect(host.textContent).not.toContain("حدث خطأ غير متوقع");
    expect(host.textContent).toContain("هناك بنود بسعر غير صالح");
  });

  it("يجلب الدفعة الثانية (> 500 وحدة) بنجاح لمرّة واحدة فقط دون حلقة غير متزامنة حتى لو تغيّر مرجع useUtils", async () => {
    mockState.unstableUtils = true;
    mockState.pasteItems = Array.from({ length: 505 }, (_, idx) => ({
      productId: 1000 + idx,
      variantId: 2000 + idx,
      productUnitId: 3000 + idx,
      name: `صنف كبير ${idx + 1}`,
      sku: `SKU-BIG-${idx + 1}`,
      barcode: null,
      unit: "قطعة",
      qty: 1,
      conversionFactor: "1",
      stockBase: 0,
      price: "1000",
      referencePrice: "1000",
      priceSource: "TIER" as const,
      costBase: "500",
      discount: "0",
      discountType: "amount" as const,
      note: "",
    }));

    renderPage();

    const pasteButton = [...host.querySelectorAll("button")].find((btn) => btn.textContent?.includes("لصق"));
    expect(pasteButton).toBeDefined();

    await act(async () => {
      pasteButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(host.textContent).not.toContain("حدث خطأ غير متوقع");
    expect(mockState.extraChunkFetch).toHaveBeenCalledTimes(1);
  });

  it("يحترم صلاحية catalog.stockByUnitIds فلا يطلق استعلام المخزون لمستخدم منزوع الصلاحية", async () => {
    mockState.me = {
      id: 9,
      name: "موظف عروض فقط",
      role: "cashier",
      branchId: 1,
      isOwner: false,
      operationPolicyEnabled: true,
      roleOperationPolicy: { version: 1, grants: {} },
      operationPolicy: {
        version: 1,
        grants: {
          "operation.quotations.create": true,
        },
      },
    };
    mockState.pasteItems = [
      {
        productId: 101,
        variantId: 201,
        productUnitId: 301,
        name: "كتاب IELTS TO SUCCESS",
        sku: "BK-IELTS-01",
        barcode: null,
        unit: "قطعة",
        qty: 1,
        conversionFactor: "1",
        stockBase: 15,
        price: "6000",
        referencePrice: "6000",
        priceSource: "TIER" as const,
        costBase: "4000",
        discount: "0",
        discountType: "amount" as const,
        note: "",
      },
    ];

    renderPage();

    const pasteButton = [...host.querySelectorAll("button")].find((btn) => btn.textContent?.includes("لصق"));
    await act(async () => {
      pasteButton!.click();
    });

    expect(host.textContent).not.toContain("حدث خطأ غير متوقع");
    expect(host.textContent).toContain("كتاب IELTS TO SUCCESS");
    expect(mockState.stockSnapshotCalls).toBe(0);
  });

  it("يمنع حفظ عرض سعر مجاني صامت (unitPriceOverride: '0.00') عند كتابة '.' ثم النقر على زر الحفظ (blur -> '')", async () => {
    mockState.search = "?storeQuoteRequestId=55";
    mockState.sourceQuoteRequest = {
      id: 55,
      requestNumber: "SQR-0055",
      branchId: 1,
      customerId: 10,
      customerPriceTier: "RETAIL",
      companyName: "شركة النور",
      governorate: "بغداد",
      customerNote: "",
      items: [
        {
          isCurrentCatalogLine: true,
          productId: 101,
          variantId: 201,
          productUnitId: 301,
          productName: "كتاب IELTS TO SUCCESS",
          currentVariantName: null,
          variantLabel: null,
          sku: "BK-IELTS-01",
          currentUnitName: "قطعة",
          unitName: "قطعة",
          quantity: 1,
          conversionFactor: "1",
          suggestedUnitPrice: "6000",
          suggestedPriceSource: "TIER",
        },
      ],
    };

    renderPage();

    // اعثر على حقل سعر الوحدة (MoneyInput بقيمة 6,000) وحاكِ كتابة '.' ثم blur قبل نقرة الحفظ
    const priceInput = [...host.querySelectorAll("input")].find(
      (inp) => inp.value === "6,000" || inp.value === "6000",
    );
    expect(priceInput).toBeDefined();

    await act(async () => {
      priceInput!.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(priceInput!, ".");
      priceInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      // في المتصفح يقع blur قبل click عند النقر على زر الحفظ، فيحوّل MoneyInput القيمة '.' إلى ''
      priceInput!.blur();
      priceInput!.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });

    const saveButton = [...host.querySelectorAll("button")].find((btn) =>
      btn.textContent?.includes("حفظ"),
    );
    expect(saveButton).toBeDefined();

    await act(async () => {
      saveButton!.click();
    });

    expect(mockState.createdPayloads).toHaveLength(0);
  });

  it("لا يطلق catalog.stockByUnitIds بمعرّف فرع 0 أو وحدة 0، ويمسح أرصدة الفرع القديم عند اللصق", async () => {
    mockState.me = {
      id: 1,
      name: "المالك",
      role: "admin",
      branchId: null,
      isOwner: true,
      operationPolicyEnabled: true,
      roleOperationPolicy: { version: 1, grants: {} },
      operationPolicy: {
        version: 1,
        grants: {
          "operation.quotations.create": true,
        },
      },
    };
    mockState.pasteItems = [
      {
        productId: 101,
        variantId: 201,
        productUnitId: 0,
        name: "بند قديم بلا وحدة",
        sku: "LEGACY-0",
        barcode: null,
        unit: "قطعة",
        qty: 1,
        conversionFactor: "1",
        stockBase: 99,
        stockBranchId: 2,
        availableBase: 99,
        reservedBase: 0,
        price: "6000",
        referencePrice: "6000",
        priceSource: "TIER" as const,
        costBase: "4000",
        discount: "0",
        discountType: "amount" as const,
        note: "",
      },
    ];

    renderPage();

    const pasteButton = [...host.querySelectorAll("button")].find((btn) => btn.textContent?.includes("لصق"));
    await act(async () => {
      pasteButton!.click();
    });

    expect(mockState.stockSnapshotCalls).toBe(0);
    // يجب مسح رصيد الفرع المصدر المنسوخ (99) وعدم عرضه كحقيقة مؤكدة
    expect(host.textContent).not.toContain("متوفر: 99");
  });

  it("يعيد محاولة جلب الدفعة الثانية (> 500 وحدة) عند النبضة الدورية التالية (dataUpdatedAt) حتى لو لم يتغير مرجع أول 500 صنف", async () => {
    mockState.pasteItems = Array.from({ length: 505 }, (_, idx) => ({
      productId: 1000 + idx,
      variantId: 2000 + idx,
      productUnitId: 3000 + idx,
      name: `صنف نبضي ${idx + 1}`,
      sku: `SKU-POLL-${idx + 1}`,
      barcode: null,
      unit: "قطعة",
      qty: 1,
      conversionFactor: "1",
      stockBase: 0,
      price: "1000",
      referencePrice: "1000",
      priceSource: "TIER" as const,
      costBase: "500",
      discount: "0",
      discountType: "amount" as const,
      note: "",
    }));
    mockState.extraChunkFetch.mockRejectedValueOnce(new Error("TRANSIENT_ERR"));

    renderPage();

    const pasteButton = [...host.querySelectorAll("button")].find((btn) => btn.textContent?.includes("لصق"));
    await act(async () => {
      pasteButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(mockState.extraChunkFetch).toHaveBeenCalledTimes(1);

    // محاكاة نبضة 15 ثانية تعيد نفس كائن data لأول 500 صنف مع تحديث dataUpdatedAt
    mockState.stockPollGeneration += 1;
    renderPage();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(mockState.extraChunkFetch).toHaveBeenCalledTimes(2);
    expect(mockState.extraChunkFetch).toHaveBeenLastCalledWith(
      {
        branchId: 1,
        productUnitIds: [3500, 3501, 3502, 3503, 3504],
      },
      { staleTime: 0 },
    );
  });
});
