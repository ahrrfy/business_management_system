import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PurchaseOrderDrilldownView } from "@/components/financial/drilldown/PurchaseOrderDrilldownView";
import { printSupplierStmt } from "@/lib/printing/printTemplates";
import { buildPurchaseInvoiceV2Html } from "@/lib/printing/printTemplatesV2";
import {
  getPurchaseSettlement,
  type PurchaseSettlementEvidence,
} from "@shared/purchaseSettlement";

const state = vi.hoisted(() => ({
  order: {} as Record<string, unknown>,
  print: vi.fn((_html: string) => true),
  cashSourcesInputs: [] as unknown[],
  cashSourcesResult: {
    data: undefined as
      | {
          drawers: Array<{ id: number; shiftType: string }>;
          canUseTreasury: boolean;
        }
      | undefined,
    isLoading: false,
    isError: false,
  },
  paymentSourcesInputs: [] as unknown[],
  paymentSourcesResult: {
    data: undefined as
      | {
          rows: Array<{
            id: number;
            invoiceNumber: string;
            currency: string;
            remainingAmount: string;
            pendingAmount: string;
          }>;
        }
      | undefined,
    isLoading: false,
  },
  search: "",
  inferredBranchId: null as number | null,
  voucher: null as Record<string, unknown> | null,
  pendingControlRows: [] as Array<Record<string, unknown>>,
}));

function makeTrpcProxy(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      const next = [...path, prop];
      const joined = next.join(".");
      if (joined === "useUtils") {
        return () => makeTrpcProxy(["utils"]);
      }
      if (path[0] === "utils" && prop === "invalidate") {
        return vi.fn(async () => undefined);
      }
      if (joined === "purchases.get.useQuery") {
        return () => ({ data: state.order, isLoading: false });
      }
      if (joined === "vouchers.get.useQuery") {
        return () => ({
          data: state.voucher,
          isLoading: false,
          isError: false,
        });
      }
      if (joined === "purchases.pendingControls.useInfiniteQuery") {
        return () => ({
          data: {
            pages: [{ rows: state.pendingControlRows, nextCursor: null }],
          },
          isLoading: false,
          isFetching: false,
          error: null,
          hasNextPage: false,
          refetch: vi.fn(),
          fetchNextPage: vi.fn(),
        });
      }
      if (joined === "auth.me.useQuery") {
        return () => ({
          data: { id: 1, role: "admin", isOwner: true },
          isLoading: false,
        });
      }
      if (joined === "supplierPayments.cashSources.useQuery") {
        return (input: unknown) => {
          state.cashSourcesInputs.push(input);
          return state.cashSourcesResult;
        };
      }
      if (joined === "supplierPayments.paymentSources.useQuery") {
        return (input: unknown) => {
          state.paymentSourcesInputs.push(input);
          return state.paymentSourcesResult;
        };
      }
      if (prop === "useQuery") {
        return () => ({
          data: undefined,
          isLoading: false,
          isFetching: false,
        });
      }
      if (prop === "useMutation") {
        return () => ({
          mutate: vi.fn(),
          mutateAsync: vi.fn(),
          isPending: false,
        });
      }
      return makeTrpcProxy(next);
    },
  });
}

vi.mock("@/lib/trpc", () => ({
  trpc: makeTrpcProxy(),
}));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href?: string }) =>
    React.createElement("a", { href }, children),
  useLocation: () => ["/vouchers/payment/new", vi.fn()],
  useParams: () => ({ id: "262" }),
  useSearch: () => state.search,
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({
    children,
    value,
    onValueChange,
    ...rest
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
  }) =>
    React.createElement(
      "select",
      {
        value,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
          onValueChange?.(e.target.value),
        "data-selected-value": value,
        ...rest,
      },
      children,
    ),
}));
vi.mock("@/components/data-table/DataTable", () => ({
  DataTable: ({ emptyText }: { emptyText?: string }) =>
    React.createElement("div", { "data-mock-table": emptyText ?? "" }),
  DataTableColumnHeader: ({ title }: { title?: string }) =>
    React.createElement("span", null, title ?? ""),
}));
vi.mock("@/components/ui/sheet", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
  return {
    Sheet: Pass,
    SheetContent: Pass,
    SheetHeader: Pass,
    SheetTitle: Pass,
  };
});
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({
    children,
    open,
  }: {
    children?: React.ReactNode;
    open?: boolean;
  }) => (open === false ? null : React.createElement("div", null, children));
  return {
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    useDialogComposition: () => ({
      isComposing: () => false,
      setComposing: () => undefined,
      justEndedComposing: () => false,
      markCompositionEnd: () => undefined,
    }),
  };
});
vi.mock("@/components/ui/tabs", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
  return {
    Tabs: Pass,
    TabsContent: Pass,
    TabsList: Pass,
    TabsTrigger: Pass,
  };
});
vi.mock("@/components/purchases/PurchaseOrderGovernance", () => ({
  PurchaseOrderGovernance: () => null,
}));
vi.mock("@/components/purchases/QuickSupplierPaymentDialog", () => ({
  QuickSupplierPaymentDialog: () => null,
}));
vi.mock("@/components/purchases/PurchaseShippingRefund", () => ({
  PurchaseShippingRefund: () => null,
}));
vi.mock("@/components/invoice", () => ({
  INVOICE_TYPES: { PURCHASE: { label: "أمر شراء", icon: () => null } },
  splitDocumentNotes: (v?: string | null) => ({
    customerNotes: v ?? "",
    internalNotes: "",
  }),
}));
vi.mock("@/hooks/useSessionContext", () => ({
  useSessionContext: () => ({
    context: { businessDay: "2026-10-24" },
  }),
}));
vi.mock("@/hooks/useUnsavedGuard", () => ({
  useUnsavedGuard: () => undefined,
  bypassUnsavedGuard: () => undefined,
}));
vi.mock("@/hooks/usePrintAudit", () => ({
  usePrintAudit: () => ({ recordPrint: vi.fn() }),
}));
vi.mock("@/components/form/InferredField", () => ({
  InferredBranchField: ({
    value,
  }: {
    value: number | null;
    onChange: (id: number | null) => void;
  }) =>
    React.createElement("div", {
      "data-inferred-branch": String(value ?? ""),
    }),
}));
vi.mock("@/components/form/ImageUploader", () => ({
  ImageUploader: () => null,
}));
vi.mock("@/components/CustomerPicker", () => ({
  default: ({ customerId }: { customerId: number | null }) =>
    React.createElement("div", {
      "data-customer-picker": String(customerId ?? ""),
    }),
}));
vi.mock("@/components/voucher/SupplierPicker", () => ({
  default: ({ supplierId }: { supplierId: number | null }) =>
    React.createElement("div", {
      "data-supplier-picker": String(supplierId ?? ""),
    }),
}));
vi.mock("@/components/voucher/DeliveryPartyPicker", () => ({
  default: () => null,
}));
vi.mock("@/lib/printing/brand", async (original) => ({
  ...(await original<typeof import("@/lib/printing/brand")>()),
  openPrintWindow: state.print,
}));

function evidence(
  paid: string,
  returned: string,
  remaining: string,
  status: PurchaseSettlementEvidence["status"],
  requiresReview = false,
): PurchaseSettlementEvidence {
  return {
    paidAmountIqd: paid,
    paidAmountCurrency: paid,
    returnedAmountIqd: returned,
    returnedAmountCurrency: returned,
    remainingAmountIqd: remaining,
    remainingAmountCurrency: remaining,
    status,
    requiresReview,
  };
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  state.print.mockClear();
  state.cashSourcesInputs = [];
  state.cashSourcesResult = {
    data: undefined,
    isLoading: false,
    isError: false,
  };
  state.paymentSourcesInputs = [];
  state.paymentSourcesResult = {
    data: undefined,
    isLoading: false,
  };
  state.search = "";
  state.inferredBranchId = null;
  state.voucher = null;
  state.pendingControlRows = [];
  state.order = {
    id: 262,
    poNumber: "PO262",
    supplierName: "مورد تجريبي",
    orderDate: "2026-10-13",
    total: "240000.00",
    paidAmount: "0.00",
    linkedCashPaidAmount: "0.00",
    settlementType: "CASH",
    agreedCurrency: "IQD",
    items: [],
  };
});
afterEach(() => vi.unstubAllGlobals());

describe("عرض سداد الشراء المثبت", () => {
  const render = () =>
    renderToStaticMarkup(
      React.createElement(PurchaseOrderDrilldownView, { poId: 262 }),
    );

  it.each([
    ["IQD", "60,000", "120,000"],
    ["USD", "40", "80"],
  ])(
    "يعرض سعر وإجمالي البنود من حقول الخادم بعملة %s",
    (currency, price, total) => {
      state.order.agreedCurrency = currency;
      state.order.items = [
        {
          id: 1,
          productName: "حبر",
          quantity: "2",
          unitPrice: "60000.00",
          total: "120000.00",
          usdUnitPrice: "40.00",
          usdTotal: "80.00",
        },
      ];
      const html = render();
      expect(html).toMatch(new RegExp(`dir="ltr">${price}</span>`));
      expect(html).toMatch(new RegExp(`dir="ltr">${total}</span>`));
    },
  );

  it("يعرض شراء نقدياً غير مسدد دون تحويل طريقة السداد إلى إثبات دفع", () => {
    state.order.settlement = evidence("0.00", "0.00", "240000.00", "UNPAID");
    const html = render();
    expect(html).toContain("نقدي (طريقة السداد)");
    expect(html).toContain("غير مسددة");
    expect(html).toContain("240,000");
    expect(html).not.toContain("مسددة بالكامل");
  });

  it("يقدم تخصيص السداد المعتمد على حقل أمر شراء قديم متناقض", () => {
    state.order.paidAmount = "240000.00";
    state.order.settlement = evidence(
      "60000.00",
      "0.00",
      "180000.00",
      "PARTIAL",
    );
    const html = render();
    expect(html).toContain("مسددة جزئياً");
    expect(html).toContain("60,000");
    expect(html).toContain("180,000");
    expect(html).not.toContain("مسددة بالكامل");
  });

  it("يعرض تخفيض الذمة كإقفال مستقل عن السداد النقدي", () => {
    state.order.settlement = evidence("0.00", "240000.00", "0.00", "CREDITED");
    const html = render();
    expect(html).toContain("مقفلة بتخفيض الذمة");
    expect(html).not.toContain("مسددة بالكامل");
  });

  it("يكشف ضرورة المطابقة قبل دفعة جديدة", () => {
    state.order.settlement = evidence(
      "0.00",
      "0.00",
      "240000.00",
      "UNPAID",
      true,
    );
    expect(render()).toContain("دليل السداد يحتاج مراجعة قبل طلب دفعة جديدة");
    expect(render()).toContain("بحاجة إلى مطابقة السداد");
  });

  it("يطبع كشف المورد بنفس حالة السداد والمبالغ المستعملة في الشاشة", () => {
    const settlement = getPurchaseSettlement({
      ...state.order,
      settlement: evidence("60000.00", "0.00", "180000.00", "PARTIAL"),
    });
    printSupplierStmt({
      supplierName: "مورد تجريبي",
      transactions: [
        {
          date: "13/10/2026",
          ref: "PO262",
          description: `فاتورة شراء · ${settlement.intentLabel}`,
          credit: "240000.00",
          balance: "180000.00",
          paymentStatusLabel: settlement.statusLabel,
          paidAmount: settlement.paidAmount,
          returnedAmount: settlement.returnedAmount,
          remainingAmount: settlement.remainingAmount,
        },
      ],
      totalDebit: "60000.00",
      totalCredit: "240000.00",
      closingBalance: "180000.00",
    });
    const html = state.print.mock.calls[0]?.[0];
    expect(html).toContain("نقدي (طريقة السداد)");
    expect(html).toContain("حالة السداد: مسددة جزئياً");
    expect(html).toContain("المدفوع: 60,000 د.ع");
    expect(html).toContain("المتبقي: 180,000 د.ع");
  });

  it("يشرح تخفيض ذمة الشراء في النسخة المطبوعة دون إثبات صرف", () => {
    const html = buildPurchaseInvoiceV2Html({
      invoiceNumber: "PO262",
      statusLabel: "نقدي (طريقة السداد) · مقفلة بتخفيض الذمة",
      items: [],
      subtotal: "240000.00",
      total: "240000.00",
      paidAmount: "0.00",
      remainingAmount: "0.00",
      returnedAmount: "240000.00",
    });
    expect(html).toContain("مقفلة بتخفيض الذمة");
    expect(html).toContain("تخفيض الذمة بعد الشراء: 240,000");
    expect(html).not.toContain("مسددة بالكامل");
  });

  it("يطبع كشف المورد الديناري بسداد الدولار المترجم إلى الدينار", () => {
    const settlement = getPurchaseSettlement({
      agreedCurrency: "IQD",
      total: "15000",
      paidAmount: "0",
      settlement: {
        paidAmountIqd: "6000.00",
        returnedAmountIqd: "0.00",
        remainingAmountIqd: "9000.00",
        paidAmountCurrency: "4.00",
        returnedAmountCurrency: "0.00",
        remainingAmountCurrency: "6.00",
        status: "PARTIAL",
        requiresReview: false,
      },
    });
    printSupplierStmt({
      supplierName: "مورد بالدولار",
      transactions: [
        {
          date: "13/10/2026",
          ref: "USD-PO",
          description: "شراء بالدولار",
          credit: "15000",
          balance: "9000",
          paidAmount: settlement.paidAmount,
          remainingAmount: settlement.remainingAmount,
        },
      ],
      totalDebit: "6000",
      totalCredit: "15000",
      closingBalance: "9000",
    });
    const html = state.print.mock.calls[0]?.[0];
    expect(html).toContain("المدفوع: 6,000 د.ع");
    expect(html).toContain("المتبقي: 9,000 د.ع");
    expect(html).not.toContain("المدفوع: 4 د.ع");
  });

  it("يرسل undefined في الوضع التلقائي لمصدر نقد الفاتورة النقدية فلا يصطدم المعتمد المستقل بدرجه الشخصي", async () => {
    const { buildPurchaseCashSourcePayload } =
      await import("@/components/purchases/PurchaseCashSourceField");
    expect(buildPurchaseCashSourcePayload("AUTO", "99")).toBeUndefined();
    expect(buildPurchaseCashSourcePayload("TREASURY", "99")).toEqual({
      mode: "TREASURY",
    });
    expect(buildPurchaseCashSourcePayload("DRAWER", "50")).toEqual({
      mode: "DRAWER",
      shiftId: 50,
    });
  });

  it("يتخطى استعلام مصادر نقد الفاتورة عبر skipToken عند غياب الفرع او تعطيل النقد دون افتراض فرع صامت ولا يظهر تحذير وردية كاذب قبل التحقق", async () => {
    const { skipToken } = await import("@tanstack/react-query");
    const { PurchaseCashSourceField, usePurchaseCashSourceState } =
      await import("@/components/purchases/PurchaseCashSourceField");

    function Probe(props: {
      branchId: number | null | undefined;
      enabled: boolean;
    }) {
      const s = usePurchaseCashSourceState({
        branchId: props.branchId,
        enabled: props.enabled,
        context: "create",
      });
      return React.createElement(PurchaseCashSourceField, {
        idPrefix: "probe",
        context: "create",
        state: s,
      });
    }

    for (const badBranch of [null, undefined, 0, -1, Number.NaN, 1.5]) {
      const html = renderToStaticMarkup(
        React.createElement(Probe, { branchId: badBranch, enabled: true }),
      );
      expect(html).not.toContain("لا توجد وردية مفتوحة باسمك حاليا");
    }
    renderToStaticMarkup(
      React.createElement(Probe, { branchId: 2, enabled: false }),
    );

    state.cashSourcesResult = {
      data: { drawers: [], canUseTreasury: false },
      isLoading: false,
      isError: false,
    };
    const resolvedHtml = renderToStaticMarkup(
      React.createElement(Probe, { branchId: 2, enabled: true }),
    );
    expect(resolvedHtml).toContain("لا توجد وردية مفتوحة باسمك حاليا");

    expect(state.cashSourcesInputs).toEqual([
      skipToken,
      skipToken,
      skipToken,
      skipToken,
      skipToken,
      skipToken,
      skipToken,
      { branchId: 2 },
    ]);
  });

  it("يعزل shiftId بين الفروع ويحجب وضع الدرج او الخزينة عند غياب الفرع او عدم جاهزية الاستعلام", async () => {
    const { derivePurchaseCashSourceDecision } =
      await import("@/components/purchases/PurchaseCashSourceField");

    // غياب الفرع (skipToken نشط) مع بقاء shiftId قديم من فرع سابق: لا يتسرب shiftId ولا يمر الحفظ.
    const missingBranch = derivePurchaseCashSourceDecision({
      normalizedBranchId: null,
      enabled: true,
      context: "create",
      isCreator: true,
      mode: "DRAWER",
      shiftId: "10",
      data: undefined,
      isLoading: false,
    });
    expect(missingBranch.validShiftId).toBe("");
    expect(missingBranch.isActionBlocked).toBe(true);
    expect(missingBranch.validationError).toContain("حدد الفرع اولا");
    expect(missingBranch.payload).toBeUndefined();

    // انتقال لفرع ثان بدرج مختلف (#25) قبل تحديث الحالة من #10: يرفض تسريب #10 للفرع الجديد.
    const switchedBranch = derivePurchaseCashSourceDecision({
      normalizedBranchId: 2,
      enabled: true,
      context: "create",
      isCreator: true,
      mode: "DRAWER",
      shiftId: "10",
      data: {
        drawers: [{ id: 25, shiftType: "MORNING" }],
        canUseTreasury: false,
      },
      isLoading: false,
    });
    expect(switchedBranch.validShiftId).toBe("");
    expect(switchedBranch.isActionBlocked).toBe(true);
    expect(switchedBranch.payload).toBeUndefined();

    // بعد اختيار درج الفرع الحالي (#25): يمر بسلام بالمعرف الصحيح.
    const validBranchDrawer = derivePurchaseCashSourceDecision({
      normalizedBranchId: 2,
      enabled: true,
      context: "create",
      isCreator: true,
      mode: "DRAWER",
      shiftId: "25",
      data: {
        drawers: [{ id: 25, shiftType: "MORNING" }],
        canUseTreasury: false,
      },
      isLoading: false,
    });
    expect(validBranchDrawer.validShiftId).toBe("25");
    expect(validBranchDrawer.validationError).toBeNull();
    expect(validBranchDrawer.isActionBlocked).toBe(false);
    expect(validBranchDrawer.payload).toEqual({ mode: "DRAWER", shiftId: 25 });
  });

  it("يرسم تنبيه الفاتورة النقدية المستلمة غير المسددة في PurchaseDetailDrawer بمتغير --sem-danger-bg المعرف", async () => {
    const { PurchaseDetailDrawer } =
      await import("@/components/purchases/PurchaseDetailDrawer");
    state.order = {
      ...state.order,
      status: "RECEIVED",
      branchId: 2,
      settlement: evidence("0.00", "0.00", "240000.00", "UNPAID"),
    };
    const html = renderToStaticMarkup(
      React.createElement(PurchaseDetailDrawer, {
        purchaseOrderId: 262,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain(
      "تنبيه حرج: هذه فاتورة شراء نقدية مستلمة تاريخيا ولم تسو ذمتها بعد",
    );
    expect(html).toContain("bg-[var(--sem-danger-bg)]");
    expect(html).not.toContain("--sem-danger-soft");
  });

  it("يهيئ سند صرف المورد من معاملات الرابط ويعرض اشعار تسوية ذمة المورد عند اختيار المورد", async () => {
    const { default: VoucherFormShared } =
      await import("@/components/vouchers/VoucherFormShared");

    state.search = "?partyType=SUPPLIER&partyId=15";
    const html = renderToStaticMarkup(
      React.createElement(VoucherFormShared, { voucherType: "PAYMENT" }),
    );
    expect(html).toContain('data-selected-value="SUPPLIER"');
    expect(html).toContain('data-supplier-picker="15"');
    expect(html).toContain(
      "عند اعتماد سند الصرف وتنفيذه، ينخفض رصيد ذمة المورد بقيمة السند",
    );
  });

  it("يعرض بطاقة سياسة تسوية المورد بوضوح للنقدي الديناري والدولاري والآجل", async () => {
    const { PurchaseSettlementPolicyCard, usePurchaseCashSourceState } =
      await import("@/components/purchases/PurchaseCashSourceField");

    state.cashSourcesResult = {
      data: {
        drawers: [{ id: 12, shiftType: "MORNING" }],
        canUseTreasury: true,
      },
      isLoading: false,
      isError: false,
    };

    function PolicyProbe(props: { paymentTerms: string; currency: string }) {
      const cashState = usePurchaseCashSourceState({
        branchId: 2,
        enabled: props.paymentTerms === "CASH" && props.currency === "IQD",
        context: "create",
        isCreator: true,
      });
      return React.createElement(PurchaseSettlementPolicyCard, {
        idPrefix: "policy-probe",
        context: "create",
        paymentTerms: props.paymentTerms,
        currency: props.currency,
        cashSourceState: cashState,
      });
    }

    const cashIqdHtml = renderToStaticMarkup(
      React.createElement(PolicyProbe, {
        paymentTerms: "CASH",
        currency: "IQD",
      }),
    );
    expect(cashIqdHtml).toContain(
      "صافي الذمة المتبقية على هذه الفاتورة يساوي صفرا (0.00)",
    );
    expect(cashIqdHtml).toContain("مصدر سداد الفاتورة النقدية");

    const cashUsdHtml = renderToStaticMarkup(
      React.createElement(PolicyProbe, {
        paymentTerms: "CASH",
        currency: "USD",
      }),
    );
    expect(cashUsdHtml).toContain(
      "صافي الذمة المتبقية على هذه الفاتورة يساوي صفرا (0.00)",
    );
    expect(cashUsdHtml).not.toContain("مصدر سداد الفاتورة النقدية");

    const creditHtml = renderToStaticMarkup(
      React.createElement(PolicyProbe, {
        paymentTerms: "CREDIT",
        currency: "IQD",
      }),
    );
    expect(creditHtml).toContain(
      "ترفع هذه الفاتورة ذمة المورد بقيمتها عند الاعتماد والترحيل",
    );
    expect(creditHtml).toContain("سند صرف للمورد");
    expect(creditHtml).not.toContain("مصدر سداد الفاتورة النقدية");
  });

  it("يحافظ في PurchaseNew على حفظ المسودة ومسار الاعتماد الثنائي لغير المالك والترحيل الفوري للمالك فقط", async () => {
    const { readFileSync } = await import("node:fs");
    const createPage = readFileSync(
      new URL("../PurchaseNew.tsx", import.meta.url),
      "utf8",
    );

    expect(createPage).not.toContain('buildPayload("CONFIRMED")');
    expect(createPage).toContain('primaryLabel="حفظ المسودة"');
    expect(createPage).toMatch(
      /notify\.ok\(\s*"حُفظ أمر الشراء مسودة — راجعه ثم أرسله للاعتماد من قائمة المشتريات",?\s*\)/,
    );

    const submitStart = createPage.indexOf(
      "async function handleSaveAndSubmitForApproval()",
    );
    const ownerStart = createPage.indexOf(
      "async function handleSaveAndPostImmediately()",
    );
    expect(submitStart).toBeGreaterThan(0);
    expect(ownerStart).toBeGreaterThan(submitStart);

    const submitBody = createPage.slice(submitStart, ownerStart);
    expect(submitBody).toContain("createAsyncMut.mutateAsync(buildPayload())");
    expect(submitBody).toContain("confirmAsyncMut.mutateAsync(");
    expect(submitBody).not.toContain("decideAsyncMut.mutateAsync(");

    const ownerBody = createPage.slice(ownerStart);
    expect(ownerBody).toContain("me.data?.isOwner !== true");
    expect(ownerBody).toContain(
      'canLifecycleOperation(me.data, "purchases.decideControl", true)',
    );
    expect(ownerBody).toContain("confirmedFullReceipt: true");
    expect(ownerBody).toContain("cashSource: undefined");
    expect(createPage).toContain("{ tender: tenderState.payload }");
  });

  it("يهيئ نموذج سند الصرف تلقائيا على المورد عند تمرير partyType=SUPPLIER&partyId في الرابط", async () => {
    const { readFileSync } = await import("node:fs");
    const voucherStateSrc = readFileSync(
      new URL(
        "../../components/vouchers/useVoucherFormState.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(voucherStateSrc).toContain(
      'queryParams.get("partyType") === "SUPPLIER"',
    );
    expect(voucherStateSrc).toContain('queryParams.get("partyId")');
    expect(voucherStateSrc).toContain("seededSupplierId");
  });

  it("يطبق استثناء المالك في PurchaseApprovalQueue على اوامر الشراء مع بقاء فصل المهام لغير المالك", async () => {
    const { PurchaseApprovalQueue } =
      await import("@/components/purchases/PurchaseApprovalQueue");

    state.pendingControlRows = [
      {
        id: 55,
        documentType: "PURCHASE_ORDER",
        purchaseOrderId: 262,
        poNumber: "PO262",
        kind: "APPROVE_REVISION",
        reason: "ارسال فاتورة شراء للاعتماد",
        requestedBy: 7,
        creatorId: 7,
        lastEditedBy: 7,
        requestedAt: new Date("2026-10-20T08:00:00Z"),
      },
    ];

    const nonOwnerHtml = renderToStaticMarkup(
      React.createElement(PurchaseApprovalQueue, {
        currentUserId: 7,
        isOwner: false,
      }),
    );
    expect(nonOwnerHtml).toContain(
      "لا يستطيع هذا الحساب حسم الطلب لأنه صاحب الطلب أو منشئ/مرسل/آخر محرر للمستند.",
    );

    const ownerHtml = renderToStaticMarkup(
      React.createElement(PurchaseApprovalQueue, {
        currentUserId: 7,
        isOwner: true,
      }),
    );
    expect(ownerHtml).not.toContain(
      "لا يستطيع هذا الحساب حسم الطلب لأنه صاحب الطلب أو منشئ/مرسل/آخر محرر للمستند.",
    );
    expect(ownerHtml).not.toMatch(/disabled=""[^>]*>[^<]*اعتماد/);
  });

  it("يعرض مسار مطابقة السند السابق في PurchaseOrderDetail للفاتورة النقدية العالقة ويحجب الروابط عند غياب المورد", async () => {
    const { default: PurchaseOrderDetail } =
      await import("@/pages/PurchaseOrderDetail");

    state.order = {
      ...state.order,
      id: 262,
      status: "RECEIVED",
      branchId: 1,
      supplierId: 19,
      settlementType: "CASH",
      agreedCurrency: "IQD",
      settlement: evidence("0.00", "0.00", "240000.00", "UNPAID"),
    };
    const withSupplierHtml = renderToStaticMarkup(
      React.createElement(PurchaseOrderDetail),
    );
    expect(withSupplierHtml).toContain("مطابقة سند صرف سابق دون صرف مكرر");
    expect(withSupplierHtml).toContain("partyType=SUPPLIER&amp;partyId=19");

    state.order = {
      ...state.order,
      supplierId: null,
    };
    const withoutSupplierHtml = renderToStaticMarkup(
      React.createElement(PurchaseOrderDetail),
    );
    expect(withoutSupplierHtml).not.toContain("partyId=null");
    expect(withoutSupplierHtml).not.toContain("supplierId=null");
    expect(withoutSupplierHtml).not.toContain(
      "مطابقة سند صرف سابق دون صرف مكرر",
    );
  });

  it("ينفذ مسارات PurchaseNew الثنائية والفورية وينظف الكاش وينبه بوضوح عند تعثر الخطوة الثالثة", async () => {
    const { __TEST_ONLY__ } = await import("@/pages/PurchaseNew");

    // ١) مسار الحفظ والارسال للاعتماد (خطوتان)
    const submitSteps: string[] = [];
    const submitToasts: string[] = [];
    const submitNav: string[] = [];
    const submitPending: boolean[] = [];

    await __TEST_ONLY__.runSubmitForApprovalWorkflow({
      isCash: true,
      clientRequestId: "req-submit-1",
      createOrder: async () => {
        submitSteps.push("create");
        return { purchaseOrderId: 301, version: 1, poNumber: "PO-301" };
      },
      confirmOrder: async (input) => {
        submitSteps.push(
          `confirm:${input.purchaseOrderId}:${input.expectedVersion}`,
        );
        return { requestId: 801 };
      },
      invalidateAll: async () => {
        submitSteps.push("invalidate");
      },
      onSuccessToast: (m) => submitToasts.push(m),
      onErrorToast: () => submitSteps.push("error"),
      onNavigate: (p) => submitNav.push(p),
      setPending: (v) => submitPending.push(v),
    });

    expect(submitSteps).toEqual(["create", "confirm:301:1", "invalidate"]);
    expect(submitToasts[0]).toContain("PO-301");
    expect(submitNav).toEqual(["/purchases"]);
    expect(submitPending).toEqual([true, false]);

    // ٢) مسار المالك الفوري عند فشل الخطوة الثالثة (مثلاً عدم كفاية النقد بعد نجاح الانشاء والارسال)
    const ownerSteps: string[] = [];
    const ownerWarns: string[] = [];
    const ownerErrors: unknown[] = [];
    const ownerNav: string[] = [];
    const ownerPending: boolean[] = [];

    await __TEST_ONLY__.runImmediatePostWorkflow({
      isCash: true,
      clientRequestId: "req-owner-fail",
      cashSource: { mode: "TREASURY" as const },
      createOrder: async () => {
        ownerSteps.push("create");
        return { purchaseOrderId: 404, version: 1, poNumber: "PO-404" };
      },
      confirmOrder: async () => {
        ownerSteps.push("confirm");
        return { requestId: 909 };
      },
      decideOrder: async (input) => {
        ownerSteps.push(`decide:${input.requestId}:${input.cashSource.mode}`);
        throw new Error("رصيد الخزينة غير كاف");
      },
      invalidateAll: async () => {
        ownerSteps.push("invalidate");
      },
      onSuccessToast: () => ownerSteps.push("ok"),
      onWarnToast: (m) => ownerWarns.push(m),
      onErrorToast: (e) => ownerErrors.push(e),
      onNavigate: (p) => ownerNav.push(p),
      setPending: (v) => ownerPending.push(v),
    });

    expect(ownerSteps).toEqual([
      "create",
      "confirm",
      "decide:909:TREASURY",
      "invalidate",
    ]);
    expect(ownerErrors).toHaveLength(1);
    expect(ownerWarns[0]).toContain("PO-404");
    expect(ownerWarns[0]).toContain("دون صرف مكرر");
    expect(ownerNav).toEqual(["/purchases/404"]);
    expect(ownerPending).toEqual([true, false]);
  });

  it("derivePurchaseCashSourceDecision يفرض isActionBlocked عند اختيار مصدر صريح اثناء تحميل بيانات فرع جديد", async () => {
    const { derivePurchaseCashSourceDecision } =
      await import("@/components/purchases/PurchaseCashSourceField");
    const loadingExplicit = derivePurchaseCashSourceDecision({
      normalizedBranchId: 2,
      enabled: true,
      context: "create",
      isCreator: true,
      mode: "TREASURY",
      shiftId: "",
      data: undefined,
      isLoading: true,
      isError: false,
    });
    expect(loadingExplicit.validationError).toBeNull();
    expect(loadingExplicit.isActionBlocked).toBe(true);
    expect(loadingExplicit.payload).toBeUndefined();
  });

  it("يحجب اعتماد APPROVE_REVISION في PurchaseApprovalQueue حتى تكتمل تفاصيل الفاتورة بنجاح ويبقيه محجوبا عند التحميل او التحديث او الخطأ", async () => {
    const { deriveApprovePoRevisionGate } =
      await import("@/components/purchases/PurchaseApprovalQueue");

    // أثناء التحميل الأولي (data غير متاحة بعد): محجوب حتى مع تأكيد الاستلام الكامل
    expect(
      deriveApprovePoRevisionGate({
        isApprovePoRevision: true,
        targetPoId: 262,
        poDetail: undefined,
        isLoading: true,
        isFetching: true,
        isError: false,
        confirmedFullReceipt: true,
        isCashSourceBlocked: false,
      }),
    ).toEqual({
      isPoDetailReady: false,
      isCashIqdPo: false,
      isApproveBlocked: true,
    });

    // عند فشل الاستعلام (حتى لو وُجدت بيانات قديمة مخزنة مؤقتاً): محجوب
    expect(
      deriveApprovePoRevisionGate({
        isApprovePoRevision: true,
        targetPoId: 262,
        poDetail: { id: 262, settlementType: "CREDIT", agreedCurrency: "IQD" },
        isLoading: false,
        isFetching: false,
        isError: true,
        confirmedFullReceipt: true,
        isCashSourceBlocked: false,
      }),
    ).toEqual({
      isPoDetailReady: false,
      isCashIqdPo: false,
      isApproveBlocked: true,
    });

    // أثناء إعادة الجلب لفاتورة قد تكون تحولت من آجل إلى نقدي: محجوب حتى يستقر الجلب
    expect(
      deriveApprovePoRevisionGate({
        isApprovePoRevision: true,
        targetPoId: 262,
        poDetail: { id: 262, settlementType: "CREDIT", agreedCurrency: "IQD" },
        isLoading: false,
        isFetching: true,
        isError: false,
        confirmedFullReceipt: true,
        isCashSourceBlocked: false,
      }),
    ).toEqual({
      isPoDetailReady: false,
      isCashIqdPo: false,
      isApproveBlocked: true,
    });

    // بعد اكتمال تحميل فاتورة آجلة وتأكيد الاستلام: مسموح
    expect(
      deriveApprovePoRevisionGate({
        isApprovePoRevision: true,
        targetPoId: 262,
        poDetail: { id: 262, settlementType: "CREDIT", agreedCurrency: "IQD" },
        isLoading: false,
        isFetching: false,
        isError: false,
        confirmedFullReceipt: true,
        isCashSourceBlocked: false,
      }),
    ).toEqual({
      isPoDetailReady: true,
      isCashIqdPo: false,
      isApproveBlocked: false,
    });

    // بعد اكتمال تحميل فاتورة نقدية بالدينار: يتبع حجب مصدر النقد
    expect(
      deriveApprovePoRevisionGate({
        isApprovePoRevision: true,
        targetPoId: 262,
        poDetail: { id: 262, settlementType: "CASH", agreedCurrency: "IQD" },
        isLoading: false,
        isFetching: false,
        isError: false,
        confirmedFullReceipt: true,
        isCashSourceBlocked: true,
      }),
    ).toEqual({
      isPoDetailReady: true,
      isCashIqdPo: true,
      isApproveBlocked: true,
    });
  });

  it("QuickSupplierPaymentDialog يعيد تطبيق مصدر النقد الافتراضي (الدرج الوحيد او الخزينة) بعد تهيئة النافذة او وصول matchedInvoice مع بيانات مخزنة مؤقتا", async () => {
    const { JSDOM } = await import("jsdom");
    const { createRoot } = await import("react-dom/client");
    const { act } = React;
    const { QuickSupplierPaymentDialog } = await vi.importActual<
      typeof import("@/components/purchases/QuickSupplierPaymentDialog")
    >("@/components/purchases/QuickSupplierPaymentDialog");

    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const prevGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      HTMLInputElement: globalThis.HTMLInputElement,
      HTMLSelectElement: globalThis.HTMLSelectElement,
      Event: globalThis.Event,
      IS_REACT_ACT_ENVIRONMENT: (globalThis as Record<string, unknown>)
        .IS_REACT_ACT_ENVIRONMENT,
    };
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      HTMLSelectElement: dom.window.HTMLSelectElement,
      Event: dom.window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);

    const baseProps = {
      onClose: vi.fn(),
      purchaseOrderId: 346,
      poNumber: "PO-1-20261022-00010",
      supplierId: 56,
      supplierName: "مورد عام نقدي",
      branchId: 1,
      currency: "IQD" as const,
      remainingAmount: "8000.00",
    };

    try {
      // ١) فتح النافذة مع وجود cashSources مخزنة مؤقتاً قبل اكتمال matchedInvoice ثم وصول matchedInvoice لاحقاً
      const cachedSingleDrawer = {
        drawers: [{ id: 14, shiftType: "MORNING" }],
        canUseTreasury: true,
      };
      state.cashSourcesResult = {
        data: cachedSingleDrawer,
        isLoading: false,
        isError: false,
      };
      state.paymentSourcesResult = {
        data: undefined,
        isLoading: true,
      };

      await act(async () => {
        root.render(
          React.createElement(QuickSupplierPaymentDialog, {
            ...baseProps,
            open: true,
          }),
        );
      });

      // يصل matchedInvoice بعد التهيئة بينما cashSourcesQuery.data لم يتغير مرجعه
      state.paymentSourcesResult = {
        data: {
          rows: [
            {
              id: 901,
              invoiceNumber: "PINV-346",
              currency: "IQD",
              remainingAmount: "8000.00",
              pendingAmount: "0.00",
              version: 1,
              purchaseOrderIds: [346],
            } as unknown as {
              id: number;
              invoiceNumber: string;
              currency: string;
              remainingAmount: string;
              pendingAmount: string;
            },
          ],
        },
        isLoading: false,
      };

      await act(async () => {
        root.render(
          React.createElement(QuickSupplierPaymentDialog, {
            ...baseProps,
            open: true,
          }),
        );
      });

      const drawerSelect = host.querySelector(
        'select[aria-label="درج الدافع"]',
      );
      expect(drawerSelect?.getAttribute("data-selected-value")).toBe("14");

      // ٢) إغلاق النافذة ثم إعادة فتحها مع خزينة فقط وبدون أدراج مخزنة في الكاش
      await act(async () => {
        root.render(
          React.createElement(QuickSupplierPaymentDialog, {
            ...baseProps,
            open: false,
          }),
        );
      });

      const cachedTreasuryOnly = {
        drawers: [],
        canUseTreasury: true,
      };
      state.cashSourcesResult = {
        data: cachedTreasuryOnly,
        isLoading: false,
        isError: false,
      };

      await act(async () => {
        root.render(
          React.createElement(QuickSupplierPaymentDialog, {
            ...baseProps,
            open: true,
          }),
        );
      });

      const sourceSelect = host.querySelector("#pay-cash-source");
      expect(sourceSelect?.getAttribute("data-selected-value")).toBe(
        "TREASURY",
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      Object.assign(globalThis, prevGlobals);
    }
  }, 20_000);
});
