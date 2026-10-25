// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationUser } from "@shared/operationPermissions";

import { ProductCustomizationTemplateEditor } from "./ProductCustomizationTemplateEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  save: vi.fn(),
  copy: vi.fn(),
  refetch: vi.fn(),
  queryData: null as unknown,
  querySuccess: true,
  queryError: null as Error | null,
  previewError: false,
  order: [] as string[],
  user: { role: "manager" } as OperationUser,
}));

vi.mock("@/lib/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/components/search/UnifiedSearchInput", () => ({
  UnifiedSearchInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <input aria-label="بحث المنتجات" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: { me: { useQuery: () => ({ data: mocks.user, isLoading: false }) } },
    catalog: {
      customizationTemplate: {
        useQuery: () => ({ data: mocks.queryData, isSuccess: mocks.querySuccess, isError: !!mocks.queryError, error: mocks.queryError, refetch: mocks.refetch }),
      },
      categories: {
        useQuery: () => ({ data: [{ id: 2, name: "الأختام" }] }),
      },
      searchCustomizationTargets: {
        useQuery: (input: { categoryId?: number }) => input.categoryId
          ? { data: { items: [], total: 3, withTemplate: 1 }, isLoading: false, isFetching: false, isSuccess: !mocks.previewError, isError: mocks.previewError, refetch: vi.fn() }
          : { data: { items: [], total: 0, withTemplate: 0 }, isLoading: false, isFetching: false, isSuccess: true, refetch: vi.fn() },
      },
      saveCustomizationTemplate: {
        useMutation: (options?: { onSuccess?: (result: unknown) => void }) => ({ mutate: vi.fn(), mutateAsync: async (input: unknown) => {
          const result = await mocks.save(input);
          options?.onSuccess?.(result);
          return result;
        }, isPending: false }),
      },
      copyCustomizationTemplate: {
        useMutation: (options?: { onSuccess?: (result: unknown) => void }) => ({ mutateAsync: async (input: unknown) => {
          const result = await mocks.copy(input);
          options?.onSuccess?.(result);
          return result;
        }, isPending: false }),
      },
      setCustomizationTemplateActive: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

function byText<T extends Element>(root: ParentNode, selector: string, text: string): T {
  const element = Array.from(root.querySelectorAll<T>(selector)).find((candidate) => candidate.textContent?.includes(text));
  if (!element) throw new Error(`Missing ${selector} containing ${text}`);
  return element;
}

async function openCategoryCopy(host: HTMLElement, overwrite: boolean) {
  await act(async () => byText<HTMLButtonElement>(host, "button", "نسخ هذا القالب").click());
  const categoryRadio = byText<HTMLLabelElement>(host, "label", "فئة كاملة").querySelector<HTMLInputElement>("input")!;
  await act(async () => categoryRadio.click());
  const categorySelect = Array.from(host.querySelectorAll<HTMLSelectElement>("select"))
    .find((select) => Array.from(select.options).some((option) => option.text === "اختر الفئة"))!;
  await act(async () => {
    categorySelect.value = "2";
    categorySelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  if (overwrite) {
    const overwriteInput = byText<HTMLLabelElement>(host, "label", "استبدال القوالب الموجودة")
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => overwriteInput.click());
  }
}

describe("محرر قالب تخصيص المنتج", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    mocks.order.length = 0;
    mocks.user = { role: "manager" };
    mocks.queryData = null;
    mocks.querySuccess = true;
    mocks.queryError = null;
    mocks.previewError = false;
    mocks.refetch.mockReset();
    mocks.confirm.mockReset().mockResolvedValue(true);
    mocks.save.mockReset().mockImplementation(async () => {
      mocks.order.push("save");
      return { id: 20 };
    });
    mocks.copy.mockReset().mockImplementation(async () => {
      mocks.order.push("copy");
      return { sourceTemplateId: 20, matched: 3, copied: 3, skipped: 0 };
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<ProductCustomizationTemplateEditor productId={1} enabled />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("يؤكد الاستبدال الجماعي ويرسل حفظ المصدر والنسخ كعملية ذرية واحدة", async () => {
    await openCategoryCopy(host, true);
    await act(async () => byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة").click());

    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "استبدال تخصيص فئة كاملة؟",
      description: expect.stringContaining("سيُستبدل 1 قالب موجود"),
    }));
    expect(mocks.order).toEqual(["copy"]);
    expect(mocks.copy).toHaveBeenCalledWith(expect.objectContaining({
      sourceProductId: 1,
      sourceTemplate: expect.objectContaining({ productId: 1, expectedTemplateId: null, kind: "GENERAL" }),
      scope: "CATEGORY",
      categoryId: 2,
      expectedMatched: 3,
      expectedExisting: 1,
      overwriteExisting: true,
    }));
  });

  it("لا يبدأ العملية الذرية إذا ألغى الموظف تأكيد الاستبدال", async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    await openCategoryCopy(host, true);
    await act(async () => byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة").click());

    expect(mocks.order).toEqual([]);
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("يمنع النسخ المستقل عندما يفوض الدور حفظ القالب وحده", async () => {
    mocks.user = { role: "manager", operationPolicyEnabled: true, roleOperationPolicy: { version: 1, grants: { "operation.catalog.saveCustomizationTemplate": true } } };
    await act(async () => root.render(<ProductCustomizationTemplateEditor productId={1} enabled />));
    await openCategoryCopy(host, false);
    const button = byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة");
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("يفتح النسخ المفوض لمستخدم من دور مختلف دون توسيع صلاحية الحفظ", async () => {
    mocks.user = { role: "cashier", operationPolicyEnabled: true, roleOperationPolicy: { version: 1, grants: { "operation.catalog.copyCustomizationTemplate": true } } };
    await act(async () => root.render(<ProductCustomizationTemplateEditor productId={1} enabled />));
    await openCategoryCopy(host, false);
    const button = byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة");
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("لا يمحو تعديلاً بدأ بعد إرسال النسخ عندما يصل تحديث الخلفية", async () => {
    let finishCopy!: (value: { sourceTemplateId: number; matched: number; copied: number; skipped: number }) => void;
    mocks.copy.mockImplementationOnce(() => new Promise((resolve) => { finishCopy = resolve; }));
    await openCategoryCopy(host, false);
    act(() => byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة").click());

    const titleInput = byText<HTMLLabelElement>(host, "label", "العنوان الذي يراه الزبون").querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(titleInput, "تعديل بدأ بعد الإرسال");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(titleInput.value).toBe("تعديل بدأ بعد الإرسال");
    await act(async () => finishCopy({ sourceTemplateId: 20, matched: 3, copied: 3, skipped: 0 }));

    mocks.queryData = {
      id: 20,
      productId: 1,
      kind: "GENERAL",
      title: "العنوان الذي أُرسل أولاً",
      description: null,
      isActive: true,
      fields: [],
    };
    await act(async () => root.render(<ProductCustomizationTemplateEditor productId={1} enabled />));

    expect(byText<HTMLLabelElement>(host, "label", "العنوان الذي يراه الزبون").querySelector<HTMLInputElement>("input")!.value)
      .toBe("تعديل بدأ بعد الإرسال");
  });

  it("يعرض فشل التحميل الأول مع إعادة المحاولة بدلاً من تحميل دائم", async () => {
    mocks.querySuccess = false;
    mocks.queryError = new Error("تعذر الاتصال بالخادم");
    await act(async () => root.render(<ProductCustomizationTemplateEditor productId={2} enabled />));

    expect(host.textContent).toContain("تعذّر تحميل قالب التخصيص");
    expect(host.textContent).toContain("تعذر الاتصال بالخادم");
    await act(async () => byText<HTMLButtonElement>(host, "button", "إعادة المحاولة").click());
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it("يعزل وجهات النسخ والرسائل عند الانتقال إلى منتج آخر أثناء النسخ", async () => {
    let finish!: (result: unknown) => void;
    mocks.copy.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await openCategoryCopy(host, false);
    act(() => byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة").click());
    await act(async () => root.render(<ProductCustomizationTemplateEditor productId={2} enabled />));
    expect(host.textContent).not.toContain("الفئة المستهدفة");
    await act(async () => finish({ sourceTemplateId: 20, copied: 3, skipped: 0 }));
    expect(host.textContent).not.toContain("تم نسخ القالب");
  });

  it("يقفل الحفظ والتفعيل مع النسخ ولا يرسل نسخاً مكرراً أثناء التأكيد", async () => {
    let finish!: (value: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await openCategoryCopy(host, true);
    const copy = byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة");
    act(() => copy.click());
    expect(byText<HTMLButtonElement>(host, "button", "حفظ قالب التخصيص").disabled).toBe(true);
    expect(byText<HTMLLabelElement>(host, "label", "يظهر للزبون").querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    act(() => copy.click());
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
    expect(mocks.copy).toHaveBeenCalledTimes(1);
  });

  it("يعرض فشل تحديث معاينة الفئة ولا يقدم الأرقام المخزنة كمعاينة حديثة", async () => {
    await openCategoryCopy(host, false);
    mocks.previewError = true;
    await act(async () => root.render(<ProductCustomizationTemplateEditor productId={1} enabled />));
    expect(host.textContent).toContain("تعذّر تحديث معاينة الفئة");
    expect(byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة").disabled).toBe(true);
  });

  it("لا يرسل عملية المنتج القديم بعد تأكيد متأخر", async () => {
    let finish!: (value: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await openCategoryCopy(host, true);
    act(() => byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة").click());
    await act(async () => root.render(<ProductCustomizationTemplateEditor productId={2} enabled />));
    await act(async () => finish(true));
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("يفك القفل عند إلغاء التأكيد", async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    await openCategoryCopy(host, true);
    await act(async () => byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة").click());
    expect(byText<HTMLButtonElement>(host, "button", "حفظ قالب التخصيص").disabled).toBe(false);
  });

  it("يحفظ هوية وتركيز حقل المفتاح التقني أثناء الكتابة", async () => {
    const input = byText<HTMLLabelElement>(host, "label", "المفتاح التقني").querySelector<HTMLInputElement>("input")!;
    input.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "custom_key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("custom_key");
  });

  it("لا يعتبر التعديل أثناء تأكيد النسخ محفوظاً عند تحديث الخلفية", async () => {
    let finish!: (value: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await openCategoryCopy(host, true);
    act(() => byText<HTMLButtonElement>(host, "button", "حفظ ونسخ إلى الفئة").click());
    const title = byText<HTMLLabelElement>(host, "label", "العنوان الذي يراه الزبون").querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "تعديل أثناء التأكيد");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => finish(true));
    mocks.queryData = { id: 20, productId: 1, kind: "GENERAL", title: "القيمة المرسلة", description: null, isActive: true, fields: [] };
    await act(async () => root.render(<ProductCustomizationTemplateEditor productId={1} enabled />));
    expect(title.value).toBe("تعديل أثناء التأكيد");
    expect(mocks.copy.mock.calls[0][0].sourceTemplate.title).not.toBe("تعديل أثناء التأكيد");
  });
});
