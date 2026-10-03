import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../brand", async () => {
  const actual = await vi.importActual<typeof import("../brand")>("../brand");
  return {
    ...actual,
    logoUrl: () => "/logo.png",
    openPrintWindow: vi.fn(() => true),
  };
});

import { openPrintWindow } from "../brand";
import {
  printExchangeStatementDoc,
  printExchangeHousesListDoc,
  printExchangeReconcileDoc,
  printPendingExchangeDepositsDoc,
} from "../printExchangeStatement";


describe("مطبوعات وتقارير وحدة الصيرفة (A4 الرسمية)", () => {
  beforeEach(() => {
    vi.mocked(openPrintWindow).mockClear();
  });

  describe("printExchangeStatementDoc — كشف حساب الصيرفة", () => {
    it("ينشئ وثيقة A4 أفقية (Landscape) مع كامل الحقول المالية وجدول الحركات", () => {
      const res = printExchangeStatementDoc({
        houseName: "صيرفة بغداد الدولية",
        housePhone: "07700000000",
        fromDate: "2026-09-01",
        toDate: "2026-09-30",
        printedByName: "المحاسب المالي",
        summary: {
          currentBalanceIqd: "15000000.00",
          currentBalanceUsd: "10000.00",
          currentControlCarryingIqd: "14500000.00",
          totalDepositIqd: "20000000.00",
          totalWithdrawIqd: "5000000.00",
          totalDepositUsd: "15000.00",
          totalWithdrawUsd: "5000.00",
          totalUsdBought: "10000.00",
          totalSettledIqd: "8000000.00",
          totalFeesIqd: "150000.00",
          totalFxDiff: "250000.00",
        },
        physicalUsdByBranch: [
          {
            branchName: "الفرع الرئيسي",
            quantityUsd: "10000.00",
            carryingIqd: "14500000.00",
            wavgRate: "1450.0000",
          },
        ],
        transactions: [
          {
            createdAt: "2026-09-15 10:30",
            txnNumber: "EX-001",
            type: "DEPOSIT",
            typeLabel: "إيداع",
            supplierName: null,
            branchName: "الفرع الرئيسي",
            createdByName: "أحمد",
            iqdAmount: "5000000.00",
            usdAmount: "0.00",
            fxDiff: "0.00",
            commissionIqd: "0.00",
            balanceIqdAfter: "5000000.00",
            balanceUsdAfter: "0.00",
            status: "ACTIVE",
            statusLabel: "نافذة",
            notes: "إيداع نقدي",
          },
        ],
      });

      expect(res).toBe(true);
      expect(openPrintWindow).toHaveBeenCalledOnce();
      const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
      expect(html).toContain("كشف حساب صيرفة");
      expect(html).toContain("صيرفة بغداد الدولية");
      expect(html).toContain("07700000000");
      expect(html).toContain("landscape");
      expect(html).toContain("النقد الدولاري الفعلي حسب الفرع");
      expect(html).toContain("EX-001");
      expect(html).toContain("إيداع");
      expect(html).toContain("حفظ كملف PDF");
      expect(html).toContain("طباعة المستند");
    });
  });

  describe("printExchangeHousesListDoc — قائمة وأرصدة الصيرفات", () => {
    it("ينشئ تقرير A4 عمودي يشمل كافة الصيرفات وصافي التعرض والإجماليات", () => {
      const res = printExchangeHousesListDoc({
        totals: {
          count: 2,
          iqd: "25000000.00",
          usd: "18000.00",
          net: "51100000.00",
        },
        houses: [
          {
            name: "صيرفة الرشيد",
            phone: "07801111111",
            balanceIqd: "10000000.00",
            balanceUsd: "8000.00",
            usdCostRate: "1450.00",
            netExposure: "21600000.00",
            isActive: true,
          },
          {
            name: "صيرفة المنصور",
            phone: "07902222222",
            balanceIqd: "15000000.00",
            balanceUsd: "10000.00",
            usdCostRate: "1450.00",
            netExposure: "29500000.00",
            isActive: true,
          },
        ],
      });

      expect(res).toBe(true);
      expect(openPrintWindow).toHaveBeenCalledOnce();
      const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
      expect(html).toContain("أرصدة الصيرفات ومكاتب التحويل");
      expect(html).toContain("صيرفة الرشيد");
      expect(html).toContain("صيرفة المنصور");
      expect(html).toContain("portrait");
      expect(html).toContain("صافي التعرّض الموحّد");
    });
  });

  describe("printExchangeReconcileDoc — محضر مطابقة رصيد صيرفة", () => {
    it("ينشئ محضر مطابقة A4 رسمي مع شارة النتيجة وجدول الفوارق والبنود المعلقة", () => {
      const res = printExchangeReconcileDoc({
        houseName: "صيرفة الكرخ",
        asOfDate: "2026-09-30",
        ourBalanceIqd: "10000000.00",
        statedBalanceIqd: "10000000.00",
        diffIqd: "0.00",
        ourBalanceUsd: "5000.00",
        statedBalanceUsd: "4000.00",
        diffUsd: "1000.00",
        matched: false,
        pending: [
          {
            txnNumber: "EX-998",
            typeLabel: "شراء دولار",
            iqdAmount: "0.00",
            usdAmount: "1000.00",
            createdAt: "2026-10-01 11:00",
          },
        ],
      });

      expect(res).toBe(true);
      expect(openPrintWindow).toHaveBeenCalledOnce();
      const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
      expect(html).toContain("محضر مطابقة رصيد صيرفة");
      expect(html).toContain("صيرفة الكرخ");
      expect(html).toContain("نتيجة المطابقة");
      expect(html).toContain("البنود المعلّقة بعد تاريخ القطع");
      expect(html).toContain("EX-998");
      expect(html).toContain("شراء دولار");
    });
  });

  describe("printPendingExchangeDepositsDoc — إيداعات الدولار المعلّقة", () => {
    it("ينشئ تقرير A4 رسمي للإيداعات المعلّقة بانتظار الاعتماد الثاني مع جدول العمليات والتوقيعات", () => {
      const res = printPendingExchangeDepositsDoc({
        count: 1,
        totalUsdAmount: "5000.00",
        printedByName: "أمين الصندوق",
        deposits: [
          {
            txnNumber: "EX-DEP-101",
            houseName: "صيرفة المنصور",
            usdAmount: "5000.00",
            exchangeRate: "1450.0000",
            notes: "إيداع دولار مباشر بانتظار الاعتماد",
          },
        ],
      });

      expect(res).toBe(true);
      expect(openPrintWindow).toHaveBeenCalledOnce();
      const html = vi.mocked(openPrintWindow).mock.calls[0]?.[0] ?? "";
      expect(html).toContain("إيداعات الدولار المعلّقة");
      expect(html).toContain("REP-PENDING-USD-DEP");
      expect(html).toContain("صيرفة المنصور");
      expect(html).toContain("EX-DEP-101");
      expect(html).toContain("5,000");
      expect(html).toContain("فصل المهام");
    });
  });
});

describe("تغطية أزرار وإمكانيات التصدير في شاشات الصيرفة", () => {
  it("ExchangeAccounts تتضمن أزرار تصدير Excel وطباعة/PDF", () => {
    const src = readFileSync(new URL("../../../pages/ExchangeAccounts.tsx", import.meta.url), "utf8");
    expect(src).toContain("exportAccountsExcel");
    expect(src).toContain("printAccountsDoc");
    expect(src).toContain("تصدير Excel");
    expect(src).toContain("طباعة / PDF");
    expect(src).toContain("FileSpreadsheet");
    expect(src).toContain("Printer");
  });

  it("ExchangeReconcile تتضمن أزرار تصدير Excel وطباعة/PDF المحضر", () => {
    const src = readFileSync(new URL("../../../pages/ExchangeReconcile.tsx", import.meta.url), "utf8");
    expect(src).toContain("exportReconcileExcel");
    expect(src).toContain("printReconcileDoc");
    expect(src).toContain("تصدير Excel");
    expect(src).toContain("طباعة / PDF المحضر");
    expect(src).toContain("FileSpreadsheet");
    expect(src).toContain("Printer");
  });

  it("ExchangeOperations تتضمن أزرار تصدير Excel وطباعة/PDF للإيداعات المعلقة", () => {
    const src = readFileSync(new URL("../../../pages/ExchangeOperations.tsx", import.meta.url), "utf8");
    expect(src).toContain("exportPendingDepositsExcel");
    expect(src).toContain("printPendingDepositsDoc");
    expect(src).toContain("تصدير Excel");
    expect(src).toContain("طباعة / PDF");
    expect(src).toContain("FileSpreadsheet");
    expect(src).toContain("Printer");
  });

  it("ExchangeStatement تتضمن أزرار تصدير Excel وطباعة/PDF الكشف", () => {
    const src = readFileSync(new URL("../../../pages/ExchangeStatement.tsx", import.meta.url), "utf8");
    expect(src).toContain("exportStatementExcel");
    expect(src).toContain("printFullStatement");
    expect(src).toContain("تصدير Excel");
    expect(src).toContain("طباعة / PDF الكشف");
    expect(src).toContain("FileSpreadsheet");
    expect(src).toContain("Printer");
  });
});

