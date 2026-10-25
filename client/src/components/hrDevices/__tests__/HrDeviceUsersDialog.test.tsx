// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HrDeviceUsersDialog, type HrDeviceUsersDialogProps } from "../HrDeviceUsersDialog";
import { HrDeviceFormDialog } from "../HrDeviceFormDialog";
import { emptyForm } from "../hrDeviceTypes";

vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: ({ onValueChange, children, ...props }: any) => <select {...props} onChange={(event) => onValueChange(event.target.value)}>{children}</select> }));
vi.mock("@/components/search/UnifiedSearchInput", () => ({ UnifiedSearchInput: ({ onChange, barcode, debounceMs, size, ...props }: any) => <input {...props} onChange={(event) => onChange(event.target.value)} /> }));
(globalThis as any).React = React;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let props: HrDeviceUsersDialogProps;
const render = async () => act(async () => root.render(<HrDeviceUsersDialog {...props} />));
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = { open: true, onClose: vi.fn(), deviceUserQuery: "", setDeviceUserQuery: vi.fn(), visibleDeviceUsers: [{ id: 1, enrollId: 12, name: "موظف الجهاز", employeeId: 91 }], deviceUsersLoading: false, totalDeviceUsers: 1, employeeOptions: [{ id: 2, name: "الموظف الثاني" }], onMapUser: vi.fn(), deviceUsersError: false, employeeOptionsLoading: false, employeeOptionsError: false, isMapping: false, onRetryUsers: vi.fn(), onRetryEmployees: vi.fn() };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
it("shows query failure with retry instead of claiming no users exist", async () => {
  props.deviceUsersError = true; props.visibleDeviceUsers = []; props.totalDeviceUsers = 0;
  await render();
  expect(document.body.textContent).toContain("تعذّر تحميل مستخدمي الجهاز");
  expect(document.body.textContent).not.toContain("لا مستخدمون مسحوبون");
  const retry = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("إعادة محاولة تحميل المستخدمين"))!;
  act(() => retry.click()); expect(props.onRetryUsers).toHaveBeenCalledOnce();
});
it.each(["isMapping", "employeeOptionsError", "employeeOptionsLoading", "deviceUsersError", "deviceUsersLoading"] as const)("blocks remapping while %s", async (key) => {
  props[key] = true; await render();
  expect(document.querySelector("select")!.disabled).toBe(true);
});
it("keeps an existing mapping visible when the employee is outside current options", async () => {
  await render();
  expect(document.querySelector("select")!.value).toBe("91");
  expect(document.querySelector("option:checked")!.textContent).toContain("موظف #91");
});
it("allows explicit unlinking and reports the correct enrollment identity", async () => {
  await render(); const select = document.querySelector("select")!;
  await act(async () => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(props.onMapUser).toHaveBeenCalledWith(12, null);
});
it("disables cancel and hides the close control while a device save is pending", async () => {
  await act(async () => root.render(<HrDeviceFormDialog open onClose={props.onClose} editId={1} form={emptyForm} setForm={vi.fn()} branches={[]} isPending onSubmit={vi.fn()} />));
  expect([...document.querySelectorAll("button")].find((item) => item.textContent?.includes("إلغاء"))!.disabled).toBe(true);
  expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
});
