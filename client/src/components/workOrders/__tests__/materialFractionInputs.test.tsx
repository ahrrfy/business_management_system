// @vitest-environment jsdom
import React, { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  save: vi.fn(),
  request: vi.fn(),
  confirmCancel: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: { me: { useQuery: () => ({ data: { id: 1, role: "admin" } }) } },
    catalog: { posList: { useQuery: () => ({ data: [], isFetching: false }) } },
    workOrders: {
      get: {
        useQuery: () => ({
          data: {
            status: "IN_PROGRESS",
            orderNumber: "WO-7",
            title: "خدمة",
            materials: [
              {
                id: 11,
                variantId: 9,
                productName: "خامة",
                baseQuantity: 0.1,
                unitCost: "0.01",
                lineCost: "0.01",
              },
            ],
          },
        }),
      },
      setMaterials: {
        useMutation: () => ({ mutate: state.save, isPending: false }),
      },
      requestControl: {
        useMutation: () => ({ mutate: state.request, isPending: false }),
      },
    },
    useUtils: () => ({}),
  },
}));
vi.mock("@/lib/lifecycleOperationAccess", () => ({
  canLifecycleOperation: () => true,
}));
vi.mock("@shared/operationPermissions", () => ({
  canViewOperationData: () => true,
}));
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("@/lib/notify", () => ({
  notify: { ok: vi.fn(), err: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/components/search/UnifiedSearchInput", () => ({
  UnifiedSearchInput: () => null,
}));
vi.mock("@/components/ui/dialog", () => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    useDialogComposition: () => ({}),
    Dialog: Wrap,
    DialogContent: Wrap,
    DialogDescription: Wrap,
    DialogFooter: Wrap,
    DialogHeader: Wrap,
    DialogTitle: Wrap,
  };
});
vi.mock("@/components/ui/RefundRailPicker", () => {
  const Picker = ({
    onStateChange,
  }: {
    onStateChange: (state: unknown) => void;
  }) => {
    useEffect(() => {
      queueMicrotask(() =>
        onStateChange({ needsCash: false, loading: false, error: null }),
      );
    }, [onStateChange]);
    return null;
  };
  return { RefundRailPicker: Picker, RefundRailPickerView: Picker };
});

import {
  WorkOrderMaterialsEditor,
  type EditableMaterial,
} from "../WorkOrderMaterialsEditor";
import CancelWorkOrderDialog, {
  CancelWorkOrderDialogById,
  type CancelMaterialRow,
} from "../../workorder/CancelWorkOrderDialog";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

describe("fractional work order material inputs", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  async function render(node: ReactNode) {
    await act(async () => root.render(node));
  }
  async function input(field: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(label: string) {
    const button = Array.from(host.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }
  function editor(
    initial: EditableMaterial[] = [
      { variantId: 9, productName: "خامة", sku: "MAT", baseQuantity: 1 },
    ],
    status = "RECEIVED",
  ) {
    return (
      <WorkOrderMaterialsEditor
        workOrderId={7}
        version={1}
        branchId={1}
        orderNumber="WO-7"
        status={status}
        initial={initial}
        onSaved={() => {}}
        onCancel={() => {}}
      />
    );
  }
  function cancel(
    material: CancelMaterialRow = {
      id: 11,
      name: "خامة",
      baseQuantity: 1.5,
      unitCost: "1000.00",
      lineCost: "1500.00",
    },
  ) {
    return (
      <CancelWorkOrderDialog
        open
        onOpenChange={() => {}}
        workOrderId={7}
        orderNumber="WO-7"
        title="خدمة"
        materials={[material]}
        onConfirm={state.confirmCancel}
      />
    );
  }
  it("preserves a typed 1.5 material quantity in the direct save payload", async () => {
    await render(editor());
    const quantity = host.querySelector<HTMLInputElement>(
      '[aria-label="كمية خامة"]',
    )!;
    await input(quantity, "1.5");
    expect(quantity.value).toBe("1.5");
    await input(
      host.querySelector<HTMLInputElement>(
        "#work-order-material-change-reason",
      )!,
      "تصحيح الاستهلاك",
    );
    await click("حفظ البنود");
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        materials: [{ variantId: 9, baseQuantity: 1.5 }],
      }),
    );
  });
  it("keeps a fractional material quantity in an approval request", async () => {
    await render(editor(undefined, "IN_PROGRESS"));
    await input(
      host.querySelector<HTMLInputElement>('[aria-label="كمية خامة"]')!,
      "1.5",
    );
    await input(
      host.querySelector<HTMLInputElement>(
        "#work-order-material-change-reason",
      )!,
      "تصحيح الاستهلاك",
    );
    await click("إرسال طلب تعديل البنود");
    expect(state.request).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { materials: [{ variantId: 9, baseQuantity: 1.5 }] },
      }),
    );
  });
  it("aggregates separate 0.1 and 0.2 lots to exactly 0.3", async () => {
    await render(
      editor(
        [0.1, 0.2].map((baseQuantity) => ({
          variantId: 9,
          productName: "خامة",
          sku: "MAT",
          baseQuantity,
        })),
      ),
    );
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="كمية خامة"]')?.value,
    ).toBe("0.3");
  });
  it("retains excessive precision visibly and blocks saving instead of truncating", async () => {
    await render(editor());
    const quantity = host.querySelector<HTMLInputElement>(
      '[aria-label="كمية خامة"]',
    )!;
    await input(quantity, "1.50001");
    await input(
      host.querySelector<HTMLInputElement>(
        "#work-order-material-change-reason",
      )!,
      "تصحيح الاستهلاك",
    );
    await click("حفظ البنود");
    expect(quantity.value).toBe("1.50001");
    expect(state.save).not.toHaveBeenCalled();
    expect(host.textContent).toContain("أربع منازل");
  });
  it("cancels with exact 0.1 waste and 1.4 returned from 1.5 consumed", async () => {
    await render(cancel());
    await click("العميل ألغى الطلب");
    const waste = host.querySelectorAll<HTMLInputElement>("input")[1]!;
    await input(waste, "0.1");
    expect(waste.value).toBe("0.1");
    await click("أكّد الإلغاء");
    expect(state.confirmCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        materials: [
          { workOrderMaterialId: 11, wasteBase: 0.1, returnBase: 1.4 },
        ],
      }),
    );
  });
  it("does not silently clamp an invalid waste quantity to consumed stock", async () => {
    await render(cancel());
    await click("العميل ألغى الطلب");
    await input(
      host.querySelectorAll<HTMLInputElement>("input")[1]!,
      "1.50001",
    );
    await click("أكّد الإلغاء");
    expect(state.confirmCancel).not.toHaveBeenCalled();
    expect(host.textContent).toContain("أربع منازل");
  });
  it("shows the saved one-cent residual when all remaining fractional material is wasted", async () => {
    await render(
      cancel({
        id: 11,
        name: "خامة",
        baseQuantity: 0.1,
        unitCost: "0.01",
        lineCost: "0.01",
      }),
    );
    await click("العميل ألغى الطلب");
    await input(host.querySelectorAll<HTMLInputElement>("input")[1]!, "0.1");
    expect(host.querySelectorAll("tbody td")[4]?.textContent).toBe("0.01");
    await click("أكّد الإلغاء");
    expect(state.confirmCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        materials: [{ workOrderMaterialId: 11, wasteBase: 0.1, returnBase: 0 }],
      }),
    );
  });
  it("keeps an authoritative zero value and assigns rounded return cents before waste", async () => {
    await render(
      cancel({
        id: 11,
        name: "خامة",
        baseQuantity: 0.2,
        unitCost: "1000.00",
        lineCost: "0.01",
      }),
    );
    await click("العميل ألغى الطلب");
    await input(host.querySelectorAll<HTMLInputElement>("input")[1]!, "0.1");
    expect(host.querySelectorAll("tbody td")[4]?.textContent).toBe("0");
    await render(
      cancel({
        id: 11,
        name: "خامة",
        baseQuantity: 0.2,
        unitCost: "1000.00",
        lineCost: "0.00",
      }),
    );
    expect(host.querySelectorAll("tbody td")[4]?.textContent).toBe("0");
  });
  it("blocks a visible fractional batch whose historical value snapshot is missing", async () => {
    await render(
      cancel({
        id: 11,
        name: "خامة",
        baseQuantity: 0.1,
        unitCost: "0.01",
        lineCost: null,
      }),
    );
    await click("العميل ألغى الطلب");
    await input(host.querySelectorAll<HTMLInputElement>("input")[1]!, "0.1");
    await click("أكّد الإلغاء");
    expect(state.confirmCancel).not.toHaveBeenCalled();
    expect(host.textContent).toContain("تعذّر تحديد كلفة الخامة");
  });
  it("keeps redacted costs unknown while allowing the server to validate cancellation", async () => {
    await render(
      cancel({
        id: 11,
        name: "خامة",
        baseQuantity: 0.1,
        unitCost: null,
        lineCost: null,
      }),
    );
    await click("العميل ألغى الطلب");
    await input(host.querySelectorAll<HTMLInputElement>("input")[1]!, "0.1");
    expect(host.querySelectorAll("tbody td")[4]?.textContent).toBe("—");
    await click("أكّد الإلغاء");
    expect(state.confirmCancel).toHaveBeenCalledOnce();
  });
  it("forwards the authoritative value when opening cancellation from an order ID", async () => {
    await render(
      <CancelWorkOrderDialogById
        workOrderId={7}
        onOpenChange={() => {}}
        onConfirm={state.confirmCancel}
      />,
    );
    await click("العميل ألغى الطلب");
    await input(host.querySelectorAll<HTMLInputElement>("input")[1]!, "0.1");
    expect(host.querySelectorAll("tbody td")[4]?.textContent).toBe("0.01");
    await click("أكّد الإلغاء");
    expect(state.confirmCancel).toHaveBeenCalledOnce();
  });
});
