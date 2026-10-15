// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BundleKitReviewStep } from "../BundleKitReviewStep";
import { digitsArabicToLatin } from "@shared/numberNormalize";
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";
import type { BundleKitComponentBatch } from "../BundleKitComponentsStep";
import { formatIqd } from "@/lib/money";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("BundleKitReviewStep Component & Input Normalization Flow", () => {
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

  const mockComponents: ComponentRequirementDto[] = [
    {
      variantId: 201,
      productId: 21,
      baseUnitId: 1,
      baseUnitName: "دفتر",
      productName: "دفتر تجارب علمية",
      sku: "NOTE-SCI-01",
      componentBaseQuantity: 1,
      totalRequiredQty: 10,
      onHandStock: 5,
      shortageQty: 5,
      suggestedBatchQty: 10,
      isManufactured: true,
      recipeId: 60,
      recipeName: "وصفة دفتر تجارب",
      requiredBatchMultiple: 1,
      surplusBufferQty: 0,
      laborPerUnit: "250.00",
      wasteStdPct: "0.05",
    },
    {
      variantId: 202,
      productId: 22,
      baseUnitId: 2,
      baseUnitName: "غلاف",
      productName: "غلاف مقوى سلفان",
      sku: "COVER-LAM-02",
      componentBaseQuantity: 1,
      totalRequiredQty: 10,
      onHandStock: 0,
      shortageQty: 10,
      suggestedBatchQty: 10,
      isManufactured: true,
      recipeId: 61,
      recipeName: "وصفة غلاف مقوى",
      requiredBatchMultiple: 1,
      surplusBufferQty: 0,
      laborPerUnit: "150.00",
      wasteStdPct: "0.02",
    },
  ];

  const mockBatches: BundleKitComponentBatch[] = [
    {
      variantId: 201,
      recipeId: 60,
      batchQty: 10,
      scrapQty: 1,
      laborPerUnit: "250.00",
      selected: true,
    },
    {
      variantId: 202,
      recipeId: 61,
      batchQty: 10,
      scrapQty: 0,
      laborPerUnit: "150.00",
      selected: true,
    },
  ];

  function changeInput(input: HTMLInputElement, value: string): void {
    act(() => {
      const originalType = input.type;
      if (originalType === "number") input.type = "text";
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      nativeSetter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if (originalType === "number") input.type = originalType;
    });
  }

  it("يحول الأرقام المشرقية العربية (١٢٣) في حقل أمر الشغل المرتبط إلى رقم لاتيني صحيح", () => {
    const handleLinkedWoChange = vi.fn();

    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={handleLinkedWoChange}
          estimatedLaborCost="4000.00"
          estimatedMaterialsCost="20000.00"
          estimatedTotalCost="24000.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
        />,
      );
    });

    const woInput = host.querySelector<HTMLInputElement>("#linked-wo");
    expect(woInput).toBeDefined();

    // إدخال أرقام مشرقية عربية: ١٢٣
    changeInput(woInput!, "١٢٣");
    expect(handleLinkedWoChange).toHaveBeenCalledWith(123);
  });

  it("يحول الأرقام الفارسية/الشرقية (۴۵۶) في حقل أمر الشغل المرتبط إلى رقم صحيح", () => {
    const handleLinkedWoChange = vi.fn();

    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={handleLinkedWoChange}
          estimatedLaborCost="4000.00"
          estimatedMaterialsCost="20000.00"
          estimatedTotalCost="24000.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
        />,
      );
    });

    const woInput = host.querySelector<HTMLInputElement>("#linked-wo");
    changeInput(woInput!, "۴۵۶");
    expect(handleLinkedWoChange).toHaveBeenCalledWith(456);
  });

  it("يقبل الأرقام اللاتينية القياسية (789) في حقل أمر الشغل المرتبط", () => {
    const handleLinkedWoChange = vi.fn();

    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={handleLinkedWoChange}
          estimatedLaborCost="4000.00"
          estimatedMaterialsCost="20000.00"
          estimatedTotalCost="24000.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
        />,
      );
    });

    const woInput = host.querySelector<HTMLInputElement>("#linked-wo");
    changeInput(woInput!, "789");
    expect(handleLinkedWoChange).toHaveBeenCalledWith(789);
  });

  it("يمرر null عند تفريغ حقل أمر الشغل أو إدخال صفر أو قيمة سالبة أو نص غير رقمي", () => {
    const handleLinkedWoChange = vi.fn();

    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={123}
          onLinkedWorkOrderChange={handleLinkedWoChange}
          estimatedLaborCost="4000.00"
          estimatedMaterialsCost="20000.00"
          estimatedTotalCost="24000.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
        />,
      );
    });

    const woInput = host.querySelector<HTMLInputElement>("#linked-wo");

    changeInput(woInput!, "");
    expect(handleLinkedWoChange).toHaveBeenCalledWith(null);

    changeInput(woInput!, "0");
    expect(handleLinkedWoChange).toHaveBeenCalledWith(null);

    changeInput(woInput!, "-5");
    expect(handleLinkedWoChange).toHaveBeenCalledWith(null);

    changeInput(woInput!, "invalid");
    expect(handleLinkedWoChange).toHaveBeenCalledWith(null);
  });

  it("يلتزم بشروط الشارات بمنع الالتفاف وعدم الانكماش (whitespace-nowrap shrink-0) لشارة كمية البكج", () => {
    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={vi.fn()}
          estimatedLaborCost="4000.00"
          estimatedMaterialsCost="20000.00"
          estimatedTotalCost="24000.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
        />,
      );
    });

    // البحث عن شارة الكمية المطلوبة
    const badge = Array.from(host.querySelectorAll("div, span")).find((el) =>
      el.textContent?.trim() === "10 طقم",
    );
    expect(badge).toBeDefined();
    expect(badge?.className).toContain("whitespace-nowrap");
    expect(badge?.className).toContain("shrink-0");
  });

  it("يعرض تنبيه عنق الزجاجة ونقص رصيد المواد الخام عندما يكون السقف الممكن أقل من المطلوب", () => {
    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={vi.fn()}
          estimatedLaborCost="4000.00"
          estimatedMaterialsCost="20000.00"
          estimatedTotalCost="24000.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
          maxBundlesPossible={4}
          limitingFactorName="غلاف مقوى سلفان"
        />,
      );
    });

    expect(host.textContent).toContain("تحذير: نقص في رصيد المواد الخام بالفرع");
    expect(host.textContent).toContain("السقف الممكن حالياً هو 4 طقم");
    expect(host.textContent).toContain("غلاف مقوى سلفان");
  });

  it("لا يعرض تنبيه عنق الزجاجة عندما تكون المواد متوفرة بالكامل", () => {
    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={vi.fn()}
          estimatedLaborCost="4000.00"
          estimatedMaterialsCost="20000.00"
          estimatedTotalCost="24000.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
          maxBundlesPossible={10}
        />,
      );
    });

    expect(host.textContent).not.toContain("تحذير: نقص في رصيد المواد الخام بالفرع");
  });

  it("يعرض التكاليف بالأرقام اللاتينية ودينار عراقي دون أي أرقام مشرقية في ملخص التكلفة", () => {
    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={vi.fn()}
          estimatedLaborCost="4000.00"
          estimatedMaterialsCost="20000.00"
          estimatedTotalCost="24000.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
        />,
      );
    });

    const expectedTotalFmt = formatIqd("24000.00");
    expect(host.textContent).toContain(expectedTotalFmt);
    // التحقق من خلو نص التكلفة من الأرقام الهندية/المشرقية
    expect(/[٠-٩]/.test(expectedTotalFmt)).toBe(false);
  });

  it("يرسم جدول الدفعات برؤوس أعمدة مطابقة لعقد التنسيق وحساب الناتج السليم", () => {
    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={vi.fn()}
          estimatedLaborCost="4000.00"
          estimatedMaterialsCost="20000.00"
          estimatedTotalCost="24000.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
        />,
      );
    });

    const headers = host.querySelectorAll("thead th");
    expect(headers.length).toBe(6);
    headers.forEach((th) => {
      expect(th.className).toContain("whitespace-nowrap");
      expect(th.className).toContain("select-none");
    });

    // الصف الأول: كمية 10 - تالف 1 = ناتج سليم 9
    const row1 = host.querySelector("tbody tr:nth-child(1)");
    expect(row1?.textContent).toContain("دفتر تجارب علمية");
    expect(row1?.textContent).toContain("9"); // الناتج السليم
    expect(row1?.textContent).toContain(formatIqd("250.00"));
  });

  it("يمرر تحديث ملاحظات التشغيل بدقة إلى onNotesChange", () => {
    const handleNotesChange = vi.fn();

    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={handleNotesChange}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={vi.fn()}
          estimatedLaborCost="4000.00"
          estimatedMaterialsCost="20000.00"
          estimatedTotalCost="24000.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
        />,
      );
    });

    const notesInput = host.querySelector<HTMLInputElement>("#kit-notes");
    changeInput(notesInput!, "دفعة تجريبية خاصة");
    expect(handleNotesChange).toHaveBeenCalledWith("دفعة تجريبية خاصة");
  });

  it("يعرض تنبيهاً فارغاً عندما لا تتوفر أي دفعات محددة للإنتاج", () => {
    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم القرطاسية المتكامل"
          bundleSku="BUNDLE-STATIONERY"
          requestedBundleQty={10}
          components={mockComponents}
          batches={[]}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={vi.fn()}
          estimatedLaborCost="0.00"
          estimatedMaterialsCost="0.00"
          estimatedTotalCost="0.00"
          isSubmitting={false}
          onSubmit={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toContain("لم يتم اختيار أي مكونات مصنعة للإنتاج");
  });
});
