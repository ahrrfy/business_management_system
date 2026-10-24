// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AiProductContentAssistant } from "../AiProductContentAssistant";
import type { AiProductDraft, ProductFacts } from "@shared/productContentAi";
const state = vi.hoisted(() => ({
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
  options: {} as Record<string, any>,
  denied: new Set<string>(),
  history: [] as any[],
  invalidate: vi.fn(),
  queryOptions: undefined as any,
}));
vi.mock("@/lib/catalogPeopleOperationAccess", () => ({
  useCatalogPeopleOperationAccess: () => ({
    can: (path: string) => !state.denied.has(path),
  }),
}));
vi.mock("@/lib/trpc", async () => {
  const React = await import("react");
  function mutation(name: string, options?: any) {
    const [pending, setPending] = React.useState(false);
    state.options[name] = options;
    const run = async (variables: unknown) => {
      setPending(true);
      try {
        const result = await state.calls[name](variables);
        await state.options[name]?.onSuccess?.(result, variables);
        return result;
      } finally {
        setPending(false);
      }
    };
    return {
      isPending: pending,
      error: null,
      mutateAsync: run,
      mutate: (variables: unknown, callbacks?: any) => {
        void run(variables)
          .then((result) => callbacks?.onSuccess?.(result, variables))
          .catch(() => {});
      },
    };
  }
  return {
    trpc: {
      useUtils: () => ({
        catalog: { listContentDrafts: { invalidate: state.invalidate } },
      }),
      catalog: {
        generateContentDraft: {
          useMutation: (options: any) => mutation("generate", options),
        },
        validateContentDraft: {
          useMutation: (options: any) => mutation("validate", options),
        },
        saveContentDraft: {
          useMutation: (options: any) => mutation("save", options),
        },
        decideContentDraft: {
          useMutation: (options: any) => mutation("decide", options),
        },
        listContentDrafts: {
          useQuery: (_input: unknown, options: unknown) => {
            state.queryOptions = options;
            return {
              data: state.history,
              isLoading: false,
              isError: false,
              refetch: state.invalidate,
            };
          },
        },
      },
    },
  };
});
const facts: ProductFacts = {
  finalProductName: "دفتر",
  inputDescription: null,
  category: "قرطاسية",
  productType: "دفتر",
  brand: null,
  modelName: null,
  attributes: {},
  variants: [],
  saleUnits: [],
  verifiedClaims: [],
  audience: null,
};
const draft: AiProductDraft = {
  seoTitle: "دفتر",
  shortTitle: "دفتر",
  posLabel: "دفتر",
  invoiceLabel: "دفتر",
  marketingCopy: "",
  description: "وصف قديم",
  keywords: ["قرطاسية"],
  claims: [],
  unsupportedClaims: [],
  warnings: [],
  confidence: "high",
};
const generated = () => ({
  draft,
  validation: { ok: true, blockers: [], warnings: [] },
  cacheHit: false,
  imagesUsed: 0,
  cacheKey: "a".repeat(64),
  model: "mock",
  promptVersion: "test",
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
let root: Root,
  host: HTMLDivElement,
  props: React.ComponentProps<typeof AiProductContentAssistant>;
const render = () =>
  act(() => root.render(<AiProductContentAssistant {...props} />));
const button = (text: string) =>
  Array.from(host.querySelectorAll("button")).find((node) =>
    node.textContent?.includes(text),
  );
const generate = async () => {
  await act(async () => button("اقتراح المحتوى")!.click());
};
const edit = (field: string, value: string) =>
  act(() => {
    const input = host.querySelector(`textarea[id$="${field}"]`)!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("React", React);
  state.denied.clear();
  state.history = [];
  state.calls = {
    generate: vi.fn().mockResolvedValue(generated()),
    validate: vi
      .fn()
      .mockResolvedValue({ ok: true, blockers: [], warnings: [] }),
    save: vi.fn().mockResolvedValue({ draftId: 10 }),
    decide: vi.fn().mockResolvedValue({}),
  };
  state.options = {};
  state.invalidate.mockReset();
  props = { productId: 1, facts, onApply: vi.fn() };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("does not save an old generation under a newly selected product", async () => {
  const pending = deferred<ReturnType<typeof generated>>();
  state.calls.generate.mockReturnValue(pending.promise);
  render();
  await generate();
  props.productId = 2;
  render();
  await act(async () => pending.resolve(generated()));
  expect(state.calls.save).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")).toBeNull();
});
it("does not apply another product's draft when its facts happen to match", async () => {
  render();
  await generate();
  props.productId = 2;
  render();
  expect(button("تطبيق المسودة")).toBeUndefined();
  expect(host.querySelector("textarea")).toBeNull();
});
it("requires validation of the current edited text, not an earlier validation response", async () => {
  render();
  await generate();
  edit("description", "نص أول");
  const pending = deferred<{
    ok: boolean;
    blockers: string[];
    warnings: string[];
  }>();
  state.calls.validate.mockReturnValue(pending.promise);
  await act(async () => button("إعادة التحقق")!.click());
  edit("description", "نص أحدث");
  await act(async () =>
    pending.resolve({ ok: true, blockers: [], warnings: [] }),
  );
  expect(button("تطبيق المسودة")!.disabled).toBe(true);
});
it("shows existing history without requiring a paid generation", () => {
  state.history = [
    {
      id: 22,
      status: "DRAFT",
      validation: { ok: true, blockers: [], warnings: [] },
    },
  ];
  render();
  expect(host.textContent).toContain("تاريخ المسودات");
  expect(host.textContent).toContain("#22");
  expect(state.calls.generate).not.toHaveBeenCalled();
});
it("does not autosave without the specific save permission", async () => {
  state.denied.add("catalog.saveContentDraft");
  render();
  await generate();
  expect(state.calls.save).not.toHaveBeenCalled();
});
it("hides cached history when its read permission is revoked", async () => {
  state.history = [
    {
      id: 22,
      status: "DRAFT",
      validation: { ok: true, blockers: [], warnings: [] },
    },
  ];
  render();
  await generate();
  state.denied.add("catalog.listContentDrafts");
  render();
  expect(host.textContent).not.toContain("#22");
});
it("ignores a generation response after its source facts change", async () => {
  const pending = deferred<ReturnType<typeof generated>>();
  state.calls.generate.mockReturnValue(pending.promise);
  render();
  await generate();
  props.facts = { ...facts, brand: "ماركة أخرى" };
  render();
  await act(async () => pending.resolve(generated()));
  expect(host.querySelector("textarea")).toBeNull();
  expect(state.calls.save).not.toHaveBeenCalled();
});
it("locks duplicate generation clicks before React updates the button", async () => {
  const pending = deferred<ReturnType<typeof generated>>();
  state.calls.generate.mockReturnValue(pending.promise);
  render();
  const submit = button("اقتراح المحتوى")!;
  await act(async () => {
    submit.click();
    submit.click();
  });
  expect(state.calls.generate).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(generated()));
});
it("invalidates the saved product and does not attach its saved ID to the next product", async () => {
  const pending = deferred<{ draftId: number }>();
  state.calls.save.mockReturnValue(pending.promise);
  render();
  await generate();
  props.productId = 2;
  render();
  await act(async () => pending.resolve({ draftId: 77 }));
  expect(state.calls.save.mock.calls[0][0].productId).toBe(1);
  expect(state.invalidate).toHaveBeenCalledWith({ productId: 1 });
  expect(host.textContent).not.toContain("#77");
});
it("clears the saved badge after edits and applies the exact newly validated draft", async () => {
  render();
  await generate();
  expect(host.textContent).toContain("#10");
  edit("description", "وصف مصحح");
  expect(host.textContent).not.toContain("#10");
  await act(async () => button("إعادة التحقق")!.click());
  expect(button("تطبيق المسودة")!.disabled).toBe(false);
  act(() => button("تطبيق المسودة")!.click());
  expect(props.onApply).toHaveBeenCalledWith({
    ...draft,
    description: "وصف مصحح",
  });
  expect(state.calls.validate).toHaveBeenCalledWith({
    facts,
    draft: { ...draft, description: "وصف مصحح" },
  });
});
it("blocks generated text that exceeds the channel save limit without truncation or a failed autosave", async () => {
  const long = "س".repeat(121);
  state.calls.generate.mockResolvedValue({
    ...generated(),
    draft: { ...draft, posLabel: long },
  });
  render();
  await generate();
  expect(state.calls.save).not.toHaveBeenCalled();
  expect(button("تطبيق المسودة")!.disabled).toBe(true);
  const pos = host.querySelector(
    'textarea[id$="posLabel"]',
  ) as HTMLTextAreaElement;
  expect(pos.value).toBe(long);
  expect(pos.maxLength).toBe(120);
  expect(host.textContent).toContain("يتجاوز 120");
});
it("locks duplicate history decisions and uses the requested draft ID", async () => {
  state.history = [
    {
      id: 22,
      status: "DRAFT",
      validation: { ok: true, blockers: [], warnings: [] },
    },
  ];
  const pending = deferred<object>();
  state.calls.decide.mockReturnValue(pending.promise);
  render();
  const approve = button("اعتماد")!;
  await act(async () => {
    approve.click();
    approve.click();
  });
  expect(state.calls.decide).toHaveBeenCalledTimes(1);
  expect(state.calls.decide.mock.calls[0][0]).toMatchObject({
    draftId: 22,
    decision: "APPROVED",
  });
  await act(async () => pending.resolve({}));
});
it("shows a failed history decision before any draft has been generated", async () => {
  state.history = [
    {
      id: 22,
      status: "DRAFT",
      validation: { ok: true, blockers: [], warnings: [] },
    },
  ];
  state.calls.decide.mockRejectedValue(new Error("رفض الخادم القرار"));
  render();
  await act(async () => button("اعتماد")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "تعذر تحديث قرار المسودة",
  );
  expect(state.calls.generate).not.toHaveBeenCalled();
});
it("keeps a history decision failure visible when only the product facts change", async () => {
  state.history = [
    {
      id: 22,
      status: "DRAFT",
      validation: { ok: true, blockers: [], warnings: [] },
    },
  ];
  const pending = deferred<object>();
  state.calls.decide.mockImplementation(() =>
    pending.promise.then(() => {
      throw new Error("رفض الخادم القرار");
    }),
  );
  render();
  await act(async () => button("اعتماد")!.click());
  props.facts = { ...facts, brand: "ماركة جديدة" };
  render();
  await act(async () => pending.resolve({}));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "تعذر تحديث قرار المسودة",
  );
});
