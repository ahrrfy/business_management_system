// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FinancialCellProvenanceHover } from "./FinancialCellProvenanceHover";
import type { FinancialCellProvenancePayload } from "@shared/financialProvenance";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("FinancialCellProvenanceHover Empirical Render & Stress Harness", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders null or undefined data gracefully without wrapping", () => {
    act(() => {
      root.render(
        <FinancialCellProvenanceHover data={null}>
          <span id="child-node">25,000 د.ع</span>
        </FinancialCellProvenanceHover>
      );
    });

    const span = host.querySelector("#child-node");
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe("25,000 د.ع");
  });

  it("renders when disabled=true without mounting hover trigger", () => {
    const payload: FinancialCellProvenancePayload = {
      movementType: "revenue",
      title: "إيراد معطل",
      totalAmount: 10000,
    };

    act(() => {
      root.render(
        <FinancialCellProvenanceHover data={payload} disabled={true}>
          <span id="child-disabled">10,000 د.ع</span>
        </FinancialCellProvenanceHover>
      );
    });

    const span = host.querySelector("#child-disabled");
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe("10,000 د.ع");
  });

  it("renders primitive string children wrapped in pointer span", () => {
    const payload: FinancialCellProvenancePayload = {
      movementType: "revenue",
      title: "إيراد مبيعات",
      totalAmount: 50000,
    };

    act(() => {
      root.render(
        <FinancialCellProvenanceHover data={payload}>
          50,000 د.ع
        </FinancialCellProvenanceHover>
      );
    });

    const trigger = host.querySelector("span.cursor-pointer");
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("50,000 د.ع");
  });

  it("renders extreme amounts (100 Billion IQD) and complex metadata", () => {
    const payload: FinancialCellProvenancePayload = {
      movementType: "collection",
      title: "تحصيل حساب عميل حكومي",
      totalAmount: "100000000000.00",
      formattedAmount: "100,000,000,000 د.ع",
      party: {
        name: "وزارة التعليم العالي",
        kind: "customer",
        phone: "07700000000",
      },
      documentRef: {
        docType: "receipt",
        docNumber: "REC-2026-9999",
      },
      category: "عقود سنوية",
      contraAccount: {
        code: "1201",
        name: "الصندوق الرئيسي",
      },
      shiftInfo: {
        shiftId: 1042,
        ownerName: "علي الكاشير",
      },
      warnings: ["حركة تتطلب تدقيق الإدارة المالية"],
    };

    act(() => {
      root.render(
        <FinancialCellProvenanceHover data={payload}>
          <span id="gov-contract">100,000,000,000 د.ع</span>
        </FinancialCellProvenanceHover>
      );
    });

    const span = host.querySelector("#gov-contract");
    expect(span).not.toBeNull();
  });

  it("renders large sub-item array (150 items) without DOM thrashing or errors", () => {
    const subItems = Array.from({ length: 150 }, (_, i) => ({
      id: `item-${i}`,
      label: `بند تفصيلي #${i + 1}`,
      amount: 1000,
      quantity: 1,
      unitPrice: 1000,
    }));

    const payload: FinancialCellProvenancePayload = {
      movementType: "expense",
      title: "مصروف مواد مطبعة تفصيلي",
      totalAmount: 150000,
      subItems,
    };

    const t0 = performance.now();
    act(() => {
      root.render(
        <FinancialCellProvenanceHover data={payload}>
          <span id="large-list-trigger">150,000 د.ع</span>
        </FinancialCellProvenanceHover>
      );
    });
    const renderTime = performance.now() - t0;

    const span = host.querySelector("#large-list-trigger");
    expect(span).not.toBeNull();
    expect(renderTime).toBeLessThan(100); // Fast initial render
  });

  it("renders negative balance and deficit without crashing", () => {
    const payload: FinancialCellProvenancePayload = {
      movementType: "difference",
      title: "عجز درج ختامي",
      totalAmount: "-45000",
      party: {
        name: "حسين الكاشير",
        kind: "employee",
      },
      subItems: [
        { id: 1, label: "عجز نقدي", amount: -30000 },
        { id: 2, label: "فارق تسوية", amount: -15000 },
      ],
    };

    act(() => {
      root.render(
        <FinancialCellProvenanceHover data={payload}>
          <span id="deficit-trigger">-45,000 د.ع</span>
        </FinancialCellProvenanceHover>
      );
    });

    const span = host.querySelector("#deficit-trigger");
    expect(span).not.toBeNull();
  });
});
