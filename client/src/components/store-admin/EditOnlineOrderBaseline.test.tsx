// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditOnlineOrderDialog } from "./EditOnlineOrderDialog";

const state = vi.hoisted(() => ({ detail: {} as any, latest: {} as any, refetchResult: {} as any, callbacks: {} as any, mutate: vi.fn(), confirm: vi.fn(), notifyErr: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ storeAdmin: { orders: { list: { invalidate: vi.fn() }, detail: { invalidate: vi.fn() }, counts: { invalidate: vi.fn() } } } }),
  storeAdmin: { orders: {
    detail: { useQuery: () => ({ data: state.detail, isLoading: false, isFetching: false, refetch: async () => state.refetchResult ?? { data: state.latest, status: "success" } }) },
    update: { useMutation: (callbacks: any) => { state.callbacks = callbacks; return { mutate: state.mutate, isPending: false }; } },
  }, settings: { get: { useQuery: () => ({ data: {} }) } } },
} }));
vi.mock("@/lib/confirm", () => ({ confirm: state.confirm }));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: state.notifyErr } }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: any) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>, DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>, DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, variant: _variant, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: (props: any) => <textarea {...props} /> }));
vi.mock("@/components/ui/label", () => ({ Label: (props: any) => <label {...props} /> }));
vi.mock("@/components/form/IntlPhoneInput", () => ({ IntlPhoneInput: ({ onChange, ...props }: any) => <input {...props} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: ({ onValueChange, children, ...props }: any) => <select {...props} onChange={(event) => onValueChange(event.target.value)}>{children}</select> }));
vi.mock("@/components/search/UnifiedProductSearch", () => ({ UnifiedProductSearch: () => null }));
vi.mock("./OrderCustomizationAssets", () => ({ OrderCustomizationAssets: () => null, splitShippingAddressAndNotes: () => ({}), resolveOrderShippingAddressAndNotes: (detail: any) => ({ shippingAddress: detail.addressText, notes: detail.customerNotes }) }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function frame(token: string, address: string) {
  return { id: 1, branchId: 1, orderNumber: "WEB-1", baselineFingerprint: token, customerName: "عميل", customerPhone: "07701234567", governorate: "baghdad", addressText: address, customerNotes: "ملاحظة أصلية", pricingBenefitDiscount: "0", couponDiscount: "0", deliveryZones: [], items: [{ id: 1, productUnitId: 1, productName: "دفتر", variantLabel: "أزرق", unitName: "قطعة", unitPrice: "1000", quantity: "2", hasCustomization: false }] };
}
let root: Root | undefined;
let container: HTMLDivElement;
const render = () => act(() => root!.render(<EditOnlineOrderDialog orderId={1} open onOpenChange={vi.fn()} />));
function button(text: string) { return Array.from(container.querySelectorAll("button")).find((node) => node.textContent === text)!; }
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.clearAllMocks(); });

describe("online order editor concurrency", () => {
  it("keeps the complete original frame and token on refetch/error, and reloads only after reviewing and confirming", async () => {
    state.detail = frame("a".repeat(64), "العنوان الأصلي");
    state.latest = frame("b".repeat(64), "عنوان الزميل");
    state.refetchResult = undefined;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container); render();
    const address = () => container.querySelector<HTMLInputElement>("#shipping-address")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(address(), "مسودتي"); address().dispatchEvent(new Event("input", { bubbles: true })); });
    state.detail = state.latest; render();
    expect(address().value).toBe("مسودتي");
    act(() => button("حفظ التعديلات وتحديث الحجز").click());
    expect(state.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ baselineFingerprint: "a".repeat(64), shippingAddress: "مسودتي" }));
    act(() => state.callbacks.onError({ data: { code: "CONFLICT" } }));
    expect(address().value).toBe("مسودتي");
    expect(button("حفظ التعديلات وتحديث الحجز").disabled).toBe(true);
    await act(async () => button("مراجعة أحدث بيانات الطلب").click());
    expect(container.textContent).toContain("عنوان الزميل");
    state.confirm.mockResolvedValueOnce(false);
    await act(async () => button("استبدال المسودة بالبيانات الأحدث").click());
    expect(address().value).toBe("مسودتي");
    state.confirm.mockResolvedValueOnce(true);
    await act(async () => button("استبدال المسودة بالبيانات الأحدث").click());
    expect(address().value).toBe("عنوان الزميل");
    act(() => button("حفظ التعديلات وتحديث الحجز").click());
    expect(state.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ baselineFingerprint: "b".repeat(64), shippingAddress: "عنوان الزميل" }));
  });

  it("does not publish cached data as latest when refetch fails", async () => {
    state.detail = frame("a".repeat(64), "العنوان الأصلي");
    state.latest = frame("b".repeat(64), "بيانات مخزنة قديمة");
    state.refetchResult = { data: state.latest, status: "error", error: new Error("offline") };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container); render();
    const address = () => container.querySelector<HTMLInputElement>("#shipping-address")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(address(), "مسودتي المحفوظة"); address().dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => state.callbacks.onError({ data: { code: "CONFLICT" } }));

    await act(async () => button("مراجعة أحدث بيانات الطلب").click());

    expect(container.textContent).not.toContain("بيانات مخزنة قديمة");
    expect(container.textContent).not.toContain("استبدال المسودة بالبيانات الأحدث");
    expect(address().value).toBe("مسودتي المحفوظة");
    expect(state.notifyErr).toHaveBeenCalledWith(expect.stringContaining("مسودتك محفوظة"));
    expect(button("حفظ التعديلات وتحديث الحجز").disabled).toBe(true);
    expect(state.mutate).not.toHaveBeenCalled();
  });
});
