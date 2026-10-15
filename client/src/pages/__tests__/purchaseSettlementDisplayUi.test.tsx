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
}));
vi.mock("@/lib/trpc", () => ({
  trpc: { purchases: { get: { useQuery: () => ({ data: state.order }) } } },
}));
vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
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
});
