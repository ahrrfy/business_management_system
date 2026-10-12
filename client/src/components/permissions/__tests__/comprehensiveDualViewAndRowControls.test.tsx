/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { PermissionMatrix } from "../PermissionMatrix";
import { PermissionResourceCard } from "../PermissionResourceCard";
import { PermissionResourceRow } from "../PermissionResourceRow";
import {
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ATOMIC_PERMISSION_DEFINITIONS,
  RESOURCE_METADATA,
} from "@shared/atomicPermissions";
import type { ResourceRowViewModel } from "../types";

describe("Comprehensive Dual View Modes & Row-Level Controls Suite", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("1. Renders in Grid Mode by default and allows switching to Cards Mode", () => {
    const handleChange = vi.fn();
    const handleBulkChange = vi.fn();

    act(() => {
      root.render(
        <PermissionMatrix
          role="cashier"
          atomicPermissions={ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier}
          onChange={handleChange}
          onBulkChange={handleBulkChange}
        />,
      );
    });

    // Default mode is grid -> table should exist
    const table = container.querySelector("table");
    expect(table).not.toBeNull();

    // Find view mode switcher buttons
    const cardsBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("البطاقات والشجرة"),
    );
    expect(cardsBtn).toBeDefined();

    // Click to switch to cards mode
    act(() => {
      cardsBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Now table should be replaced by cards
    const tableAfterSwitch = container.querySelector("table");
    expect(tableAfterSwitch).toBeNull();

    // Cards should be rendered with resource labels
    const cardHeadings = Array.from(container.querySelectorAll(".font-semibold")).map(
      (el) => el.textContent?.trim(),
    );
    expect(cardHeadings.some((text) => text?.includes("ورديات الصندوق"))).toBe(true);
  });

  it("2. PermissionResourceCard provides row-level Full, Read-Only, and Revoke buttons", () => {
    const onToggle = vi.fn();
    const onBulkUpdate = vi.fn();

    const mockResource: ResourceRowViewModel = {
      resource: "invoice",
      domain: "pos",
      label: "فواتير المبيعات الفورية",
      description: "إصدار وتعديل فواتير الكاشير",
      iconName: "Receipt",
      totalActionsCount: 4,
      grantedActionsCount: 2,
      hasCustomOverrides: true,
      actions: {} as any,
      allActions: [
        {
          key: "pos.invoice.view",
          action: "view",
          isSupported: true,
          state: "INHERITED_GRANT",
          granted: true,
          baseGranted: true,
          definition: {
            key: "pos.invoice.view",
            domain: "pos",
            resource: "invoice",
            action: "view",
            standardAction: "view",
            label: "عرض الفواتير",
            labelAr: "عرض الفواتير",
            description: "",
            descriptionAr: "",
            sensitivity: "normal",
            legacyModule: "sales",
          },
        },
        {
          key: "pos.invoice.create",
          action: "create",
          isSupported: true,
          state: "INHERITED_GRANT",
          granted: true,
          baseGranted: true,
          definition: {
            key: "pos.invoice.create",
            domain: "pos",
            resource: "invoice",
            action: "create",
            standardAction: "create",
            label: "إصدار فاتورة",
            labelAr: "إصدار فاتورة",
            description: "",
            descriptionAr: "",
            sensitivity: "normal",
            legacyModule: "sales",
          },
        },
        {
          key: "pos.invoice.edit",
          action: "edit",
          isSupported: true,
          state: "CUSTOM_DENY",
          granted: false,
          baseGranted: true,
          definition: {
            key: "pos.invoice.edit",
            domain: "pos",
            resource: "invoice",
            action: "edit",
            standardAction: "edit",
            label: "تعديل بنود الفاتورة",
            labelAr: "تعديل بنود الفاتورة",
            description: "",
            descriptionAr: "",
            sensitivity: "normal",
            legacyModule: "sales",
          },
        },
        {
          key: "pos.invoice.approve",
          action: "approve",
          isSupported: true,
          state: "INHERITED_DENY",
          granted: false,
          baseGranted: false,
          definition: {
            key: "pos.invoice.approve",
            domain: "pos",
            resource: "invoice",
            action: "approve",
            standardAction: "approve",
            label: "اعتماد الفواتير الاستثنائية",
            labelAr: "اعتماد الفواتير الاستثنائية",
            description: "",
            descriptionAr: "",
            sensitivity: "high",
            legacyModule: "sales",
            isSpecialOperation: true,
          },
        },
      ],
      specialActions: [],
    };

    act(() => {
      root.render(
        <PermissionResourceCard
          resource={mockResource}
          onToggle={onToggle}
          onBulkUpdate={onBulkUpdate}
        />,
      );
    });

    // Verify row buttons exist
    const grantAllBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("منح الكل"),
    );
    const viewOnlyBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("عرض فقط"),
    );
    const denyAllBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("حجب"),
    );
    const resetRoleBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("استعادة الدور"),
    );

    expect(grantAllBtn).toBeDefined();
    expect(viewOnlyBtn).toBeDefined();
    expect(denyAllBtn).toBeDefined();
    expect(resetRoleBtn).toBeDefined();

    // 1. Click Grant All
    act(() => {
      grantAllBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBulkUpdate).toHaveBeenCalledWith({
      "pos.invoice.view": true,
      "pos.invoice.create": true,
      "pos.invoice.edit": true,
      "pos.invoice.approve": true,
    });

    // 2. Click View Only
    act(() => {
      viewOnlyBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBulkUpdate).toHaveBeenCalledWith({
      "pos.invoice.view": true,
      "pos.invoice.create": false,
      "pos.invoice.edit": false,
      "pos.invoice.approve": false,
    });

    // 3. Click Deny All
    act(() => {
      denyAllBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBulkUpdate).toHaveBeenCalledWith({
      "pos.invoice.view": false,
      "pos.invoice.create": false,
      "pos.invoice.edit": false,
      "pos.invoice.approve": false,
    });

    // 4. Click Reset to Role
    act(() => {
      resetRoleBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBulkUpdate).toHaveBeenCalledWith({
      "pos.invoice.view": true,
      "pos.invoice.create": true,
      "pos.invoice.edit": true,
      "pos.invoice.approve": false,
    });
  });

  it("3. Highlights special operations with sensitive badge in Cards Mode", () => {
    const onToggle = vi.fn();
    const onBulkUpdate = vi.fn();

    const mockResource: ResourceRowViewModel = {
      resource: "return",
      domain: "pos",
      label: "المرتجع والاستبدال الفوري",
      description: "إصدار مرتجع مبيعات واستبدال الأصناف",
      iconName: "RotateCcw",
      totalActionsCount: 2,
      grantedActionsCount: 1,
      hasCustomOverrides: false,
      actions: {} as any,
      allActions: [
        {
          key: "pos.return.view",
          action: "view",
          isSupported: true,
          state: "INHERITED_GRANT",
          granted: true,
          baseGranted: true,
          definition: {
            key: "pos.return.view",
            domain: "pos",
            resource: "return",
            action: "view",
            standardAction: "view",
            label: "استعراض سجل المرتجعات",
            labelAr: "استعراض سجل المرتجعات",
            description: "",
            descriptionAr: "",
            sensitivity: "normal",
            legacyModule: "sales",
          },
        },
        {
          key: "pos.return.no_invoice",
          action: "create",
          isSupported: true,
          state: "INHERITED_DENY",
          granted: false,
          baseGranted: false,
          definition: {
            key: "pos.return.no_invoice",
            domain: "pos",
            resource: "return",
            action: "no_invoice",
            standardAction: "create",
            label: "إصدار مرتجع بدون أصل فاتورة",
            labelAr: "إصدار مرتجع بدون أصل فاتورة",
            description: "استرجاع نقدي بدون رقم فاتورة",
            descriptionAr: "استرجاع نقدي بدون رقم فاتورة",
            sensitivity: "high",
            legacyModule: "sales",
            isSpecialOperation: true,
          },
        },
      ],
      specialActions: [],
    };

    act(() => {
      root.render(
        <PermissionResourceCard
          resource={mockResource}
          onToggle={onToggle}
          onBulkUpdate={onBulkUpdate}
        />,
      );
    });

    // Verify sensitive badge is visible
    expect(container.textContent).toContain("عملية تشغيلية حساسة");
    expect(container.textContent).toContain("إصدار مرتجع بدون أصل فاتورة");

    // Click the sensitive action chip to toggle
    const specialChip = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("إصدار مرتجع بدون أصل فاتورة"),
    );
    expect(specialChip).toBeDefined();

    act(() => {
      specialChip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggle).toHaveBeenCalledWith("pos.return.no_invoice", true);
  });

  it("4. PermissionResourceRow supports row-level quick buttons in Grid Mode", () => {
    const onToggle = vi.fn();
    const onBulkUpdate = vi.fn();

    const mockResource: ResourceRowViewModel = {
      resource: "transfer",
      domain: "inventory",
      label: "مناقلات الفروع والمستودعات",
      description: "إرسال واستلام المناقلات",
      totalActionsCount: 2,
      grantedActionsCount: 1,
      hasCustomOverrides: false,
      actions: {
        view: {
          key: "inventory.transfer.view",
          action: "view",
          isSupported: true,
          state: "INHERITED_GRANT",
          granted: true,
          baseGranted: true,
        },
        create: {
          key: "inventory.transfer.create",
          action: "create",
          isSupported: true,
          state: "INHERITED_DENY",
          granted: false,
          baseGranted: false,
        },
        edit: { key: "", action: "edit", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
        cancel: { key: "", action: "cancel", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
        print: { key: "", action: "print", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
        reprint: { key: "", action: "reprint", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
        export: { key: "", action: "export", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
        approve: { key: "", action: "approve", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
      },
      allActions: [
        {
          key: "inventory.transfer.view",
          action: "view",
          isSupported: true,
          state: "INHERITED_GRANT",
          granted: true,
          baseGranted: true,
        },
        {
          key: "inventory.transfer.create",
          action: "create",
          isSupported: true,
          state: "INHERITED_DENY",
          granted: false,
          baseGranted: false,
        },
      ],
      specialActions: [],
    };

    act(() => {
      root.render(
        <table>
          <tbody>
            <PermissionResourceRow
              resource={mockResource}
              onToggle={onToggle}
              onBulkUpdate={onBulkUpdate}
            />
          </tbody>
        </table>,
      );
    });

    // Row has action buttons
    const rowButtons = container.querySelectorAll("td button");
    expect(rowButtons.length).toBeGreaterThan(0);

    // Find row quick buttons by title
    const grantAllRowBtn = Array.from(rowButtons).find((b) =>
      b.getAttribute("title")?.includes("منح الكل لهذا المورد"),
    );
    expect(grantAllRowBtn).toBeDefined();

    act(() => {
      grantAllRowBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBulkUpdate).toHaveBeenCalledWith({
      "inventory.transfer.view": true,
      "inventory.transfer.create": true,
    });
  });
});
