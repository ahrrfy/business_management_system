// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { EditWorkOrderDialog } from "./EditWorkOrderDialog";
import { WorkOrderMaterialsEditor } from "./WorkOrderMaterialsEditor";
import PurchaseEdit from "@/pages/PurchaseEdit";
import { editorDate } from "@/lib/editorDate";
import { confirm } from "@/lib/confirm";

const mock = vi.hoisted(() => ({ wo: {} as any, po: {} as any, preflight: {} as any, preflightError: null as Error | null, direct: true, detailRefetch: vi.fn(), preflightRefetch: vi.fn(), update: vi.fn(), materials: vi.fn(), request: vi.fn(), purchase: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  auth: { me: { useQuery: () => ({ data: { id: 1, role: "admin" } }) } },
  workOrders: {
    get: { useQuery: () => ({ data: mock.wo, refetch: mock.detailRefetch }) },
    controlPreflight: { useQuery: () => ({ data: mock.preflight && { ...mock.preflight, controlRequired: { commercial: !mock.direct } }, error: mock.preflightError, refetch: mock.preflightRefetch }) },
    update: { useMutation: () => ({ mutate: mock.update }) },
    setMaterials: { useMutation: () => ({ mutate: mock.materials }) },
    requestControl: { useMutation: () => ({ mutate: mock.request }) },
  },
  catalog: { posList: { useQuery: () => ({ data: [] }) } },
  purchases: { get: { useQuery: () => ({ data: mock.po }) }, priceInsights: { useQuery: () => ({ data: [] }) }, updateOrder: { useMutation: () => ({ mutate: mock.purchase }) } },
  suppliers: { list: { useQuery: () => ({ data: [] }) } },
  useUtils: () => ({}),
} }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("wouter", () => ({ useParams: () => ({ id: "1" }), useLocation: () => ["", vi.fn()], Link: ({ children }: any) => <span>{children}</span> }));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("@/hooks/useUnsavedGuard", () => ({ useUnsavedGuard: vi.fn(), bypassUnsavedGuard: vi.fn() }));
vi.mock("@/components/CustomerPicker", () => ({ default: () => null }));
vi.mock("@/components/ui/spinner", () => ({ Spinner: () => null }));
vi.mock("@/components/form/IntlPhoneInput", () => ({ IntlPhoneInput: () => null }));
vi.mock("@/components/form/MoneyInput", () => ({ MoneyInput: ({ value, onChange }: any) => <input value={value} onChange={e => onChange(e.target.value)} /> }));
vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: ({ value, onValueChange, children }: any) => <select value={value} onChange={e => onValueChange(e.target.value)}>{children}</select> }));
vi.mock("@/components/ui/dialog", () => {
  const Wrap = ({ children }: any) => <div>{children}</div>;
  return { useDialogComposition: () => ({}), Dialog: Wrap, DialogContent: Wrap, DialogHeader: Wrap, DialogFooter: Wrap, DialogDescription: Wrap, DialogTitle: Wrap };
});
vi.mock("@/components/search/UnifiedSearchInput", () => ({ UnifiedSearchInput: () => null }));
vi.mock("@/components/purchases/PurchaseTenderField", () => ({
  PurchaseTenderField: () => null, purchaseTenderDraft: () => ({}),
  usePurchaseTenderState: () => ({ reset: vi.fn(), draft: {}, preservingLegacy: false, payload: null, validationError: null, isActionBlocked: false }),
}));
vi.mock("@/components/invoice", async importOriginal => {
  const actual = await importOriginal<any>();
  const Empty = () => null;
  return { ...actual, InvoiceHeader: Empty, ProductTable: Empty, TotalsPanel: Empty, BulkPicker: Empty, ShortcutsBar: Empty, SupplierInvoiceMatch: Empty,
    TermsAndNotes: ({ state, dispatch }: any) => <input aria-label="purchase notes" value={state.notes} onChange={e => dispatch({ type: "SET_FIELD", field: "notes", value: e.target.value })} />,
    ActionButtons: ({ onAction }: any) => <button onClick={() => onAction("save")}>test save purchase</button> };
});

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); mock.direct = true; mock.preflightError = null;
  mock.preflight = { workOrderId: 1, version: 1 };
  mock.wo = { id: 1, version: 1, status: "RECEIVED", title: "original", salePrice: "100", deposit: "0", dueDate: new Date("2026-10-28T00:00:00Z") };
  mock.po = { id: 1, version: 1, status: "DRAFT", poNumber: "PO1", branchId: 1, supplierId: 2, agreedCurrency: "IQD", settlementType: "CREDIT", notes: "original", items: [{ variantId: 3, productUnitId: 4, quantity: "1", conversionFactor: "1", unitPrice: "100" }] };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(node: React.ReactNode) { await act(async () => root.render(node)); }
async function input(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function click(text: string) { const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!; expect(button).toBeTruthy(); await act(async () => button.click()); }
const dialog = () => <EditWorkOrderDialog workOrderId={1} onClose={() => {}} onSaved={() => {}} />;
it("roundtrips a DATE while saving another field", async () => {
  await render(dialog()); await input(container.querySelector("input")!, "typed"); await input(container.querySelectorAll("textarea")[1]!, "reason"); await click("حفظ التعديل");
  expect(mock.update).toHaveBeenCalledWith(expect.objectContaining({ title: "typed", dueDate: "2026-10-28", expectedVersion: 1 }));
});
it.each([
  [1, 2, 1, 1, "preflight"],
  [1, 1, 1, 2, "detail"],
  [1, 2, 99, 2, "preflight"],
  [99, 2, 1, 2, "detail"],
] as const)("waits for a coherent requested-order snapshot (detail=%s/v%s, preflight=%s/v%s)", async (detailId, detailVersion, preflightId, preflightVersion, refreshSide) => {
  mock.wo = { ...mock.wo, id: detailId, version: detailVersion, status: "IN_PROGRESS" };
  mock.preflight = { workOrderId: preflightId, version: preflightVersion };
  await render(dialog());
  expect(container.querySelector("input")).toBeNull();
  expect(container.textContent).toContain("تطابق");
  await render(dialog()); await render(dialog());
  expect(refreshSide === "preflight" ? mock.preflightRefetch : mock.detailRefetch).toHaveBeenCalledTimes(1);
  expect(refreshSide === "preflight" ? mock.detailRefetch : mock.preflightRefetch).not.toHaveBeenCalled();
  mock.wo = { ...mock.wo, id: 1, version: 2 };
  mock.preflight = { workOrderId: 1, version: 2 }; mock.direct = false;
  await render(dialog());
  await input(container.querySelector("input")!, "typed");
  await input(container.querySelectorAll("textarea")[1]!, "reason"); await click("إرسال طلب التعديل");
  expect(mock.update).not.toHaveBeenCalled();
  expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 2, payload: expect.objectContaining({ title: "typed" }) }));
});
it.each(["detail", "preflight"])("preserves the coherent draft while %s arrives alone, and reload waits for its matching pair", async first => {
  await render(dialog()); await input(container.querySelector("input")!, "typed");
  await input(container.querySelectorAll("textarea")[1]!, "reason");
  if (first === "detail") mock.wo = { ...mock.wo, version: 2, title: "latest", status: "IN_PROGRESS" };
  else { mock.preflight = { workOrderId: 1, version: 2 }; mock.direct = false; }
  await render(dialog());
  expect(container.querySelector("input")!.value).toBe("typed");
  await click("حفظ التعديل");
  expect(mock.update).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, title: "typed" }));
  await click("تحميل الأحدث وإلغاء تعديلاتي");
  expect(container.querySelector("input")!.value).toBe("typed");
  expect(container.querySelectorAll("textarea")[1]!.value).toBe("reason");
  mock.wo = { ...mock.wo, version: 2, title: "latest", status: "IN_PROGRESS" };
  mock.preflight = { workOrderId: 1, version: 2 }; mock.direct = false;
  await render(dialog());
  expect(container.querySelector("input")!.value).toBe("latest");
  expect(container.querySelectorAll("textarea")[1]!.value).toBe("");
  await input(container.querySelectorAll("textarea")[1]!, "reason"); await click("إرسال طلب التعديل");
  expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 2 }));
});
it("reads the latest coherent pair after asynchronous reload confirmation", async () => {
  await render(dialog()); await input(container.querySelector("input")!, "typed");
  mock.wo = { ...mock.wo, version: 2, title: "second" }; mock.preflight = { workOrderId: 1, version: 2 }; await render(dialog());
  let resolveConfirmation!: (value: boolean) => void;
  vi.mocked(confirm).mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveConfirmation = resolve; }));
  await click("تحميل الأحدث وإلغاء تعديلاتي");
  mock.wo = { ...mock.wo, version: 3, title: "third", status: "IN_PROGRESS" };
  mock.preflight = { workOrderId: 1, version: 3 }; mock.direct = false; await render(dialog());
  await act(async () => resolveConfirmation(true));
  expect(container.querySelector("input")!.value).toBe("third");
  await input(container.querySelectorAll("textarea")[1]!, "reason"); await click("إرسال طلب التعديل");
  expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 3 }));
});
it("resets the baseline on entity changes even when the intermediate order has no coherent pair", async () => {
  await render(dialog()); await input(container.querySelector("input")!, "typed");
  await render(<EditWorkOrderDialog workOrderId={2} onClose={() => {}} onSaved={() => {}} />);
  expect(container.querySelector("input")).toBeNull();
  mock.wo = { ...mock.wo, version: 2, title: "latest", status: "IN_PROGRESS" };
  mock.preflight = { workOrderId: 1, version: 2 }; mock.direct = false;
  await render(dialog());
  expect(container.querySelector("input")!.value).toBe("latest");
  await input(container.querySelectorAll("textarea")[1]!, "reason"); await click("إرسال طلب التعديل");
  expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 2 }));
});
it("keeps failed routing reads recoverable with bounded automatic refresh and an explicit retry", async () => {
  mock.preflightError = new Error("offline");
  await render(dialog()); await render(dialog());
  expect(container.querySelector("input")).toBeNull();
  expect(mock.preflightRefetch).toHaveBeenCalledTimes(1);
  await click("إعادة المحاولة"); expect(mock.preflightRefetch).toHaveBeenCalledTimes(2);
  mock.preflightError = null; await render(dialog());
  expect(container.querySelector("input")!.value).toBe("original");
});
it.each([true, false])("dialog freezes data/version across refetch (direct=%s), explicit reload replaces both", async direct => {
  mock.direct = direct; await render(dialog()); await input(container.querySelector("input")!, "typed");
  mock.wo = { ...mock.wo, version: 2, title: "latest", salePrice: "150" }; mock.preflight = { workOrderId: 1, version: 2 }; await render(dialog());
  expect(container.querySelector("input")!.value).toBe("typed");
  await input(container.querySelectorAll("textarea")[1]!, "reason"); await click(direct ? "حفظ التعديل" : "إرسال طلب التعديل");
  expect(direct ? mock.update : mock.request).toHaveBeenCalledWith(expect.objectContaining(direct ? { expectedVersion: 1, salePrice: "100.00" } : { baseVersion: 1, payload: expect.objectContaining({ salePrice: "100.00" }) }));
  await click("تحميل الأحدث وإلغاء تعديلاتي"); expect(container.querySelector("input")!.value).toBe("latest");
  await input(container.querySelectorAll("textarea")[1]!, "reason"); await click(direct ? "حفظ التعديل" : "إرسال طلب التعديل");
  expect((direct ? mock.update : mock.request).mock.lastCall![0][direct ? "expectedVersion" : "baseVersion"]).toBe(2);
});
it("materials preserve original diff, version and consumption semantics until deliberate reload", async () => {
  const props = { workOrderId: 1, version: 1, status: "RECEIVED", branchId: 1, orderNumber: "WO1", initial: [{ variantId: 1, baseQuantity: 2, productName: "Paper", sku: "P" }], onSaved: () => {}, onCancel: () => {} };
  await render(<WorkOrderMaterialsEditor {...props} />); await input(container.querySelector('[aria-label="كمية Paper"]')!, "3");
  const latest = { ...props, version: 2, status: "IN_PROGRESS", initial: [{ ...props.initial[0]!, baseQuantity: 5 }] };
  await render(<WorkOrderMaterialsEditor {...latest} />);
  expect(container.textContent).toContain("Paper: 2 ← 3"); await input(container.querySelector("#work-order-material-change-reason")!, "reason"); await click("حفظ البنود");
  expect(mock.materials).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, materials: [{ variantId: 1, baseQuantity: 3 }] }));
  await click("تحميل الأحدث وإلغاء تعديلاتي"); expect((container.querySelector('[aria-label="كمية Paper"]') as HTMLInputElement).value).toBe("5");
  await input(container.querySelector('[aria-label="كمية Paper"]')!, "6"); await input(container.querySelector("#work-order-material-change-reason")!, "reason"); await click("إرسال طلب تعديل البنود");
  expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 2 }));
});
it("purchase retains revision identity and draft on refetch, then explicitly reloads latest", async () => {
  await render(<PurchaseEdit />); await input(container.querySelector('[aria-label="purchase notes"]')!, "typed");
  mock.po = { ...mock.po, version: 2, notes: "latest" }; await render(<PurchaseEdit />);
  expect((container.querySelector('[aria-label="purchase notes"]') as HTMLInputElement).value).toBe("typed");
  await input(container.querySelector("textarea")!, "reason"); await click("test save purchase");
  expect(mock.purchase).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, notes: expect.stringContaining("typed") }));
  await click("تحميل الأحدث وإلغاء تعديلاتي"); expect((container.querySelector('[aria-label="purchase notes"]') as HTMLInputElement).value).toBe("latest");
  await input(container.querySelector("textarea")!, "reason"); await click("test save purchase");
  expect(mock.purchase.mock.lastCall![0].expectedVersion).toBe(2);
});
it("preserves typed input when latest revision becomes terminal and reload is declined", async () => {
  await render(dialog()); await input(container.querySelector("input")!, "typed");
  mock.wo = { ...mock.wo, version: 2, status: "DELIVERED", title: "latest" }; mock.preflight = { workOrderId: 1, version: 2 }; await render(dialog());
  expect(container.querySelector("input")!.value).toBe("typed");
  vi.mocked(confirm).mockResolvedValueOnce(false); await click("تحميل الأحدث وإلغاء تعديلاتي");
  expect(container.querySelector("input")!.value).toBe("typed");
  await click("تحميل الأحدث وإلغاء تعديلاتي"); expect(container.textContent).toContain("هذا الطلب مُسلَّم أو مُلغى");
});
it("rehydrates the same dialog after closing and opening, and resets the reason", async () => {
  await render(dialog()); await input(container.querySelector("input")!, "typed");
  await render(<EditWorkOrderDialog workOrderId={null} onClose={() => {}} onSaved={() => {}} />);
  mock.wo = { ...mock.wo, version: 2, title: "latest" }; mock.preflight = { workOrderId: 1, version: 2 }; await render(dialog());
  expect(container.querySelector("input")!.value).toBe("latest");
  expect(container.querySelectorAll("textarea")[1]!.value).toBe("");
});
it("rehydrates materials when changing the actual entity", async () => {
  const props = { workOrderId: 1, version: 1, status: "RECEIVED", branchId: 1, orderNumber: "WO1", initial: [{ variantId: 1, baseQuantity: 2, productName: "Paper", sku: "P" }], onSaved: () => {}, onCancel: () => {} };
  await render(<WorkOrderMaterialsEditor {...props} />); await input(container.querySelector('[aria-label="كمية Paper"]')!, "3");
  await render(<WorkOrderMaterialsEditor {...props} workOrderId={2} version={7} initial={[{ ...props.initial[0]!, baseQuantity: 9 }]} />);
  expect((container.querySelector('[aria-label="كمية Paper"]') as HTMLInputElement).value).toBe("9");
});
it.each([null, "2026-10-28", "2026-10-28T00:00:00.000Z", new Date("2026-10-28T00:00:00Z")])("encodes the DATE contract independently of local timezone: %s", value => {
  expect(editorDate(value)).toBe(value == null ? "" : "2026-10-28");
});
