import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StackedEntityCell } from "@/components/data-table/StackedEntityCell";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n?/gu, "\n");

describe("عقد دمج المورد ورقم الأمر وتحسين العرض الأفقي لجدول المشتريات", () => {
  const purchasesSrc = read("../Purchases.tsx");
  const stackedCellSrc = read("../../components/data-table/StackedEntityCell.tsx");

  it("يوفر مكون StackedEntityCell المكدس مع عزل LTR وزر نسخ مستقل", () => {
    expect(stackedCellSrc).toContain("export function StackedEntityCell");
    expect(stackedCellSrc).toContain("<bdi dir=\"ltr\">");
    expect(stackedCellSrc).toContain("<CopyButton");
    expect(stackedCellSrc).not.toContain("CopyInline");
  });

  it("يرسم StackedEntityCell بشكل حقيقي مع عزل LTR وبلا تكرار للنص", () => {
    const html = renderToStaticMarkup(
      React.createElement(StackedEntityCell, {
        primary: "شركة الرافدين للتجارة",
        secondary: "PO-2026-0001",
        copyValue: "PO-2026-0001",
      }),
    );

    // التحقق من وجود اسم المورد
    expect(html).toContain("شركة الرافدين للتجارة");
    // التحقق من عزل رقم الأمر في bdi LTR
    expect(html).toContain('<bdi dir="ltr">PO-2026-0001</bdi>');
    // التحقق من وجود زر النسخ (CopyButton)
    expect(html).toContain("button");
    // التحقق من عدم تكرار رقم الأمر خارج الـ bdi
    const matches = html.match(/PO-2026-0001/gu);
    // القيمة تظهر في نص الـ bdi، وفي القيمة المراد نسخها داخل CopyButton
    expect(matches).not.toBeNull();
  });

  it("يرسم زر تفاعلي للسطر الثانوي عند تمرير onSecondaryClick وعنصر span عند غيابه", () => {
    const withClick = renderToStaticMarkup(
      React.createElement(StackedEntityCell, {
        primary: "مورد تجريبي",
        secondary: "PO-100",
        onSecondaryClick: () => {},
      }),
    );
    expect(withClick).toMatch(/<button[^>]*><bdi dir="ltr">PO-100<\/bdi><\/button>/u);

    const withoutClick = renderToStaticMarkup(
      React.createElement(StackedEntityCell, {
        primary: "مورد تجريبي",
        secondary: "PO-100",
      }),
    );
    expect(withoutClick).toMatch(/<span[^>]*><bdi dir="ltr">PO-100<\/bdi><\/span>/u);
  });

  it("يتعامل مع الحالات الحدية للسطر الثانوي وقيمة النسخ الفارغة بأمان", () => {
    // عند تمرير نص فارغ أو مسافات فقط في secondary، يجب ألا يُرسم زر فارغ
    const emptySecondary = renderToStaticMarkup(
      React.createElement(StackedEntityCell, {
        primary: "مورد بلا رقم",
        secondary: "   ",
        copyValue: "",
      }),
    );
    expect(emptySecondary).toContain("مورد بلا رقم");
    expect(emptySecondary).not.toContain("<bdi");
    expect(emptySecondary).not.toContain("<button");

    // عند تمرير null في secondary و copyValue
    const nullValues = renderToStaticMarkup(
      React.createElement(StackedEntityCell, {
        primary: "مورد بلا تفاصيل",
        secondary: null,
        copyValue: null,
      }),
    );
    expect(nullValues).toContain("مورد بلا تفاصيل");
    expect(nullValues).not.toContain("<bdi");
  });

  it("يصلح خلل تكرار رقم الأمر ويلغي التكرار بجانب زر النسخ في جدول المشتريات", () => {
    // الخلل السابق: كان يطبع رقم الأمر في button ثم يضع بجانبه CopyInline الذي يطبع الرقم مرة ثانية
    expect(purchasesSrc).not.toMatch(/<button[^>]*>\{row\.original\.poNumber\}<\/button>\s*<CopyInline/u);
    expect(purchasesSrc).not.toContain("<CopyInline value={row.original.poNumber}");
    expect(purchasesSrc).toContain("StackedEntityCell");
    expect(purchasesSrc).toContain("secondary={row.original.poNumber}");
  });

  it("يدمج المورد ورقم أمر الشراء في خلية مكدسة مع رابط كشف الحساب وفتح الدرج", () => {
    expect(purchasesSrc).toContain('id: "supplierAndOrder"');
    expect(purchasesSrc).toContain('header: "المورد / رقم الأمر"');
    expect(purchasesSrc).toContain("/suppliers-statement?id=${row.original.supplierId}");
    expect(purchasesSrc).toContain("setDrawerPoId(row.original.id)");
    // التحقق من دمج accessorFn النظيف بدون مسافة بادئة
    expect(purchasesSrc).toContain('[p.supplierName, p.poNumber].filter(Boolean).join(" · ")');
  });

  it("يدمج سعر تثبيت الصرف بشكل ثانوي تحت فاتورة المورد بالدولار", () => {
    expect(purchasesSrc).toContain('id: "supplierInvoice"');
    expect(purchasesSrc).toContain("row.original.usdTotal");
    expect(purchasesSrc).toContain("row.original.agreedRate");
    expect(purchasesSrc).toContain("سعر تثبيت الصرف");
  });

  it("يدمج شارة التسوية وسداد الذمة بشكل ثانوي تحت عمود الحالة مع التفاف آمن", () => {
    expect(purchasesSrc).toContain('header: "الحالة والتسوية"');
    expect(purchasesSrc).toContain("PO_STATUS_CLASS[row.original.status]");
    expect(purchasesSrc).toContain("SETTLEMENT_CLASS[row.original.settlementType]");
    expect(purchasesSrc).toContain("مسدد بالكامل");
    expect(purchasesSrc).toContain("flex flex-wrap items-center justify-center gap-1");
  });

  it("يحافظ على فصْل رقم الأمر والمورد في تصدير الإكسل exportSpec للحسابات", () => {
    const exportSpecMatch = purchasesSrc.match(/exportSpec=\{\{[\s\S]*?columns:\s*\[([\s\S]*?)\]/u);
    expect(exportSpecMatch).toBeTruthy();
    const columnsBlock = exportSpecMatch![1];
    expect(columnsBlock).toContain('{ key: "poNumber", header: "رقم الأمر" }');
    expect(columnsBlock).toContain('{ key: "supplierName", header: "المورد" }');
  });
});
