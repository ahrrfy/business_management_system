// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveAccessSummary } from "@shared/permissions";
import type { OperationPolicy } from "@shared/operationPermissions";

const query = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
vi.mock("@/lib/trpc", () => ({
  trpc: { users: { effectivePermissions: { useQuery: () => query } } },
}));

import { EffectiveAccessForAssignment, EffectiveAccessPreview } from "../EffectiveAccessPreview";
import { EffectivePermissionsPanel } from "../EffectivePermissionsPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
const denied: EffectiveAccessSummary = { resolved: {}, station: "NONE", stations: [], canSeeCost: false };

describe("actual permission preview", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    query.data = undefined;
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const render = (element: React.ReactNode) => act(() => root.render(element));

  it("respects the supplied deny summary even when the category is admin", () => {
    render(<EffectiveAccessPreview role="admin" summary={denied} />);
    expect(host.textContent).toContain("لا قسم بيع");
    expect(host.textContent).not.toContain("كل الأقسام");
    expect(host.textContent).toContain("لا يرى التكلفة");
  });

  it("uses a saved custom role policy instead of its older coarse modules", () => {
    const operationPolicy: OperationPolicy = {
      version: 1,
      grants: { "operation.workOrders.receptionCheckout": true },
      dataVisibility: { purchaseCost: false, profitMargin: false },
    };
    render(<EffectiveAccessForAssignment role="manager" permsOverride={null} customRoleId={4} customRoles={[{
      id: 4, baseRole: "manager", permissions: { sales: "FULL", pos: "FULL", workorders: "FULL" }, operationPolicy,
    }]} />);
    expect(host.textContent).toContain("استقبال أوامر شغل فقط");
    expect(host.textContent).not.toContain("تجزئة فقط");
    expect(host.textContent).not.toContain("خدمات طباعة فقط");
    expect(host.textContent).toContain("لا يرى التكلفة");
  });

  it("synthesizes the seeded section-role preset when its stored policy is null", () => {
    render(<EffectiveAccessForAssignment
      role="cashier"
      permsOverride={null}
      customRoleId={8}
      customRoles={[{
        id: 8,
        key: "print_cashier",
        baseRole: "cashier",
        permissions: { sales: "NONE", pos: "FULL", workorders: "NONE" },
        operationPolicy: null,
      }]}
    />);
    expect(host.textContent).toContain("خدمات طباعة فقط");
    expect(host.textContent).not.toContain("تجزئة فقط");
  });

  it("labels the saved operation policy as its source, not the base template", () => {
    query.data = {
      effectiveRole: "courier", customRoleInactive: false,
      access: { ...denied, station: "RETAIL", stations: ["RETAIL"] },
      modules: [{ key: "sales", label: "المبيعات", level: "FULL", source: "operationPolicy" }],
    };
    render(<EffectivePermissionsPanel userId={4} />);
    expect(host.textContent).toContain("تفويض العمليات");
    expect(host.textContent).not.toContain("قالب الفئة");
  });

  it("explains that an inactive custom role blocks operational authority", () => {
    query.data = { effectiveRole: "user", customRoleInactive: true, access: denied, modules: [] };
    render(<EffectivePermissionsPanel userId={4} />);
    expect(host.textContent).toContain("تفويض العمليات محجوب");
    expect(host.textContent).toContain("لا قسم بيع");
  });
});
