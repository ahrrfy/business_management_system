// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  order: [] as string[],
}));

vi.mock("@/lib/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/components/search/UnifiedSearchInput", () => ({
  UnifiedSearchInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <input aria-label="بحث المنتجات" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    catalog: {
      customizationTemplate: {
        useQuery: () => ({ data: mocks.queryData, isSuccess: mocks.querySuccess, isError: !!mocks.queryError, error: mocks.queryError, refetch: mocks.refetch }),
      },
      categories: {
        useQuery: () => ({ data: [{ id: 2, name: "الأختام" }] }),
      },
      searchCustomizationTargets: {
        useQuery: (input: { categoryId?: number }) => input.categoryId
          ? { data: { items: [], total: 3, withTemplate: 1 }, isLoading: false, isFetching: false, isSuccess: true, refetch: vi.fn() }
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
    mocks.queryData = null;
    mocks.querySuccess = true;
    mocks.queryError = null;
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
});
