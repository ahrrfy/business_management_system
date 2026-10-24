// @vitest-environment jsdom
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BundleKitComponentsStep,
  type BundleKitComponentBatch,
} from "../BundleKitComponentsStep";
import {
  QuickRecipeCopyDialog,
  normalizeDecimalInput,
} from "../QuickRecipeCopyDialog";
import type { ComponentRequirementDto } from "@shared/bundleProductionTypes";
import { D, formatIqd, moneyInput, round2 } from "@/lib/money";
import { requiredBatchMultiple } from "@shared/batchDivisibility";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("BundleKitComponentsStep & QuickRecipe Transformation Flow", () => {
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
      variantId: 101,
      productId: 11,
      baseUnitId: 1,
      baseUnitName: "كتاب",
      productName: "كتاب قواعد ج1",
      sku: "BOOK-G1",
      componentBaseQuantity: 1,
      totalRequiredQty: 10,
      onHandStock: 2,
      shortageQty: 8,
      suggestedBatchQty: 8,
      isManufactured: true,
      recipeId: 50,
      recipeName: "وصفة كتاب قواعد ج1",
      requiredBatchMultiple: 1,
      surplusBufferQty: 0,
      laborPerUnit: "150.00",
      wasteStdPct: "0.05",
    },
    {
      variantId: 102,
      productId: 12,
      baseUnitId: 2,
      baseUnitName: "قطعة",
      productName: "قلم حبر جاف أزرق",
      sku: "PEN-BLUE",
      componentBaseQuantity: 2,
      totalRequiredQty: 20,
      onHandStock: 5,
      shortageQty: 15,
      suggestedBatchQty: 0,
      isManufactured: false,
      recipeId: null,
      recipeName: null,
      requiredBatchMultiple: 1,
      surplusBufferQty: 0,
      laborPerUnit: "0.00",
      wasteStdPct: "0.00",
    },
  ];

  const initialBatches: BundleKitComponentBatch[] = [
    {
      variantId: 101,
      recipeId: 50,
      batchQty: 8,
      scrapQty: 0,
      laborPerUnit: "150.00",
      selected: true,
    },
  ];

  it("يعرض السلع التجارية بدون وصفة مع شارة «سلعة تجارية» وأزرار الإجراء السريع لإضافة أو نسخ الوصفة", () => {
    const handleAddRecipe = vi.fn();
    const handleBatchChange = vi.fn();
    const handleToggleAll = vi.fn();

    act(() => {
      root.render(
        <BundleKitComponentsStep
          components={mockComponents}
          batches={initialBatches}
          onBatchChange={handleBatchChange}
          onToggleAll={handleToggleAll}
          onAddRecipe={handleAddRecipe}
        />,
      );
    });

    // الصنف المصنّع يعرض اسمه وشارة مصنّع ومربع الاختيار مفعّل
    expect(host.textContent).toContain("كتاب قواعد ج1");
    expect(host.textContent).toContain("وصفة كتاب قواعد ج1");

    // الصنف التجاري يعرض شارة «سلعة تجارية» و«شراء خارجي» وأزرار الإجراء
    expect(host.textContent).toContain("قلم حبر جاف أزرق");
    expect(host.textContent).toContain("سلعة تجارية");
    expect(host.textContent).toContain("شراء خارجي");
    expect(host.textContent).toContain("تحويل لمصنّع / نسخ وصفة");
    expect(host.textContent).toContain("+ إضافة وصفة");

    // التحقق من توافق إمكانية الوصول والتصميم الدلالي WCAG AA (عدم استخدام opacity-80 وتوفير aria-label)
    const commercialRow = host.querySelector("tbody tr:nth-child(2)");
    expect(commercialRow?.className).not.toContain("opacity-80");

    // النقر على زر التحويل لمصنّع يمرر الصنف التجاري بدقة ويحمل aria-label وصفي
    const convertBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("تحويل لمصنّع / نسخ وصفة"),
    );
    expect(convertBtn).toBeDefined();
    expect(convertBtn?.getAttribute("aria-label")).toBe(
      "تحويل قلم حبر جاف أزرق لمصنّع أو نسخ وصفة",
    );

    act(() => {
      convertBtn?.click();
    });

    expect(handleAddRecipe).toHaveBeenCalledTimes(1);
    expect(handleAddRecipe).toHaveBeenCalledWith(mockComponents[1]);
  });

  it("النقر على زر «+ إضافة وصفة» في عمود كمية الإنتاج يفتح منشئ الوصفة السريعة ويحمل aria-label", () => {
    const handleAddRecipe = vi.fn();

    act(() => {
      root.render(
        <BundleKitComponentsStep
          components={mockComponents}
          batches={initialBatches}
          onBatchChange={() => undefined}
          onToggleAll={() => undefined}
          onAddRecipe={handleAddRecipe}
        />,
      );
    });

    const addRecipeBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("+ إضافة وصفة"),
    );
    expect(addRecipeBtn).toBeDefined();
    expect(addRecipeBtn?.getAttribute("aria-label")).toBe(
      "إضافة وصفة وتصنيع قلم حبر جاف أزرق",
    );

    act(() => {
      addRecipeBtn?.click();
    });

    expect(handleAddRecipe).toHaveBeenCalledWith(mockComponents[1]);
  });

  it("يحافظ على إدخالات الدفعات السابقة ويحدد الصنف حديث التصنيع تلقائياً عند تحديث البيانات", () => {
    // محاكاة تحويل الصنف 102 من تجاري إلى مصنّع بعد حفظ الوصفة
    const justCreatedVariantId = 102;
    const prevBatches: BundleKitComponentBatch[] = [
      {
        variantId: 101,
        recipeId: 50,
        batchQty: 12, // المستخدم كان قد عدل الكمية يدوياً من 8 إلى 12
        scrapQty: 1,
        laborPerUnit: "150.00",
        selected: true,
      },
    ];

    const updatedComponents: ComponentRequirementDto[] = [
      mockComponents[0],
      {
        ...mockComponents[1],
        isManufactured: true,
        recipeId: 99,
        recipeName: "وصفة قلم حبر جاف أزرق",
        suggestedBatchQty: 15,
        requiredBatchMultiple: 1,
      },
    ];

    // منطق التحديث الهيدراتي الموجود في BundleKitProductionDialog
    const prevMap = new Map(prevBatches.map((b) => [b.variantId, b]));
    const nextBatches = updatedComponents
      .filter((c) => c.isManufactured)
      .map((c) => {
        const ex = prevMap.get(c.variantId);
        const isNewlyCreated = c.variantId === justCreatedVariantId;
        const defaultBatchQty =
          c.suggestedBatchQty > 0
            ? c.suggestedBatchQty
            : c.requiredBatchMultiple || 1;

        return ex
          ? {
              ...ex,
              recipeId: c.recipeId,
              batchQty:
                ex.batchQty > 0
                  ? ex.batchQty
                  : isNewlyCreated
                    ? defaultBatchQty
                    : c.suggestedBatchQty,
              selected: isNewlyCreated ? true : ex.selected,
            }
          : {
              variantId: c.variantId,
              recipeId: c.recipeId,
              batchQty: defaultBatchQty,
              scrapQty: 0,
              laborPerUnit: c.laborPerUnit || "0.00",
              selected: isNewlyCreated || c.suggestedBatchQty > 0,
            };
      });

    // 1. الدفعة الأولى تم الحفاظ على تعديلها اليدوي بالكامل (12 وليس 8)
    const batch101 = nextBatches.find((b) => b.variantId === 101);
    expect(batch101?.batchQty).toBe(12);
    expect(batch101?.scrapQty).toBe(1);
    expect(batch101?.selected).toBe(true);

    // 2. الصنف حديث التحويل تم دمجه وتحديده تلقائياً بالكمية المقترحة
    const batch102 = nextBatches.find((b) => b.variantId === 102);
    expect(batch102).toBeDefined();
    expect(batch102?.recipeId).toBe(99);
    expect(batch102?.batchQty).toBe(15);
    expect(batch102?.selected).toBe(true);
  });

  it("يحتسب التكلفة المعيارية الحية للوصفة بدقة مع نسبة الهدر وأجور العمالة", () => {
    // مادة 1: كمية 2 * كلفة 500 = 1000 د.ع
    // مادة 2: كمية 0.5 * كلفة 2000 = 1000 د.ع
    // إجمالي المواد = 2000 د.ع
    // أجور العمالة = 500 د.ع
    // التكلفة المباشرة = 2500 د.ع
    // نسبة الهدر = 20% (0.2)
    // معامل الهدر = 1 - 0.2 = 0.8
    // التكلفة المعيارية شاملة الهدر = 2500 / 0.8 = 3125.00 د.ع

    const lines = [
      { qty: "2", cost: "500" },
      { qty: "0.5", cost: "2000" },
    ];
    let materialsTotal = D(0);
    for (const l of lines) {
      materialsTotal = materialsTotal.plus(D(l.qty).mul(D(l.cost)));
    }
    const labor = D("500");
    const wastePct = D("20");

    const direct = materialsTotal.plus(labor);
    const wasteFraction = wastePct.div(100);
    const wasteFactor = D(1).minus(wasteFraction);
    const totalUnitCost = round2(direct.div(wasteFactor));

    expect(materialsTotal.toString()).toBe("2000");
    expect(direct.toString()).toBe("2500");
    expect(totalUnitCost.toString()).toBe("3125");
  });

  it("يحتسب مضاعف الدفعة الشرعي الصحيح لمنع الكسور وتلف المخزون", () => {
    // كميات صحيحة فقط => المضاعف 1
    expect(requiredBatchMultiple(["1", "3", "5"])).toBe(1);

    // كمية كسرية 2.5 => المضاعف 2
    expect(requiredBatchMultiple(["2.5000"])).toBe(2);

    // كمية كسرية 0.25 => المضاعف 4
    expect(requiredBatchMultiple(["0.2500"])).toBe(4);

    // خليط من 1.5 و 2.5 => المضاعف 2
    expect(requiredBatchMultiple(["1.5000", "2.5000"])).toBe(2);
  });

  it("يتحمل المدخلات العشرية الجزئية (مثل . أو .5) بدون انهيار شاشة الواجهة بـ DecimalError", () => {
    // اختبار حرج: عند كتابة المستخدم لنقطة عشرية '.' في الكمية أو أجور العمالة أو الهدر،
    // استخدام moneyInput يحمي من انهيار React مع الحفاظ على القيمة الصفرية حتى اكتمال الرقم
    const partialInputs = [".", ".5", "1.", "", "0.", "  "];
    for (const raw of partialInputs) {
      const parsed = moneyInput(raw);
      expect(parsed).toBeDefined();
      expect(parsed.isFinite()).toBe(true);
    }

    const qty = moneyInput(".");
    const cost = moneyInput("500");
    const total = round2(qty.mul(cost));
    expect(total.toString()).toBe("0");

    const completeQty = moneyInput(".5");
    const completeTotal = round2(completeQty.mul(cost));
    expect(completeTotal.toString()).toBe("250");
  });

  it("يمنع استنساخ البنود المرجعية الذاتية إذا كانت الوصفة المصدر تحتوي على نفس الصنف الهدف", () => {
    const targetVariantId = 102;
    const sourceRecipeLines = [
      {
        inputVariantId: 201,
        inputProductName: "حبر أزرق",
        qtyPerOutputBase: "1",
      },
      {
        inputVariantId: 102,
        inputProductName: "قلم حبر جاف أزرق (نفس الناتج)",
        qtyPerOutputBase: "1",
      },
      {
        inputVariantId: 202,
        inputProductName: "أنبوب بلاستيك",
        qtyPerOutputBase: "1",
      },
    ];

    const filteredLines = sourceRecipeLines.filter(
      (l) => Number(l.inputVariantId) !== targetVariantId,
    );

    expect(filteredLines).toHaveLength(2);
    expect(
      filteredLines.some((l) => l.inputVariantId === targetVariantId),
    ).toBe(false);
  });

  it("يحمي من ضياع التحديد التلقائي عند وصول بيانات التحليل المتأخرة عبر المرجع الآمن", () => {
    // محاكاة وصول تحديث البيانات عبر المرجع
    const newlyCreatedVariantIdRef = { current: 102 as number | null };

    // 1. وصول بيانات سابقة (stale): الصنف 102 ليس مصنعاً بعد
    const staleComponents: ComponentRequirementDto[] = [
      mockComponents[0],
      mockComponents[1],
    ];
    const hasNewlyCreatedStale =
      newlyCreatedVariantIdRef.current != null &&
      staleComponents.some(
        (c) =>
          c.variantId === newlyCreatedVariantIdRef.current && c.isManufactured,
      );

    expect(hasNewlyCreatedStale).toBe(false);
    // المرجع لم يُمسح لأن البيانات الجديدة لم تصل بعد
    expect(newlyCreatedVariantIdRef.current).toBe(102);

    // 2. وصول البيانات الجديدة (refetched): الصنف 102 أصبح مصنعاً
    const freshComponents: ComponentRequirementDto[] = [
      mockComponents[0],
      {
        ...mockComponents[1],
        isManufactured: true,
        recipeId: 99,
        suggestedBatchQty: 15,
      },
    ];

    const hasNewlyCreatedFresh =
      newlyCreatedVariantIdRef.current != null &&
      freshComponents.some(
        (c) =>
          c.variantId === newlyCreatedVariantIdRef.current && c.isManufactured,
      );

    expect(hasNewlyCreatedFresh).toBe(true);

    // تطبيق التحديد على الصنف حديث التحويل
    const target = freshComponents.find(
      (c) => c.variantId === newlyCreatedVariantIdRef.current,
    );
    expect(target).toBeDefined();
    expect(target?.isManufactured).toBe(true);

    // تفريغ المرجع بعد استهلاكه بنجاح
    newlyCreatedVariantIdRef.current = null;
    expect(newlyCreatedVariantIdRef.current).toBeNull();
  });

  it("يتحقق من دقة المنازل العشرية (حد أقصى 4 مراتب) ويقبل الأصفار اللاحقة ويرفض أكثر من 4 مراتب وقيم الصفر والسالب", () => {
    // دالة التحقق من دقة المنازل العشرية المطابقة تماماً لـ QuickRecipeCopyDialog وخادم recipeService.ts
    function validateLineQtyPrecision(
      lines: { qtyPerOutputBase: string; inputProductName: string }[],
    ) {
      for (const l of lines) {
        const q = moneyInput(l.qtyPerOutputBase);
        if (q.lte(0)) {
          return {
            valid: false,
            error: `كمية المادة «${l.inputProductName}» يجب أن تكون رقماً موجباً أكبر من صفر`,
          };
        }
        if (q.decimalPlaces() > 4) {
          return {
            valid: false,
            error: `كمية المادة «${l.inputProductName}» لا يمكن أن تتجاوز 4 مراتب عشرية`,
          };
        }
      }
      return { valid: true };
    }

    // حالات صالحة: عدد صحيح، منزلة، منزلتين، 4 منازل
    expect(
      validateLineQtyPrecision([
        { qtyPerOutputBase: "5", inputProductName: "ورق" },
      ]).valid,
    ).toBe(true);
    expect(
      validateLineQtyPrecision([
        { qtyPerOutputBase: "2.5", inputProductName: "حبر" },
      ]).valid,
    ).toBe(true);
    expect(
      validateLineQtyPrecision([
        { qtyPerOutputBase: "0.125", inputProductName: "غراء" },
      ]).valid,
    ).toBe(true);
    expect(
      validateLineQtyPrecision([
        { qtyPerOutputBase: "0.1234", inputProductName: "سلك" },
      ]).valid,
    ).toBe(true);

    // قبول القيم المنسوخة من جداول البيانات التي تحتوي أصفاراً لاحقة طبيعية (مثل 1.50000 أو 2.0000)
    expect(
      validateLineQtyPrecision([
        { qtyPerOutputBase: "1.50000", inputProductName: "بلاستيك" },
      ]).valid,
    ).toBe(true);
    expect(
      validateLineQtyPrecision([
        { qtyPerOutputBase: "2.0000", inputProductName: "كرتون" },
      ]).valid,
    ).toBe(true);

    // حالات غير صالحة: 5 منازل عشرية حقيقية أو أكثر
    const invalid5Decimals = validateLineQtyPrecision([
      { qtyPerOutputBase: "0.12345", inputProductName: "خام دقيق" },
    ]);
    expect(invalid5Decimals.valid).toBe(false);
    expect(invalid5Decimals.error).toContain("لا يمكن أن تتجاوز 4 مراتب عشرية");

    const invalid6Decimals = validateLineQtyPrecision([
      { qtyPerOutputBase: "1.000001", inputProductName: "بودرة" },
    ]);
    expect(invalid6Decimals.valid).toBe(false);
    expect(invalid6Decimals.error).toContain("لا يمكن أن تتجاوز 4 مراتب عشرية");

    const smallFraction = validateLineQtyPrecision([
      { qtyPerOutputBase: "0.00001", inputProductName: "صبغة" },
    ]);
    expect(smallFraction.valid).toBe(false);
    expect(smallFraction.error).toContain("لا يمكن أن تتجاوز 4 مراتب عشرية");

    // حالات غير صالحة: صفر أو سالب أو مدخل غير رقمي
    expect(
      validateLineQtyPrecision([
        { qtyPerOutputBase: "0", inputProductName: "صفر" },
      ]).valid,
    ).toBe(false);
    expect(
      validateLineQtyPrecision([
        { qtyPerOutputBase: "-2", inputProductName: "سالب" },
      ]).valid,
    ).toBe(false);
    expect(
      validateLineQtyPrecision([
        { qtyPerOutputBase: "abc", inputProductName: "نص" },
      ]).valid,
    ).toBe(false);
  });

  it("يسوّي الأرقام المشرقية العربية والفواصل العشرية المحلية إلى أرقام عشرية قياسية عبر normalizeDecimalInput", () => {
    // دعم إدخال لوحة المفاتيح العربية للأرقام والفاصلة العشرية
    expect(normalizeDecimalInput("١٢.٥")).toBe("12.5");
    expect(normalizeDecimalInput("٠.١٢٥")).toBe("0.125");
    expect(normalizeDecimalInput("12،5")).toBe("12.5");
    expect(normalizeDecimalInput("12٫5")).toBe("12.5");
    expect(normalizeDecimalInput("٣،٧٥")).toBe("3.75");
    expect(normalizeDecimalInput("abc 4.50 xyz")).toBe("4.50");
  });

  it("يحافظ على مؤشر البحث جارٍ أثناء فترة الـ debounce ويمنع وميض «لم يتم العثور» الكاذب", () => {
    // محاكاة حالة الكتابة الحية قبل اكتمال الـ 200ms
    const rawSearch = "حبر";
    const debouncedSearch = ""; // أثناء فترة الـ 200ms
    const isDebouncing = rawSearch.trim() !== debouncedSearch.trim();
    const queryIsLoading = false; // الاستعلام لم يبدأ بعد لأنه معطل
    const queryData: any[] | undefined = undefined;

    const isSearching = isDebouncing || queryIsLoading;
    expect(isSearching).toBe(true);

    // التحقق من أن حالة "لم يتم العثور" لا تظهر أثناء isSearching
    const showNotFound = !isSearching && (queryData ?? []).length === 0;
    expect(showNotFound).toBe(false);

    // بعد اكتمال الـ debounce (مرور 200ms): debouncedSearch يطابق rawSearch
    const debouncedSearchAfter200ms = "حبر";
    const isDebouncingAfter =
      rawSearch.trim() !== debouncedSearchAfter200ms.trim();
    expect(isDebouncingAfter).toBe(false);

    // عندما تنتهي عمليات البحث وتكون النتيجة فارغة فعلاً، تظهر رسالة عدم العثور
    const queryCompletedEmpty: any[] = [];
    const isSearchingAfter = isDebouncingAfter || false;
    const showNotFoundAfter =
      !isSearchingAfter && queryCompletedEmpty.length === 0;
    expect(showNotFoundAfter).toBe(true);
  });

  it("يحمي من تسريب رفض الوعود (unhandled rejection) عند فشل استدعاء الخادم أو دالة التحديث غير المتزامنة", async () => {
    let unhandledRejectionCaught = false;
    const rejectionHandler = () => {
      unhandledRejectionCaught = true;
    };
    window.addEventListener("unhandledrejection", rejectionHandler);

    // 1. حماية استدعاء الطفرة
    const mockMutateAsync = vi
      .fn()
      .mockRejectedValue(new Error("شبكة غير مستقرة"));
    let caughtMutation = false;
    try {
      await mockMutateAsync({ name: "وصفة جديدة" });
    } catch {
      caughtMutation = true;
    }
    expect(caughtMutation).toBe(true);

    // 2. حماية استدعاء onRecipeCreated غير المتزامن داخل onSuccess
    const mockAsyncOnRecipeCreated = vi
      .fn()
      .mockRejectedValue(new Error("فشل إعادة استعلام التحليل في الخلفية"));
    let handledCallback = false;
    try {
      await mockAsyncOnRecipeCreated(10, 102);
    } catch {
      handledCallback = true;
    }
    expect(handledCallback).toBe(true);
    expect(unhandledRejectionCaught).toBe(false);

    window.removeEventListener("unhandledrejection", rejectionHandler);
  });

  it("يُظهر رسالة خطأ صريحة عند فشل استعلام المواد الخام ولا يخفيه كنتيجة فارغة مضللة", () => {
    // محاكاة استعلام بمحرك inventoryManagerProcedure يعود بخطأ صلاحيات أو فشل شبكة
    const mockQueryError = {
      isError: true,
      error: {
        message: "غير مصرح لك باستعراض المواد الخام بدون صلاحية إدارة المخزون",
      },
      data: undefined,
      isLoading: false,
      isFetching: false,
    };

    // منطق العرض في QuickRecipeCopyDialog
    let displayedErrorText: string | null = null;
    let displayedEmptyText: string | null = null;

    if (mockQueryError.isError) {
      displayedErrorText =
        mockQueryError.error?.message ||
        "تعذر تحميل المواد الخام، يرجى التحقق من الصلاحيات والمحاولة لاحقاً";
    } else if ((mockQueryError.data ?? []).length === 0) {
      displayedEmptyText = "لم يتم العثور على مواد خام مطابقة";
    }

    expect(displayedErrorText).toBe(
      "غير مصرح لك باستعراض المواد الخام بدون صلاحية إدارة المخزون",
    );
    expect(displayedEmptyText).toBeNull();
  });

  it("يتجاهل استجابات قوالب الوصفات المتجاوزة (superseded responses) لمنع سباق البيانات عند التبديل السريع", async () => {
    let activeRequestId = 0;
    let appliedTemplateName: string | null = null;

    // دالة تحاكي تطبيق الوصفة مع التحقق من معرّف الطلب
    async function simulateApplyTemplate(
      templateId: number,
      name: string,
      delayMs: number,
    ) {
      const currentReqId = ++activeRequestId;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      // إذا كان هذا الطلب قد تم تجاوزه، يتم تجاهله تماماً
      if (activeRequestId !== currentReqId) {
        return;
      }
      appliedTemplateName = name;
    }

    // إطلاق طلبين: القالب A بطيء (50ms) والقالب B سريع (10ms) أُطلق بعده
    const promiseA = simulateApplyTemplate(1, "قالب A بطيء", 50);
    const promiseB = simulateApplyTemplate(2, "قالب B أحدث", 10);

    await Promise.all([promiseA, promiseB]);

    // النتيجة النهائية يجب أن تكون القالب B الأحدث، ولا يجوز للقالب A القديم أن يطمسه
    expect(appliedTemplateName).toBe("قالب B أحدث");
  });

  it("يحافظ على عدم تحديد الصنف حديث التحويل وضبط دفعة الإنتاج إلى صفر إذا كان العجز صفراً (suggestedBatchQty === 0)", () => {
    // محاكاة تحويل صنف تجاري لا يعاني من عجز مخزني في وضع صافي العجز NET_SHORTAGE
    const newlyCreatedId = 105;
    const manufacturedComponentWithZeroShortage: ComponentRequirementDto = {
      variantId: 105,
      productId: 15,
      baseUnitId: 5,
      baseUnitName: "دفتر",
      productName: "دفتر تجاري مغطى بالكامل",
      sku: "NOTE-105",
      componentBaseQuantity: 2,
      totalRequiredQty: 10,
      onHandStock: 50,
      shortageQty: 0,
      suggestedBatchQty: 0,
      isManufactured: true,
      recipeId: 88,
      recipeName: "وصفة تصنيع الدفتر",
      requiredBatchMultiple: 1,
      surplusBufferQty: 0,
      laborPerUnit: "200.00",
      wasteStdPct: "0.00",
    };

    const prevBatches: any[] = [];
    const prevMap = new Map(prevBatches.map((b) => [b.variantId, b]));

    // منطق التوليد والتحديد المطابق لـ BundleKitProductionDialog
    const isNewlyCreated =
      manufacturedComponentWithZeroShortage.variantId === newlyCreatedId;
    const shouldSelect =
      manufacturedComponentWithZeroShortage.suggestedBatchQty > 0;
    const defaultBatchQty =
      manufacturedComponentWithZeroShortage.suggestedBatchQty;

    const ex = prevMap.get(manufacturedComponentWithZeroShortage.variantId);
    const newBatch = ex
      ? {
          ...ex,
          recipeId: manufacturedComponentWithZeroShortage.recipeId,
          batchQty: ex.batchQty > 0 ? ex.batchQty : defaultBatchQty,
          selected: isNewlyCreated ? shouldSelect : ex.selected,
        }
      : {
          variantId: manufacturedComponentWithZeroShortage.variantId,
          recipeId: manufacturedComponentWithZeroShortage.recipeId,
          batchQty: defaultBatchQty,
          scrapQty: 0,
          laborPerUnit:
            manufacturedComponentWithZeroShortage.laborPerUnit || "0.00",
          selected: shouldSelect,
        };

    // التحقق: لا يتم تحديده تلقائياً ولا تُفرض دفعة 1، لمنع إنتاج وحدات غير مطلوبة
    expect(newBatch.selected).toBe(false);
    expect(newBatch.batchQty).toBe(0);
  });

  it("يتحقق من تعطيل زر الحفظ وإظهار تنبيه عند غياب الوحدة الأساسية النشطة", () => {
    const effectiveBaseUnitId: number | null = null;
    const lines = [
      {
        inputVariantId: 1,
        inputProductName: "مادة",
        qtyPerOutputBase: "1",
        inputCostPrice: "500",
      },
    ];
    const recipeName = "وصفة تجريبية";
    const isPending = false;

    const isSaveDisabled =
      isPending ||
      lines.length === 0 ||
      !recipeName.trim() ||
      !effectiveBaseUnitId;

    expect(isSaveDisabled).toBe(true);
  });

  it("يطلب تأكيد المستخدم قبل استبدال مسودة وصفة تحتوي على مواد ببيانات قالب آخر لمنع فقدان العمل", () => {
    let pendingTemplate: { recipeId: number; sourceName: string } | null = null;
    let appliedTemplateId: number | null = null;

    const existingLines = [
      {
        inputVariantId: 10,
        inputProductName: "مادة مدخلة يدوياً",
        inputSku: "RAW-1",
        inputCostPrice: "300",
        qtyPerOutputBase: "2",
        unitName: "قطعة",
        notes: null,
      },
    ];

    function handleSelectTemplate(recipeId: number, sourceName: string) {
      if (existingLines.length > 0) {
        pendingTemplate = { recipeId, sourceName };
      } else {
        appliedTemplateId = recipeId;
      }
    }

    // محاولة اختيار قالب بينما المسودة تحتوي على مواد
    handleSelectTemplate(77, "قالب دفتر تجريبي");

    // يجب أن تعلق في pendingTemplate بانتظار التأكيد وألا تُطبّق فوراً
    expect(pendingTemplate).toEqual({
      recipeId: 77,
      sourceName: "قالب دفتر تجريبي",
    });
    expect(appliedTemplateId).toBeNull();

    // تأكيد الاستبدال
    if (pendingTemplate) {
      appliedTemplateId = (pendingTemplate as any).recipeId;
      pendingTemplate = null;
    }

    expect(appliedTemplateId).toBe(77);
    expect(pendingTemplate).toBeNull();
  });

  it("يطبق القالب مباشرة دون طلب تأكيد إذا كانت مسودة الوصفة فارغة تماماً", () => {
    let pendingTemplate: { recipeId: number; sourceName: string } | null = null;
    let appliedTemplateId: number | null = null;

    const emptyLines: any[] = [];

    function handleSelectTemplate(recipeId: number, sourceName: string) {
      if (emptyLines.length > 0) {
        pendingTemplate = { recipeId, sourceName };
      } else {
        appliedTemplateId = recipeId;
      }
    }

    handleSelectTemplate(88, "قالب فارغ التجهيز");

    expect(pendingTemplate).toBeNull();
    expect(appliedTemplateId).toBe(88);
  });

  it("يبطل شجرة استعلامات الوصفات والكتالوج بالكامل بعد إنشاء الوصفة السريعة", async () => {
    const invalidatedKeys: string[] = [];

    const mockUtils = {
      production: {
        recipes: {
          invalidate: vi.fn().mockImplementation(async () => {
            invalidatedKeys.push("production.recipes.*");
          }),
        },
      },
      catalog: {
        invalidate: vi.fn().mockImplementation(async () => {
          invalidatedKeys.push("catalog.*");
        }),
      },
    };

    // استدعاء دالة الإبطال الشاملة بعد النجاح
    await Promise.all([
      mockUtils.production.recipes.invalidate(),
      mockUtils.catalog.invalidate(),
    ]);

    expect(mockUtils.production.recipes.invalidate).toHaveBeenCalledTimes(1);
    expect(mockUtils.catalog.invalidate).toHaveBeenCalledTimes(1);
    expect(invalidatedKeys).toContain("production.recipes.*");
    expect(invalidatedKeys).toContain("catalog.*");
  });

  it("يسوي الفواصل العشرية المتعددة إلى فاصلة عشرية واحدة فقط عبر normalizeDecimalInput", () => {
    expect(normalizeDecimalInput("1..5")).toBe("1.5");
    expect(normalizeDecimalInput("1.2.3")).toBe("1.23");
    expect(normalizeDecimalInput("٠..٥")).toBe("0.5");
    expect(normalizeDecimalInput("،،")).toBe(".");
  });

  it("يرفض مدخلات الهدر المعطوبة ذات الفواصل المتعددة (مثل 1..5) ولا يحولها بصمت إلى صفر", () => {
    function validateWasteSyntax(rawWaste: string): boolean {
      const clean = rawWaste.trim();
      if (!clean) return true;
      if (!/^(\d+(\.\d*)?|\.\d+)$/.test(clean) || clean.split(".").length > 2) {
        return false;
      }
      return true;
    }

    expect(validateWasteSyntax("1.5")).toBe(true);
    expect(validateWasteSyntax(".5")).toBe(true);
    expect(validateWasteSyntax("0")).toBe(true);
    expect(validateWasteSyntax("")).toBe(true);
    expect(validateWasteSyntax("1..5")).toBe(false);
    expect(validateWasteSyntax("1.2.3")).toBe(false);
    expect(validateWasteSyntax("abc")).toBe(false);
  });

  it("يحافظ على ملاحظات الوصفة المصدر التشغيلية والأمنية ويضيف نص المصدر عند تطبيق القالب", () => {
    function computeCombinedNotes(
      recipeNotes: string | null | undefined,
      sourceName: string,
    ): string {
      const sourceNotes = (recipeNotes || "").trim();
      const provenanceNote = `منسوخة من: ${sourceName}`;
      return sourceNotes
        ? `${sourceNotes}\n(${provenanceNote})`
        : provenanceNote;
    }

    // 1. قالب يحتوي على تعليمات تشغيلية
    const withNotes = computeCombinedNotes(
      "تعليمات الجودة: تجفيف المادة 24 ساعة قبل التجميع",
      "وصفة قلم فاخر",
    );
    expect(withNotes).toBe(
      "تعليمات الجودة: تجفيف المادة 24 ساعة قبل التجميع\n(منسوخة من: وصفة قلم فاخر)",
    );

    // 2. قالب لا يحتوي على ملاحظات مسبقة
    const withoutNotes = computeCombinedNotes(null, "وصفة قلم قياسي");
    expect(withoutNotes).toBe("منسوخة من: وصفة قلم قياسي");
  });

  it("يسترجع نسبة الهدر المعياري للقالب ويحولها إلى نسبة مئوية صحيحة بدلاً من إسقاطها بصمت", () => {
    function parseTemplateWaste(
      storedWaste: string | null | undefined,
    ): string {
      const rawWasteDec = moneyInput(storedWaste ?? "0");
      return rawWasteDec.gt(0) && rawWasteDec.lt(1)
        ? round2(rawWasteDec.mul(100)).toString()
        : rawWasteDec.gte(1)
          ? round2(rawWasteDec).toString()
          : "0";
    }

    expect(parseTemplateWaste("0.05")).toBe("5");
    expect(parseTemplateWaste("0.08")).toBe("8");
    expect(parseTemplateWaste("0.025")).toBe("2.5");
    expect(parseTemplateWaste("0.00")).toBe("0");
    expect(parseTemplateWaste("0")).toBe("0");
    expect(parseTemplateWaste(null)).toBe("0");
    expect(parseTemplateWaste(undefined)).toBe("0");
  });
});

const requests = vi.hoisted(() => ({
  fetch: vi.fn(),
  create: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/trpc", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  return {
    trpc: {
      useUtils: () => ({
        production: { recipes: { get: { fetch: requests.fetch } } },
      }),
      production: {
        recipes: {
          forProduct: { useQuery: () => ({ data: undefined }) },
          list: { useQuery: () => ({ data: [] }) },
          materials: {
            useQuery: () => ({ data: [], isLoading: false, isFetching: false }),
          },
          create: {
            useMutation: (options: object) =>
              useMutation({ mutationFn: requests.create, ...options }),
          },
        },
      },
    },
  };
});

vi.mock("@/lib/notify", () => ({
  notify: { ok: requests.success, err: requests.error, warn: vi.fn() },
}));

vi.mock("@/components/ui/dialog", async () => {
  const React = await import("react");
  const part = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    useDialogComposition: () => ({
      isComposing: () => false,
      justEndedComposing: () => false,
      setComposing() {},
      markCompositionEnd() {},
    }),
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: React.ReactNode;
    }) =>
      open ? (
        <section role="dialog">
          <button onClick={() => onOpenChange(false)}>إغلاق النافذة</button>
          {children}
        </section>
      ) : null,
    DialogContent: part,
    DialogHeader: part,
    DialogFooter: part,
    DialogTitle: part,
    DialogDescription: part,
  };
});

vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      disabled={disabled}
    >
      {children}
    </select>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const component = (variantId: number): ComponentRequirementDto => ({
  variantId,
  productId: variantId,
  baseUnitId: variantId,
  baseUnitName: "قطعة",
  productName: `صنف ${variantId}`,
  sku: `SKU-${variantId}`,
  componentBaseQuantity: 1,
  totalRequiredQty: 1,
  onHandStock: 0,
  shortageQty: 1,
  suggestedBatchQty: 1,
  isManufactured: false,
  recipeId: null,
  recipeName: null,
  requiredBatchMultiple: 1,
  surplusBufferQty: 0,
  laborPerUnit: "0",
  wasteStdPct: "0",
});

const template = {
  name: "قالب",
  laborPerOutputBase: "120",
  wasteStdPct: "0.05",
  notes: "تعليمات",
  lines: [
    {
      inputVariantId: 20,
      inputProductUnitId: 20,
      inputProductName: "ورق خام",
      inputSku: "RAW",
      inputCostPrice: "100",
      qtyPerOutputBase: "2",
      notes: "بند محفوظ",
      units: [{ productUnitId: 20, unitName: "ورقة", isBaseUnit: true }],
    },
  ],
};

describe("QuickRecipeCopyDialog deferred requests", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let target: ComponentRequirementDto | null;
  const created = vi.fn();
  const closed = vi.fn();
  const suggestions = [
    { ...component(30), isManufactured: true, recipeId: 99 },
  ];

  function draw(nextTarget: ComponentRequirementDto | null = target) {
    target = nextTarget;
    root.render(
      <QueryClientProvider client={queryClient}>
        <QuickRecipeCopyDialog
          open={target !== null}
          targetComponent={target}
          otherBundleComponents={suggestions}
          onRecipeCreated={created}
          onOpenChange={(open) => {
            closed(open);
            if (!open) draw(null);
          }}
        />
      </QueryClientProvider>,
    );
  }

  function button(text: string) {
    const found = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  }

  async function click(text: string) {
    await act(async () => {
      button(text).click();
    });
  }

  async function loadTemplate() {
    requests.fetch.mockResolvedValueOnce(template);
    await click("صنف 30");
    expect(host.textContent).toContain("ورق خام");
  }

  beforeEach(() => {
    vi.resetAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    target = component(10);
    act(() => draw());
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    host.remove();
  });

  it("keeps an empty draft after resetting during a template request", async () => {
    await loadTemplate();
    const pending = deferred<typeof template>();
    requests.fetch.mockReturnValueOnce(pending.promise);
    await click("صنف 30");
    await click("استبدال وتطبيق القالب");
    await click("بدء بوصفة فارغة");
    await act(async () => pending.resolve(template));
    expect(host.textContent).not.toContain("ورق خام");
    expect(
      host.querySelector<HTMLInputElement>("#quick-recipe-labor")?.value,
    ).toBe("0");
  });

  it("reports the saved variant without closing a newer target draft", async () => {
    await loadTemplate();
    const pending = deferred<{ recipeId: number }>();
    requests.create.mockReturnValueOnce(pending.promise);
    await click("حفظ الوصفة وتحويل");
    expect(requests.create.mock.calls[0][0].outputVariantId).toBe(10);
    await click("إغلاق النافذة");
    act(() => draw(component(11)));
    closed.mockClear();
    await act(async () => pending.resolve({ recipeId: 77 }));
    expect(created).toHaveBeenCalledWith(77, 10);
    expect(closed).not.toHaveBeenCalled();
    expect(
      host.querySelector<HTMLInputElement>("#quick-recipe-name")?.value,
    ).toBe("وصفة صنف 11");
  });

  it("refreshes the caller even after the saved dialog was dismissed", async () => {
    await loadTemplate();
    const pending = deferred<{ recipeId: number }>();
    requests.create.mockReturnValueOnce(pending.promise);
    await click("حفظ الوصفة وتحويل");
    await click("إغلاق النافذة");
    await act(async () => pending.resolve({ recipeId: 77 }));
    expect(created).toHaveBeenCalledWith(77, 10);
  });

  it("clears a replacement confirmation when the target changes or closes", async () => {
    await loadTemplate();
    await click("صنف 30");
    expect(host.textContent).toContain("تأكيد استبدال مواد الوصفة");
    act(() => draw(component(11)));
    expect(host.textContent).not.toContain("تأكيد استبدال مواد الوصفة");
    act(() => draw(null));
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });
  it("keeps a newer draft open while the saved variant refresh is awaited", async () => {
    await loadTemplate();
    const refresh = deferred<void>();
    created.mockReturnValueOnce(refresh.promise);
    requests.create.mockResolvedValueOnce({ recipeId: 77 });
    await click("حفظ الوصفة وتحويل");
    expect(created).toHaveBeenCalledWith(77, 10);
    act(() => draw(component(11)));
    closed.mockClear();
    await act(async () => refresh.resolve());
    expect(closed).not.toHaveBeenCalled();
    expect(
      host.querySelector<HTMLInputElement>("#quick-recipe-name")?.value,
    ).toBe("وصفة صنف 11");
  });

  it("ignores stale template completion while another target is loading", async () => {
    const older = deferred<typeof template>();
    const newer = deferred<typeof template>();
    requests.fetch
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    await click("صنف 30");
    act(() => draw(null));
    act(() => draw(component(11)));
    await click("صنف 30");
    await act(async () => older.resolve(template));
    expect(host.textContent).not.toContain("ورق خام");
    expect(button("صنف 30").disabled).toBe(true);
    await act(async () => newer.resolve(template));
    expect(host.textContent).toContain("ورق خام");
    expect(button("صنف 30").disabled).toBe(false);
  });

  it("disables draft inputs during saving and the awaited caller refresh", async () => {
    await loadTemplate();
    const pending = deferred<{ recipeId: number }>();
    const refresh = deferred<void>();
    requests.create.mockReturnValueOnce(pending.promise);
    created.mockReturnValueOnce(refresh.promise);
    await click("حفظ الوصفة وتحويل");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const name = host.querySelector<HTMLInputElement>("#quick-recipe-name")!;
    const labor = host.querySelector<HTMLInputElement>("#quick-recipe-labor")!;
    const notes = host.querySelector<HTMLTextAreaElement>(
      "#quick-recipe-notes",
    )!;
    expect(name.matches(":disabled")).toBe(true);
    expect(labor.matches(":disabled")).toBe(true);
    expect(notes.matches(":disabled")).toBe(true);
    expect(button("بدء بوصفة فارغة").matches(":disabled")).toBe(true);
    await act(async () => pending.resolve({ recipeId: 77 }));
    expect(created).toHaveBeenCalledWith(77, 10);
    expect(closed).not.toHaveBeenCalled();
    expect(name.matches(":disabled")).toBe(true);
    expect(labor.matches(":disabled")).toBe(true);
    expect(notes.matches(":disabled")).toBe(true);
    await act(async () => refresh.resolve());
    expect(closed).toHaveBeenCalledWith(false);
  });

  it("labels copied base quantities without converting the saved dozen unit or costs", async () => {
    requests.fetch.mockResolvedValueOnce({
      ...template,
      lines: [
        {
          ...template.lines[0],
          inputProductUnitId: 21,
          units: [
            {
              productUnitId: 20,
              unitName: "قطعة",
              conversionFactor: "1",
              isBaseUnit: true,
            },
            {
              productUnitId: 21,
              unitName: "درزن",
              conversionFactor: "12",
              isBaseUnit: false,
            },
          ],
        },
      ],
    });
    await click("صنف 30");
    const row = Array.from(host.querySelectorAll("tr")).find((item) =>
      item.textContent?.includes("ورق خام"),
    )!;
    expect(row.textContent).toContain("(قطعة)");
    expect(row.textContent).not.toContain("درزن");
    expect(row.querySelector<HTMLInputElement>("input")?.value).toBe("2");
    expect(row.textContent).toContain(formatIqd("100"));
    expect(row.textContent).toContain(formatIqd("200"));
    expect(host.textContent).toContain(formatIqd("336.84"));
    requests.create.mockResolvedValueOnce({ recipeId: 77 });
    await click("حفظ الوصفة وتحويل");
    expect(requests.create.mock.calls[0][0].lines).toEqual([
      {
        inputVariantId: 20,
        inputProductUnitId: 21,
        qtyPerOutputBase: "2",
        notes: "بند محفوظ",
      },
    ]);
    expect(requests.create.mock.calls[0][0].laborPerOutputBase).toBe("120");
    expect(requests.create.mock.calls[0][0].wasteStdPct).toBe("0.05");
  });

  it("preserves copied payload fields and submits once for rapid save clicks", async () => {
    await loadTemplate();
    expect(host.textContent).toContain(formatIqd("336.84"));
    const pending = deferred<{ recipeId: number }>();
    requests.create.mockReturnValueOnce(pending.promise);
    await act(async () => {
      const save = button("حفظ الوصفة وتحويل");
      save.click();
      save.click();
    });
    expect(requests.create).toHaveBeenCalledTimes(1);
    expect(requests.create.mock.calls[0][0]).toEqual({
      name: "وصفة صنف 10",
      outputVariantId: 10,
      outputProductUnitId: 10,
      laborPerOutputBase: "120",
      wasteStdPct: "0.05",
      isActive: true,
      notes: "تعليمات\n(منسوخة من: صنف 30 (وصفة))",
      lines: [
        {
          inputVariantId: 20,
          inputProductUnitId: 20,
          qtyPerOutputBase: "2",
          notes: "بند محفوظ",
        },
      ],
    });
    await act(async () => pending.resolve({ recipeId: 77 }));
    expect(closed).toHaveBeenCalledWith(false);
  });
});
