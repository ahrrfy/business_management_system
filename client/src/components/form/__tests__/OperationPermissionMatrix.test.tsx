// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationPolicy } from "@shared/operationPermissions";

vi.mock("@shared/operationPermissions", () => ({
  OPERATION_PERMISSIONS: [
    {
      key: "operation.delivery.dispatch",
      path: "delivery.dispatch",
      kind: "mutation",
      domain: "delivery",
      resource: "التوصيل",
      lifecycleStage: "EXECUTION",
      label: "إسناد التوصيل",
      branch: true,
      delegable: true,
      supportsRecordScope: true,
    },
    {
      key: "operation.returns.create",
      path: "returns.create",
      kind: "mutation",
      domain: "returns",
      resource: "المرتجعات",
      lifecycleStage: "PREPARATION",
      label: "طلب مرتجع",
      branch: true,
      delegable: true,
    },
    {
      key: "operation.returns.approve",
      path: "returns.approve",
      kind: "mutation",
      domain: "returns",
      resource: "المرتجعات",
      lifecycleStage: "APPROVAL",
      label: "اعتماد مرتجع",
      branch: true,
      delegable: true,
    },
    {
      key: "operation.roles.create",
      path: "roles.create",
      kind: "mutation",
      domain: "roles",
      resource: "الأدوار",
      lifecycleStage: "ADMINISTRATION",
      label: "إدارة أدوار محجوزة",
      delegable: false,
    },
    {
      key: "operation.reports.profit",
      path: "reports.profit",
      kind: "query",
      domain: "reports",
      resource: "التقارير",
      lifecycleStage: "VIEW",
      label: "تقرير الأرباح",
      delegable: true,
      requiresCostVisibility: true,
    },
  ],
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({
    children,
    onValueChange,
    ...props
  }: React.SelectHTMLAttributes<HTMLSelectElement> & {
    onValueChange: (value: string) => void;
  }) => (
    <select {...props} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
}));

import {
  OperationPermissionMatrix,
  editableOperationPolicy,
  individualOperationOverrides,
} from "../OperationPermissionMatrix";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
const base: OperationPolicy = {
  version: 1,
  grants: {
    "operation.delivery.dispatch": true,
    "operation.returns.create": true,
    "operation.returns.approve": false,
  },
  recordScopes: { "operation.delivery.dispatch": "OWN" },
  dataVisibility: { purchaseCost: false, profitMargin: false },
};

describe("Canonical operation delegation editor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let latest: OperationPolicy | null;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    latest = null;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  function render(
    mode: "role" | "user",
    initial: OperationPolicy | null = null,
  ) {
    function Editor() {
      const [value, setValue] = useState(initial);
      return (
        <OperationPermissionMatrix
          mode={mode}
          value={value}
          baseline={initial}
          inherited={base}
          onChange={(next) => {
            latest = next;
            setValue(next);
          }}
        />
      );
    }
    act(() => root.render(<Editor />));
  }
  function select(label: string, value: string) {
    const field = host.querySelector<HTMLSelectElement>(
      `select[aria-label="${label}"]`,
    )!;
    expect(field).not.toBeNull();
    act(() => {
      field.value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  function click(text: string) {
    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    )!;
    expect(button).toBeTruthy();
    act(() => button.click());
  }

  it("individual denial and restoration preserve sparse inheritance and another operation", () => {
    render("user");
    select("تفويض إسناد التوصيل", "deny");
    expect(latest?.grants).toEqual({ "operation.delivery.dispatch": false });
    select("تفويض اعتماد مرتجع", "allow");
    expect(latest?.grants).toEqual({
      "operation.delivery.dispatch": false,
      "operation.returns.approve": true,
    });
    select("تفويض إسناد التوصيل", "inherit");
    expect(latest?.grants).toEqual({ "operation.returns.approve": true });
    expect(base.grants["operation.delivery.dispatch"]).toBe(true);
  });

  it("bulk action only changes filtered results and omits protected operations", () => {
    render("role", { version: 1, grants: {} });
    expect(host.textContent).not.toContain("إدارة أدوار محجوزة");
    const field = host.querySelector<HTMLInputElement>(
      "input[placeholder^='مثال:']",
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(field, "مرتجع");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click("منح النتائج المصفّاة");
    expect(latest?.grants).toEqual({
      "operation.returns.create": true,
      "operation.returns.approve": true,
    });
  });

  it("cost and profit are saved as one visibility option and scope inheritance can be restored", () => {
    render("user");
    const visibility = host.querySelector<HTMLSelectElement>(
      "select[id$='-visibility']",
    )!;
    act(() => {
      visibility.value = "allow";
      visibility.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(latest?.dataVisibility).toEqual({
      purchaseCost: true,
      profitMargin: true,
    });
    select("نطاق سجلات إسناد التوصيل", "BRANCH");
    expect(latest?.recordScopes).toEqual({
      "operation.delivery.dispatch": "BRANCH",
    });
    select("نطاق سجلات إسناد التوصيل", "inherit");
    expect(latest?.recordScopes).toEqual({});
    act(() => {
      visibility.value = "inherit";
      visibility.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(latest?.dataVisibility).toEqual({});
  });

  it("migration keeps only differences, and cloning cannot grant a reserved operation", () => {
    const effective = {
      ...base,
      grants: {
        ...base.grants,
        "operation.returns.create": false,
        "operation.roles.create": true,
      },
    };
    expect(individualOperationOverrides(effective, base).grants).toEqual({
      "operation.returns.create": false,
    });
    expect(editableOperationPolicy(effective).grants).not.toHaveProperty(
      "operation.roles.create",
    );
  });

  it("requires explicit cost visibility before granting an unmasked profit query", () => {
    render("role", { version: 1, grants: {} });
    const query = host.querySelector<HTMLInputElement>(
      'input[id$="operation.reports.profit"]',
    )!;
    expect(query.disabled).toBe(true);
    expect(host.textContent).toContain("تتطلب تفعيل عرض التكلفة والربح");
    const visibility = host.querySelector<HTMLInputElement>(
      'input[id$="-visibility"]',
    )!;
    act(() => visibility.click());
    expect(query.disabled).toBe(false);
    act(() => query.click());
    expect(latest?.grants["operation.reports.profit"]).toBe(true);
    expect(latest?.dataVisibility).toEqual({
      purchaseCost: true,
      profitMargin: true,
    });
  });

  it("counts a cost-dependent query as disabled when visibility is revoked, retaining the selected operation", () => {
    render("role", {
      version: 1,
      grants: { "operation.reports.profit": true },
      dataVisibility: { purchaseCost: true, profitMargin: true },
    });
    const visibility = host.querySelector<HTMLInputElement>(
      'input[id$="-visibility"]',
    )!;
    act(() => visibility.click());
    expect(latest?.grants["operation.reports.profit"]).toBe(true);
    expect(host.textContent).toContain("أثر الحفظ: منح 0، منع 1");
    expect(host.textContent).toContain("محجوبة حتى تفعيل عرض التكلفة");
  });
});
