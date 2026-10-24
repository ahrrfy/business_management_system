// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Contact360Panel } from "../Contact360Panel";
const state = vi.hoisted(() => ({
  user: {} as any,
  data: {} as any,
  people: [] as any[],
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
  options: {} as Record<string, any>,
  invalidate: vi.fn(),
  consentInvalidate: vi.fn(),
  confirm: vi.fn(),
  queryInputs: {} as Record<string, any>,
}));
vi.mock("@/lib/notify", () => ({
  notify: { ok: vi.fn(), err: vi.fn() },
  errMsg: (error: any) => String(error?.message ?? error),
}));
vi.mock("@/lib/confirm", () => ({ confirm: state.confirm }));
vi.mock("@/components/WhatsAppShare", () => ({
  WhatsAppShare: () => <span>واتساب</span>,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: any) => <>{children}</>,
  SheetContent: ({ children }: any) => <aside>{children}</aside>,
  SheetHeader: ({ children }: any) => <header>{children}</header>,
  SheetTitle: ({ children }: any) => <h2>{children}</h2>,
  SheetDescription: ({ children }: any) => <p>{children}</p>,
}));
vi.mock("@/components/ui/dialog", () => ({
  useDialogComposition: () => ({
    isComposing: () => false,
    justEndedComposing: () => false,
    setComposing: vi.fn(),
    markCompositionEnd: vi.fn(),
  }),
  Dialog: ({ children }: any) => <>{children}</>,
  DialogContent: ({ children }: any) => (
    <section role="dialog">{children}</section>
  ),
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogTitle: ({ children }: any) => <h3>{children}</h3>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
}));
vi.mock("@/lib/trpc", async () => {
  const React = await import("react");
  const mutation = (name: string, options?: any) => {
    state.options[name] = options;
    const [pending, setPending] = React.useState(false);
    const run = async (variables: any) => {
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
      mutateAsync: run,
      mutate: (input: any) => {
        void run(input).catch(() => {});
      },
    };
  };
  return {
    trpc: {
      auth: { me: { useQuery: () => ({ data: state.user }) } },
      useUtils: () => ({
        contacts: {
          persons: { list: { invalidate: state.invalidate } },
          contact360: { invalidate: state.consentInvalidate },
        },
      }),
      contacts: {
        contact360: {
          useQuery: (input: any, options: any) => {
            state.queryInputs.contact360 = { input, options };
            return {
              data: state.data,
              isLoading: false,
              isError: false,
              refetch: state.consentInvalidate,
            };
          },
        },
        findDuplicates: {
          useQuery: () => ({
            data: [],
            isFetching: false,
            isError: false,
            refetch: vi.fn(),
          }),
        },
        waConsent: {
          set: { useMutation: (options: any) => mutation("consent", options) },
        },
        persons: {
          list: {
            useQuery: (input: any, options: any) => {
              state.queryInputs.people = { input, options };
              return {
                data: state.people,
                isLoading: false,
                isError: false,
                refetch: state.invalidate,
              };
            },
          },
          create: {
            useMutation: (options: any) => mutation("create", options),
          },
          update: {
            useMutation: (options: any) => mutation("update", options),
          },
          setInactive: {
            useMutation: (options: any) => mutation("deactivate", options),
          },
        },
      },
    },
  };
});
const customer = {
  kind: "customer",
  customer: {
    id: 1,
    name: "عميل ألف",
    phone: null,
    defaultPriceTier: "RETAIL",
    currentBalance: "0",
    creditLimit: null,
    waConsent: "UNKNOWN",
  },
  invoices: [],
  conversations: [],
};
const supplier = {
  kind: "supplier",
  supplier: { id: 2, name: "مورّد باء", phone: null, currentBalance: "0" },
  conversations: [],
};
const person = {
  id: 9,
  name: "شخص قديم",
  role: null,
  phone: null,
  isPrimary: false,
  isActive: true,
  notes: null,
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
let root: Root,
  host: HTMLDivElement,
  props: React.ComponentProps<typeof Contact360Panel>;
const render = () => act(() => root.render(<Contact360Panel {...props} />));
const button = (text: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (node) =>
      node.textContent?.trim() === text ||
      node.getAttribute("aria-label") === text,
  );
const nameInput = () =>
  host.querySelector("#cp-name") as HTMLInputElement | null;
const setName = (name: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(nameInput(), name);
    nameInput()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
const fieldValue = (label: string) =>
  Array.from(host.querySelectorAll("span")).find(
    (node) => node.textContent === label + ":",
  )?.parentElement?.lastElementChild?.textContent;
const deny = (...paths: string[]) => {
  state.user.operationPolicy = {
    version: 1,
    grants: Object.fromEntries(
      paths.map((path) => [`operation.${path}`, false]),
    ),
  };
};
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
  state.user = { id: 1, role: "manager", branchId: 1, isOwner: false };
  state.data = customer;
  state.people = [person];
  state.options = {};
  state.calls = {
    create: vi.fn().mockResolvedValue({ id: 10 }),
    update: vi.fn().mockResolvedValue({}),
    deactivate: vi.fn().mockResolvedValue({}),
    consent: vi.fn().mockResolvedValue({}),
  };
  state.confirm.mockResolvedValue(true);
  state.invalidate.mockResolvedValue(undefined);
  state.consentInvalidate.mockResolvedValue(undefined);
  props = { kind: "customer", id: 1, onClose: vi.fn(), onOpenContact: vi.fn() };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
it("drops a person's draft before switching to a cached supplier", () => {
  render();
  act(() => button("إضافة")!.click());
  setName("مسودة عميل");
  props = { ...props, kind: "supplier", id: 2 };
  state.data = supplier;
  render();
  expect(nameInput()).toBeNull();
  expect(host.textContent).not.toContain("مسودة عميل");
});
it("does not let an old save close a newly opened person editor", async () => {
  const pending = deferred<{ id: number }>();
  state.calls.create.mockReturnValueOnce(pending.promise);
  render();
  act(() => button("إضافة")!.click());
  setName("طلب قديم");
  await act(async () => button("حفظ")!.click());
  act(() => button("إلغاء")!.click());
  act(() => button("إضافة")!.click());
  setName("مسودة أحدث");
  await act(async () => pending.resolve({ id: 10 }));
  expect(nameInput()?.value).toBe("مسودة أحدث");
  expect(state.invalidate).toHaveBeenCalledWith({ customerId: 1 });
});
it("does not deactivate after its confirmation outlives the contact session", async () => {
  const pending = deferred<boolean>();
  state.confirm.mockReturnValue(pending.promise);
  render();
  await act(async () => button("تعطيل شخص الاتصال")!.click());
  props = { ...props, kind: "supplier", id: 2 };
  state.data = supplier;
  render();
  await act(async () => pending.resolve(true));
  expect(state.calls.deactivate).not.toHaveBeenCalled();
});
it("uses independent operation permissions for each action", () => {
  deny(
    "contacts.persons.create",
    "contacts.persons.setInactive",
    "contacts.waConsent.set",
  );
  render();
  expect(button("تعديل شخص الاتصال")).toBeTruthy();
  expect(button("إضافة")).toBeUndefined();
  expect(button("تعطيل شخص الاتصال")).toBeUndefined();
  expect(button("موافِق")).toBeUndefined();
});
it("distinguishes masked balances from genuine zeroes and unlimited credit", () => {
  state.user.role = "cashier";
  render();
  expect(fieldValue("الرصيد الحالي")).toBe("محجوب");
  expect(fieldValue("حدّ الائتمان")).toBe("محجوب");
  state.user.role = "manager";
  render();
  expect(fieldValue("الرصيد الحالي")).toBe("0");
  expect(fieldValue("حدّ الائتمان")).toBe("بلا حد");
});
it("hides cached contact data after its read operation is revoked", () => {
  render();
  deny("contacts.contact360");
  render();
  expect(host.textContent).not.toContain("عميل ألف");
  expect(host.textContent).not.toContain("شخص قديم");
});
it("hides cached people after the specific list operation is revoked", () => {
  render();
  deny("contacts.persons.list");
  render();
  expect(host.textContent).toContain("عميل ألف");
  expect(host.textContent).not.toContain("شخص قديم");
});
it("honors an explicit create grant even when legacy CRM write access is absent", () => {
  state.user.role = "warehouse";
  state.user.operationPolicy = {
    version: 1,
    grants: {
      "operation.contacts.contact360": true,
      "operation.contacts.persons.list": true,
      "operation.contacts.persons.create": true,
    },
  };
  render();
  expect(button("إضافة")).toBeTruthy();
});
it("preserves the supplier FULL gate even with an explicit contact-create grant", () => {
  state.user.role = "cashier";
  state.user.permissionsOverride = { suppliers: "READ" };
  state.user.operationPolicy = {
    version: 1,
    grants: {
      "operation.contacts.contact360": true,
      "operation.contacts.persons.list": true,
      "operation.contacts.persons.create": true,
    },
  };
  props = { ...props, kind: "supplier", id: 2 };
  state.data = supplier;
  render();
  expect(button("إضافة")).toBeUndefined();
});
it("rechecks operation access after a pending deactivate confirmation", async () => {
  const pending = deferred<boolean>();
  state.confirm.mockReturnValue(pending.promise);
  render();
  await act(async () => button("تعطيل شخص الاتصال")!.click());
  deny("contacts.persons.setInactive");
  render();
  await act(async () => pending.resolve(true));
  expect(state.calls.deactivate).not.toHaveBeenCalled();
});
it("locks duplicate person saves synchronously", async () => {
  const pending = deferred<{ id: number }>();
  state.calls.create.mockReturnValue(pending.promise);
  render();
  act(() => button("إضافة")!.click());
  setName("اسم جديد");
  const save = button("حفظ")!;
  await act(async () => {
    save.click();
    save.click();
  });
  expect(state.calls.create).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ id: 10 }));
});
it("invalidates the customer whose consent was submitted after navigating to another party", async () => {
  const pending = deferred<object>();
  state.calls.consent.mockReturnValue(pending.promise);
  render();
  await act(async () => button("موافِق")!.click());
  props = { ...props, kind: "supplier", id: 2 };
  state.data = supplier;
  render();
  await act(async () => pending.resolve({}));
  expect(state.consentInvalidate).toHaveBeenCalledWith({
    kind: "customer",
    id: 1,
  });
});
it("preserves every edit field and the nullable update payload", async () => {
  state.people = [
    {
      ...person,
      phone: "+9647701234567",
      role: "مدير مشتريات",
      isPrimary: true,
      notes: "ملاحظات محفوظة",
    },
  ];
  render();
  act(() => button("تعديل شخص الاتصال")!.click());
  setName("اسم مصحح");
  expect(host.querySelector("#cp-role")).toBeTruthy();
  expect(host.querySelector("#cp-notes")).toBeTruthy();
  expect(host.querySelector('[role="checkbox"]')).toBeTruthy();
  await act(async () => button("حفظ")!.click());
  expect(state.calls.update).toHaveBeenCalledWith({
    id: 9,
    name: "اسم مصحح",
    phone: "+9647701234567",
    role: "مدير مشتريات",
    notes: "ملاحظات محفوظة",
    isPrimary: true,
  });
});
