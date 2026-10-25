// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OfflineSyncChip } from "../OfflineSyncChip";
vi.mock("@/components/ui/popover", async () => {
  const React = await import("react");
  const Context = React.createContext({
    open: false,
    onOpenChange: (_open: boolean) => {},
  });
  return {
    Popover: ({ open, onOpenChange, children }: any) => (
      <Context.Provider value={{ open, onOpenChange }}>
        {children}
      </Context.Provider>
    ),
    PopoverTrigger: ({ children }: any) => {
      const value = React.useContext(Context);
      return React.cloneElement(children, {
        onClick: () => value.onOpenChange(!value.open),
      });
    },
    PopoverContent: ({
      children,
      className,
      dir,
      "aria-labelledby": labelledBy,
    }: any) => {
      const value = React.useContext(Context);
      return value.open ? (
        <div
          role="dialog"
          className={className}
          dir={dir}
          aria-labelledby={labelledBy}
        >
          {children}
        </div>
      ) : null;
    },
  };
});
const state = vi.hoisted(() => ({
  conn: "online",
  userId: 7 as number | null,
  summary: {
    queued: 0,
    parked: 1,
    sentRecent: 0,
    queuedTotal: 0,
    flushing: false,
    needsLogin: false,
  },
  item: {
    clientRequestId: "request-48",
    kind: "RECEPTION",
    payload: { clientRequestId: "request-48", total: "1250.25" },
    offlineReceiptNumber: "OFF-48",
    capturedAt: "2026-10-25T10:00:00Z",
    capturedByUserId: 7,
    shiftId: 4,
    branchId: 2,
    status: "PARKED",
    attempts: 1,
    lastError: null,
    total: "1250.25",
  },
  profile: {
    userId: 7,
    name: "موظف الاستقبال",
    role: "admin",
    branchId: 2,
    hasPin: true,
  } as any,
  replay: vi.fn(),
  requeue: vi.fn(),
  setPin: vi.fn(),
  flush: vi.fn(),
  setEnabled: vi.fn(),
  persist: vi.fn(),
  routes: {
    SALE: vi.fn(),
    PRINT_SALE: vi.fn(),
    RECEPTION: vi.fn(),
    RETURN: vi.fn(),
  },
  invalidate: vi.fn(),
  utils: null as any,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => state.utils,
    auth: { me: { useQuery: () => ({ data: { id: state.userId } }) } },
  },
}));
vi.mock("@/lib/offline/connectivity", () => ({
  useConnectivity: () => state.conn,
  connectivity: { get: () => state.conn, subscribe: () => () => {} },
}));
vi.mock("@/lib/offline/outbox", () => ({
  readOutboxSummary: async () => state.summary,
  listOutboxItems: async () => [state.item],
  subscribeOutbox: () => () => {},
  flushOutbox: (...args: any[]) => state.flush(...args),
  getDeviceCode: async () => "DEVICE-48",
  isOfflineSaleEnabled: async () => true,
  setOfflineSaleEnabled: (...args: any[]) => state.setEnabled(...args),
  replayParkedWithApproval: (...args: any[]) => state.replay(...args),
  requeueParkedItem: (...args: any[]) => state.requeue(...args),
}));
vi.mock("@/lib/offline/db", () => ({
  getMeta: async () => "0",
  requestPersistentStorage: () => state.persist(),
}));
vi.mock("@/lib/offline/pinLock", () => ({
  getOfflineProfile: async () => state.profile,
  setOfflinePin: (...args: any[]) => state.setPin(...args),
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("React", React);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  state.conn = "online";
  state.userId = 7;
  state.item.kind = "RECEPTION";
  state.profile = {
    userId: 7,
    name: "موظف الاستقبال",
    role: "admin",
    branchId: 2,
    hasPin: true,
  };
  for (const fn of [
    state.replay,
    state.requeue,
    state.setPin,
    state.flush,
    state.setEnabled,
    state.persist,
    ...Object.values(state.routes),
    state.invalidate,
  ])
    fn.mockReset();
  state.replay.mockResolvedValue({ ok: true });
  state.requeue.mockResolvedValue(undefined);
  state.setPin.mockResolvedValue({ ok: true });
  state.flush.mockResolvedValue(undefined);
  state.setEnabled.mockResolvedValue(undefined);
  state.persist.mockResolvedValue(true);
  for (const route of Object.values(state.routes))
    route.mockResolvedValue({ invoiceId: 48, invoiceNumber: "INV48" });
  state.utils = {
    client: {
      offline: {
        replaySale: { mutate: state.routes.SALE },
        replayPrintSale: { mutate: state.routes.PRINT_SALE },
        replayReception: { mutate: state.routes.RECEPTION },
        replayReturn: { mutate: state.routes.RETURN },
      },
    },
    catalog: { posList: { invalidate: state.invalidate } },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<OfflineSyncChip userRole="admin" />));
}
function button(text: string) {
  const el = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((node) => node.textContent?.trim() === text);
  if (!el) throw Error("Button missing: " + text);
  return el;
}
async function click(el: HTMLElement) {
  await act(async () => el.click());
}
async function open() {
  await click(host.querySelector("button")!);
}
async function settings() {
  await open();
  await click(document.querySelector('[aria-label="إعدادات الجهاز"]')!);
}
async function fill(placeholder: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function manager() {
  await open();
  await click(button("اعتماد مدير"));
  await fill("بريد المدير", "manager@example.test");
  await fill("كلمة المرور", "secret-48");
}

it("clears manager credentials when the panel closes", async () => {
  await render();
  await manager();
  await click(document.querySelector('[aria-label="إغلاق"]')!);
  await open();
  expect(
    document.querySelector<HTMLInputElement>('input[placeholder="كلمة المرور"]')
      ?.value ?? "",
  ).toBe("");
});
it("shows a declined approval result instead of failing silently", async () => {
  state.replay.mockResolvedValue({ ok: false, error: "العملية لم تعد معلقة" });
  await render();
  await manager();
  await click(button("اعتماد وترحيل"));
  expect(document.body.textContent).toContain("العملية لم تعد معلقة");
});
it("blocks duplicate PIN submissions while storage is pending", async () => {
  let finish!: (value: { ok: boolean }) => void;
  state.setPin.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await settings();
  await fill("PIN جديد (٤-٨ أرقام)", "1234");
  await fill("تأكيد", "1234");
  await click(button("حفظ"));
  try {
    expect(button("حفظ").disabled).toBe(true);
  } finally {
    await act(async () => finish({ ok: true }));
  }
  expect(state.setPin).toHaveBeenCalledOnce();
});
it("requires a device profile before saving a PIN", async () => {
  state.profile = null;
  await render();
  await settings();
  await fill("PIN جديد (٤-٨ أرقام)", "1234");
  await fill("تأكيد", "1234");
  expect(button("حفظ").disabled).toBe(true);
});

it("keeps a pending PIN write locked across closing and reopening", async () => {
  let finish!: (value: { ok: boolean }) => void;
  state.setPin.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await settings();
  await fill("PIN جديد (٤-٨ أرقام)", "1234");
  await fill("تأكيد", "1234");
  await click(button("حفظ"));
  await click(document.querySelector('[aria-label="إغلاق"]')!);
  await open();
  try {
    const confirmField = document.querySelector<HTMLInputElement>(
      'input[placeholder="تأكيد"]',
    );
    expect(confirmField == null || confirmField.disabled).toBe(true);
    expect(state.setPin).toHaveBeenCalledOnce();
  } finally {
    await act(async () => finish({ ok: true }));
  }
  await fill("PIN جديد (٤-٨ أرقام)", "5678");
  await fill("تأكيد", "5678");
  await click(button("حفظ"));
  expect(state.setPin.mock.calls.map((args) => args[0])).toEqual([
    "1234",
    "5678",
  ]);
});
it("preserves all replay routes and capture identity on automatic sync", async () => {
  await render();
  expect(state.flush).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ currentUserId: 7 }),
  );
  const api = state.flush.mock.calls[0][0];
  const args = {
    payload: { clientRequestId: "request-48", amount: "1250.25" },
    capturedAt: "2026-10-25T10:00:00Z",
    offlineReceiptNumber: "OFF-48",
    deviceId: "DEVICE-48",
  };
  for (const kind of ["SALE", "PRINT_SALE", "RECEPTION", "RETURN"]) {
    await api[kind](args);
    expect(
      state.routes[kind as keyof typeof state.routes],
    ).toHaveBeenCalledWith({
      ...args.payload,
      capturedAt: args.capturedAt,
      offlineReceiptNumber: args.offlineReceiptNumber,
      deviceId: args.deviceId,
    });
  }
});

it("does not hold the synchronization lock while refreshing catalog queries", async () => {
  state.invalidate.mockReturnValue(new Promise(() => {}));
  await render();
  await open();
  expect(button("مزامنة الآن").disabled).toBe(false);
});

it("keeps a pending row action locked across closing and reopening", async () => {
  let finish!: (value: { ok: boolean }) => void;
  state.replay.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await manager();
  await click(button("اعتماد وترحيل"));
  await click(document.querySelector('[aria-label="إغلاق"]')!);
  await open();
  try {
    expect(button("اعتماد مدير").disabled).toBe(true);
  } finally {
    await act(async () => finish({ ok: true }));
  }
  expect(button("اعتماد مدير").disabled).toBe(false);
  expect(state.replay).toHaveBeenCalledOnce();
});

it("recovers the approval action after a rejected storage promise", async () => {
  state.replay.mockRejectedValueOnce(new Error("تعذرت قراءة تخزين الجهاز"));
  await render();
  await manager();
  await click(button("اعتماد وترحيل"));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "تعذرت قراءة تخزين الجهاز",
  );
  expect(button("اعتماد وترحيل").disabled).toBe(false);
  await click(button("اعتماد وترحيل"));
  expect(state.replay).toHaveBeenCalledTimes(2);
  expect(document.querySelector('input[placeholder="كلمة المرور"]')).toBeNull();
});

it("recovers PIN saving after a rejected storage promise", async () => {
  state.setPin.mockRejectedValueOnce(new Error("تعذر حفظ PIN"));
  await render();
  await settings();
  await fill("PIN جديد (٤-٨ أرقام)", "1234");
  await fill("تأكيد", "1234");
  await click(button("حفظ"));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "تعذر حفظ PIN",
  );
  expect(button("حفظ").disabled).toBe(false);
  await click(button("حفظ"));
  expect(state.setPin).toHaveBeenCalledTimes(2);
});

it("shows a rejected PIN result without clearing the draft", async () => {
  state.setPin.mockResolvedValue({ ok: false, error: "لا ملف جهاز" });
  await render();
  await settings();
  await fill("PIN جديد (٤-٨ أرقام)", "1234");
  await fill("تأكيد", "1234");
  await click(button("حفظ"));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "لا ملف جهاز",
  );
  expect(
    document.querySelector<HTMLInputElement>('input[placeholder="تأكيد"]')!
      .value,
  ).toBe("1234");
});

it("clears a PIN draft when closing the panel", async () => {
  await render();
  await settings();
  await fill("PIN جديد (٤-٨ أرقام)", "1234");
  await click(document.querySelector('[aria-label="إغلاق"]')!);
  await open();
  expect(
    document.querySelector<HTMLInputElement>(
      'input[placeholder="PIN جديد (٤-٨ أرقام)"]',
    )?.value ?? "",
  ).toBe("");
});

it("explains when browser persistence is denied", async () => {
  state.persist.mockResolvedValue(false);
  await render();
  await settings();
  await click(button("طلب التثبيت"));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "لم يسمح المتصفح",
  );
});

it("shows retry failures and permits a later retry", async () => {
  state.requeue.mockRejectedValueOnce(new Error("تخزين الجهاز غير متاح"));
  await render();
  await open();
  await click(button("إعادة المحاولة"));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "تخزين الجهاز غير متاح",
  );
  await click(button("إعادة المحاولة"));
  expect(state.requeue).toHaveBeenCalledTimes(2);
});

it("does not request a manager password for an owner-only return", async () => {
  state.item.kind = "RETURN";
  await render();
  await open();
  expect(document.body.textContent).not.toContain("اعتماد مدير");
  expect(document.body.textContent).toContain("صلاحية المالك");
});

it("routes approvals to the saved kind and never attaches approval to returns", async () => {
  const args = {
    payload: { clientRequestId: "request-48", amount: "1250.25" },
    capturedAt: "2026-10-25T10:00:00Z",
    offlineReceiptNumber: "OFF-48",
    deviceId: "DEVICE-48",
  };
  state.replay.mockImplementation(async (_id, api) => {
    for (const kind of ["SALE", "PRINT_SALE", "RECEPTION", "RETURN"])
      await api[kind](args);
    return { ok: true };
  });
  await render();
  await manager();
  await click(button("اعتماد وترحيل"));
  for (const kind of ["SALE", "PRINT_SALE", "RECEPTION"] as const)
    expect(state.routes[kind]).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: "request-48",
        managerApproval: {
          email: "manager@example.test",
          password: "secret-48",
        },
        capturedAt: args.capturedAt,
        offlineReceiptNumber: "OFF-48",
        deviceId: "DEVICE-48",
      }),
    );
  expect(state.routes.RETURN.mock.calls[0][0]).not.toHaveProperty(
    "managerApproval",
  );
});

it.each([
  { conn: "offline", userId: 7 },
  { conn: "online", userId: null },
])(
  "does not replay while offline or without a current user: %j",
  async (condition) => {
    state.conn = condition.conn;
    state.userId = condition.userId;
    await render();
    expect(state.flush).not.toHaveBeenCalled();
  },
);
