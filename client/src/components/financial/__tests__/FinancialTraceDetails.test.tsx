// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinancialTraceDetails } from "../FinancialTraceDetails";
import { FinancialSourceBadge } from "../FinancialSourceBadge";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("React", React);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function render(node: React.ReactNode) {
  act(() => root.render(node));
  return container.textContent ?? "";
}

it("shows the funding source beside the payment method without requiring a cash bucket", () => {
  const text = render(
    <FinancialSourceBadge source="BANK" paymentMethod="TRANSFER" />,
  );
  expect(text).toContain("تحويل");
  expect(text).toContain("حساب بنكي");
});

it("keeps stock funding visible for an accrual expense", () => {
  const text = render(
    <FinancialSourceBadge source="STOCK" paymentMethod="ACCRUAL" />,
  );
  expect(text).toContain("استحقاق");
  expect(text).toContain("مخزون");
});

it("deduplicates a cash bucket and preserves method visibility options", () => {
  let text = render(
    <FinancialSourceBadge
      source="DRAWER"
      paymentMethod="CASH"
      cashBucket="DRAWER"
    />,
  );
  expect(text.match(/درج كاشير/g)).toHaveLength(1);
  expect(text).toContain("نقدي");
  text = render(
    <FinancialSourceBadge
      source="BANK"
      paymentMethod="TRANSFER"
      showBucket={false}
    />,
  );
  expect(text).toBe("تحويل");
  text = render(
    <FinancialSourceBadge
      source="DRAWER"
      paymentMethod="CASH"
      cashBucket="DRAWER"
      showMethod={false}
    />,
  );
  expect(text).toBe("درج كاشير");
});

it("retains explicit labels, unknown source text and the empty fallback", () => {
  expect(render(<FinancialSourceBadge source="LEGACY" />)).toBe("LEGACY");
  expect(render(<FinancialSourceBadge />)).toBe("مصدر غير محدد");
  expect(
    render(<FinancialSourceBadge source="BANK" label="حساب الشركة" />),
  ).toBe("حساب الشركة");
});

it("retains zero amounts, identities and balances through every trace section", () => {
  const text = render(
    <FinancialTraceDetails
      document={{
        id: 0,
        number: "EXP#0",
        amount: 0,
        direction: "OUT",
        extra: [
          { label: "حقل صفري", value: 0 },
          { label: "حقل فارغ", value: "" },
        ],
      }}
      moneyPath={{
        source: "BANK",
        paymentMethod: "TRANSFER",
        balanceBefore: 0,
        balanceAfter: 0,
        shiftId: 0,
      }}
      parties={{ recordedBy: { name: "المسجل", id: 0 } }}
      timestamps={[{ label: "التنفيذ", value: "2026-10-25", actor: "المنفذ" }]}
      linkChain={[
        {
          kind: "DOCUMENT",
          label: "المستند",
          value: "EXP#0",
          href: "/expenses/0",
        },
        { kind: "LEDGER", label: "القيد", missing: true },
      ]}
      integrityWarnings={[
        {
          severity: "warning",
          title: "مراجعة المصدر",
          description: "طابق المرجع مع دليل التحويل قبل التسوية",
          code: "SOURCE",
          resolved: true,
        },
      ]}
      auditTimeline={[
        {
          action: "تسجيل",
          actor: "المسجل",
          at: "2026-10-25",
          detail: "تم التسجيل",
          status: "مكتمل",
          tone: "ok",
        },
      ]}
      actions={<button>تصدير</button>}
    />,
  );
  for (const label of [
    "قيمة الحركة",
    "حقل صفري",
    "الرصيد قبل الحركة",
    "الرصيد بعد الحركة",
    "#0",
    "صادر",
    "حساب بنكي",
    "التنفيذ",
    "المنفذ",
    "غير مربوط",
    "مراجعة المصدر",
    "طابق المرجع مع دليل التحويل قبل التسوية",
    "تم التسجيل",
    "تصدير",
  ])
    expect(text).toContain(label);
  expect(text).not.toContain("حقل فارغ");
  expect(
    container.querySelector('a[href="/expenses/0"]')?.textContent,
  ).toContain("EXP#0");
});

it("preserves the ordered links, extra actors and native section attributes", () => {
  render(
    <FinancialTraceDetails
      id="trace-44"
      aria-label="مسار خاص"
      document={{ number: "EXP#44" }}
      parties={{
        extra: [
          { label: "راجع", name: "مراجع الفرع", role: "مدقق", note: "مطابق" },
        ],
      }}
      linkChain={Array.from({ length: 7 }, (_, index) => ({
        id: index,
        kind: "LEDGER" as const,
        label: "القيد",
        value: `JE#${index}`,
        href: `/ledger/${index}`,
      }))}
    />,
  );
  expect(container.querySelector("#trace-44")?.getAttribute("aria-label")).toBe(
    "مسار خاص",
  );
  expect(container.textContent).toContain("مراجع الفرع");
  expect(container.textContent).toContain("مطابق");
  const chain = container.querySelector(
    'ol[aria-label="المستند ثم الإيصال ثم قيد الدفتر"]',
  );
  expect(
    Array.from(chain!.querySelectorAll("a"), (node) =>
      node.getAttribute("href"),
    ),
  ).toEqual(Array.from({ length: 7 }, (_, index) => `/ledger/${index}`));
});

it("normalizes source codes while preserving a caller supplied zero label", () => {
  expect(
    render(<FinancialSourceBadge source=" bank " paymentMethod=" transfer " />),
  ).toContain("حساب بنكي");
  expect(render(<FinancialSourceBadge source="BANK" label={0} />)).toBe("0");
});

it("shows the money source when the amount is absent and omits empty sections", () => {
  const text = render(
    <FinancialTraceDetails document={{}} moneyPath={{ source: "TREASURY" }} />,
  );
  expect(text).toContain("خزينة إدارية");
  expect(text).not.toContain("قيمة الحركة");
  const headings = Array.from(
    container.querySelectorAll("h3"),
    (node) => node.textContent,
  );
  expect(headings).not.toContain("هوية المستند");
  expect(headings).not.toContain("الأطراف والمسؤوليات");
});
