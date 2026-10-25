// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StorePushCampaignManager from "../StorePushCampaignManager";

const state = vi.hoisted(() => ({ pending: [] as any[], errors: [] as any[], ok: vi.fn(), retry: vi.fn(), invalidate: vi.fn(), data: [] as any[], isError: false, isLoading: false }));
vi.mock("@/lib/notify", () => ({ notify: { ok: state.ok, err: (error: any) => state.errors.push(error) } }));
vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: ({ onValueChange, children, ...props }: any) => <select {...props} onChange={(event) => onValueChange(event.target.value)}>{children}</select> }));
vi.mock("@/lib/trpc", () => {
  function useMutation(name: string, options: any = {}) {
    const [isPending, setPending] = React.useState(false);
    const mutateAsync = (payload: any) => {
      setPending(true);
      return new Promise((resolve, reject) => state.pending.push({ name, payload, finish: async () => { await options.onSuccess?.(); setPending(false); resolve({ ok: true }); }, fail: (error: any) => { options.onError?.(error); setPending(false); reject(error); } }));
    };
    return { isPending, mutateAsync, mutate: (payload: any) => { void mutateAsync(payload).catch(() => {}); } };
  }
  return { trpc: {
    useUtils: () => ({ storeAdmin: { notifications: { list: { invalidate: state.invalidate } } } }),
    storeAdmin: { notifications: {
      list: { useQuery: () => ({ data: state.data, isLoading: state.isLoading, isError: state.isError, error: { message: "تعذر تحميل الحملات" }, isFetching: false, refetch: state.retry }) },
      create: { useMutation: (options: any) => useMutation("create", options) },
      approve: { useMutation: (options: any) => useMutation("approve", options) },
      schedule: { useMutation: (options: any) => useMutation("schedule", options) },
      cancel: { useMutation: (options: any) => useMutation("cancel", options) },
    } },
  } };
});
(globalThis as any).React = React;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  state.pending = []; state.errors = []; state.ok.mockClear(); state.invalidate.mockResolvedValue(undefined);
  state.isError = false; state.isLoading = false;
  state.data = [{ id: 1, name: "حملة للمراجعة", status: "APPROVED", title: "عرض", destination: "/", kind: "MARKETING", recipientCount: 0, sentCount: 0, clickedCount: 0, openedCount: 0 }];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<StorePushCampaignManager />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
it("does not offer transactional manual campaigns that the service rejects", () => {
  expect(document.querySelector('option[value="TRANSACTIONAL"]')).toBeNull();
});
it("blocks scheduling while cancellation is pending", async () => {
  await act(async () => button("إلغاء").click());
  expect(button("جدولة").disabled).toBe(true);
  act(() => button("جدولة").click()); expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  await act(async () => state.pending[0].finish());
});
it("disables the entire draft while it is being saved", async () => {
  const inputs = [...host.querySelectorAll<HTMLInputElement>("input")];
  await fill(inputs[0], "حملة جديدة");
  await fill(inputs.find((input) => input.maxLength === 80)!, "عنوان العرض");
  await fill(host.querySelector("textarea")!, "تفاصيل العرض");
  act(() => button("حفظ كمسودة").click());
  expect(state.pending[0].payload.kind).toBe("MARKETING");
  expect(host.querySelector("fieldset")?.disabled).toBe(true);
  await act(async () => state.pending[0].finish());
  expect(inputs[0].value).toBe("");
});
it("locks the schedule date and all row actions until scheduling settles", async () => {
  act(() => button("جدولة").click());
  const date = document.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
  await fill(date, "2099-01-01T12:00"); act(() => button("تأكيد الجدولة").click());
  expect(date.disabled).toBe(true); expect(button("إلغاء").disabled).toBe(true);
  expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
  await act(async () => state.pending[0].finish());
  expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
});
it("does not send an invalid future date", async () => {
  act(() => button("جدولة").click());
  await fill(document.querySelector('input[type="datetime-local"]')!, "2000-01-01T12:00");
  act(() => button("تأكيد الجدولة").click());
  expect(state.pending).toHaveLength(0); expect(state.errors).toHaveLength(1);
});
it("keeps stale campaign actions blocked after a query error", async () => {
  state.isError = true; await act(async () => root.render(<StorePushCampaignManager />));
  expect(button("جدولة").disabled).toBe(true); expect(button("إلغاء").disabled).toBe(true);
  expect(host.textContent).toContain("تعذر تحميل الحملات");
});
it("unlocks actions and keeps the draft after a failed create", async () => {
  const inputs = [...host.querySelectorAll<HTMLInputElement>("input")];
  await fill(inputs[0], "حملة جديدة"); await fill(inputs.find((input) => input.maxLength === 80)!, "عنوان العرض");
  await fill(host.querySelector("textarea")!, "تفاصيل العرض"); act(() => button("حفظ كمسودة").click());
  await act(async () => state.pending[0].fail(new Error("فشل الطلب")));
  expect(host.querySelector("fieldset")!.disabled).toBe(false); expect(inputs[0].value).toBe("حملة جديدة");
  expect(state.errors).toHaveLength(1);
});
it("holds the writer lock until the refreshed list settles", async () => {
  let finishRefresh!: () => void;
  state.invalidate.mockReturnValue(new Promise<void>((resolve) => { finishRefresh = resolve; }));
  act(() => button("إلغاء").click()); await act(async () => state.pending[0].finish());
  expect(button("جدولة").disabled).toBe(true);
  await act(async () => finishRefresh()); expect(button("جدولة").disabled).toBe(false);
});
