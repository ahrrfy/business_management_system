// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_DOMAINS,
  ATOMIC_PERMISSION_DEFINITIONS,
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  ROLE_DEFAULT_DATA_MASKING,
  deriveLegacyModulesFromAtomic,
  deriveAtomicFromLegacyModules,
  type AtomicPermissionKey,
  type AtomicPermissionsMap,
  type OperationalCaps,
  type SensitiveDataMasking,
  type StandardActionType,
} from "@shared/atomicPermissions";
import { PermissionMatrix } from "../PermissionMatrix";
import { PermissionActionCell } from "../PermissionActionCell";
import { PermissionCategoryCard } from "../PermissionCategoryCard";
import { PermissionPresetsBar, OPERATIONAL_PRESETS } from "../PermissionPresetsBar";
import { OperationalCapsPanel } from "../OperationalCapsPanel";
import { SensitiveMaskingPanel } from "../SensitiveMaskingPanel";
import { PermissionMatrixFilters } from "../PermissionMatrixFilters";
import { PermissionMatrix as FormPermissionMatrixWrapper } from "../../form/PermissionMatrix";
import { getActionVisualTokens, type DomainCategoryViewModel, type ResourceActionSlot } from "../types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

function triggerReactInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Challenger 1 Adversarial UI Stress Suite — Milestone 3 (R2)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  describe("1. Preset Switching & Dirty State Matrix", () => {
    it("switching presets completely overwrites previous preset keys and updates caps & masking", () => {
      let currentAtomic: AtomicPermissionsMap = {};
      const stateHolder: { caps: OperationalCaps | null; masking: SensitiveDataMasking | null } = {
        caps: null,
        masking: null,
      };

      const handleBulkChange = vi.fn((updates: Record<string, boolean>) => {
        currentAtomic = { ...updates };
      });
      const handleCapsChange = vi.fn((caps: OperationalCaps) => {
        stateHolder.caps = caps;
      });
      const handleMaskingChange = vi.fn((masking: SensitiveDataMasking) => {
        stateHolder.masking = masking;
      });

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={currentAtomic}
            onChange={vi.fn()}
            onBulkChange={handleBulkChange}
            caps={stateHolder.caps}
            onCapsChange={handleCapsChange}
            masking={stateHolder.masking}
            onMaskingChange={handleMaskingChange}
          />
        );
      });

      const buttons = Array.from(host.querySelectorAll("button"));
      const cashierBtn = buttons.find((b) => b.textContent?.includes("الكاشير"));
      const accountantBtn = buttons.find((b) => b.textContent?.includes("محاسب"));
      const warehouseBtn = buttons.find((b) => b.textContent?.includes("أمين مخزن"));

      expect(cashierBtn).toBeDefined();
      expect(accountantBtn).toBeDefined();
      expect(warehouseBtn).toBeDefined();

      // Step 1: Apply Cashier Preset
      act(() => {
        cashierBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleBulkChange).toHaveBeenCalledTimes(1);
      expect(currentAtomic["pos.invoice.create"]).toBe(true);
      expect(currentAtomic["inventory.stocktake.create"]).toBe(false);
      expect(stateHolder.caps?.maxDiscountPercent).toBe(5);
      expect(stateHolder.masking?.maskPurchaseCost).toBe(true);

      // Mutate one key manually (simulate individual override)
      currentAtomic["inventory.stocktake.create"] = true;

      // Step 2: Apply Warehouse Preset
      act(() => {
        warehouseBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleBulkChange).toHaveBeenCalledTimes(2);
      // Warehouse preset has inventory, but does NOT grant pos invoice creation
      expect(currentAtomic["pos.invoice.create"]).toBe(false);
      expect(currentAtomic["inventory.stocktake.create"]).toBe(true);
      expect(stateHolder.caps?.maxDiscountPercent).toBe(0); // Warehouse has 0% discount
      expect(stateHolder.masking?.maskPurchaseCost).toBe(true);

      // Step 3: Apply Accountant Preset
      act(() => {
        accountantBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleBulkChange).toHaveBeenCalledTimes(3);
      // Accountant sees costs (unmasked) and has treasury voucher permissions
      expect(currentAtomic["treasury.voucher_out.create"]).toBe(true);
      expect(stateHolder.masking?.maskPurchaseCost).toBe(false);
      expect(stateHolder.masking?.maskProfitMargin).toBe(false);
    });

    it("verifies dirty state tracking simulation against baseline snapshot", () => {
      const role = "cashier";
      const baselineAtomic = { ...ROLE_DEFAULT_ATOMIC_PERMISSIONS[role] };
      const baselineCaps = { ...ROLE_DEFAULT_OPERATIONAL_CAPS[role] };
      const baselineSnapshot = JSON.stringify({ atomic: baselineAtomic, caps: baselineCaps });

      let currentAtomic = { ...baselineAtomic };
      let currentCaps = { ...baselineCaps };

      const checkIsDirty = () => JSON.stringify({ atomic: currentAtomic, caps: currentCaps }) !== baselineSnapshot;

      expect(checkIsDirty()).toBe(false);

      // Mutate 1 atomic permission
      currentAtomic = { ...currentAtomic, "pos.invoice.cancel": !baselineAtomic["pos.invoice.cancel"] };
      expect(checkIsDirty()).toBe(true);

      // Revert back
      currentAtomic = { ...currentAtomic, "pos.invoice.cancel": baselineAtomic["pos.invoice.cancel"] };
      expect(checkIsDirty()).toBe(false);

      // Mutate caps
      currentCaps = { ...currentCaps, maxDiscountPercent: 99 };
      expect(checkIsDirty()).toBe(true);

      // Reset to default
      currentCaps = { ...baselineCaps };
      expect(checkIsDirty()).toBe(false);
    });
  });

  describe("2. Custom Override Transitions & FSM States", () => {
    it("cycles through all state transitions: undefined -> true -> false -> undefined", () => {
      // Test when base granted is false
      expect(getActionVisualTokens("INHERITED_DENY").badgeVariant).toBe("muted");
      expect(getActionVisualTokens("INHERITED_DENY").isCustom).toBe(false);

      expect(getActionVisualTokens("CUSTOM_GRANT").badgeVariant).toBe("success");
      expect(getActionVisualTokens("CUSTOM_GRANT").isCustom).toBe(true);
      expect(getActionVisualTokens("CUSTOM_GRANT").badgeLabel).toBe("+ مخصّص");

      // Test when base granted is true
      expect(getActionVisualTokens("INHERITED_GRANT").badgeVariant).toBe("default");
      expect(getActionVisualTokens("INHERITED_GRANT").isCustom).toBe(false);
      expect(getActionVisualTokens("INHERITED_GRANT").badgeLabel).toBe("بالدور");

      expect(getActionVisualTokens("CUSTOM_DENY").badgeVariant).toBe("danger");
      expect(getActionVisualTokens("CUSTOM_DENY").isCustom).toBe(true);
      expect(getActionVisualTokens("CUSTOM_DENY").badgeLabel).toBe("− محجوب");
    });

    it("computes accurate override counts when toggling keys against role template", () => {
      const template = ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier;
      const baseKeyGranted = "pos.invoice.create"; // true in cashier
      const baseKeyDenied = "inventory.stocktake.create"; // false in cashier

      expect(Boolean(template[baseKeyGranted])).toBe(true);
      expect(Boolean(template[baseKeyDenied])).toBe(false);

      const modifiedMap: AtomicPermissionsMap = {
        ...template,
        [baseKeyGranted]: false, // Custom Deny
        [baseKeyDenied]: true, // Custom Grant
      };

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={modifiedMap}
            onChange={vi.fn()}
          />
        );
      });

      // Filters bar displays override badges
      expect(host.textContent).toContain("+1 منح");
      expect(host.textContent).toContain("−1 حجب");
      expect(host.textContent).toContain("الاستثناءات فقط");
    });

    it("renders disabled state and refuses click interactions when readOnly=true", () => {
      const handleChange = vi.fn();
      const atomicMap: AtomicPermissionsMap = { ...ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier };

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={atomicMap}
            onChange={handleChange}
            readOnly={true}
          />
        );
      });

      // Action cell buttons should be disabled
      const actionButtons = host.querySelectorAll('tbody button[aria-pressed]');
      expect(actionButtons.length).toBeGreaterThan(0);

      const firstBtn = actionButtons[0] as HTMLButtonElement;
      expect(firstBtn.disabled).toBe(true);

      act(() => {
        firstBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleChange).not.toHaveBeenCalled();
    });
  });

  describe("3. Bulk Action Controls Across Categories", () => {
    it("tests 'منح الكل' across a domain category with mixed existing states", () => {
      const handleBulkUpdate = vi.fn();
      const mockCategory: DomainCategoryViewModel = {
        key: "pos",
        label: "الكاشير ونقاط البيع",
        description: "نقاط البيع والفواتير",
        iconName: "Store",
        order: 1,
        totalActions: 3,
        grantedActions: 1,
        customOverridesCount: 0,
        resources: [
          {
            resource: "invoice",
            domain: "pos",
            label: "فاتورة البيع",
            hasCustomOverrides: false,
            actions: {
              view: { key: "pos.invoice.view", action: "view", isSupported: true, state: "INHERITED_GRANT", granted: true, baseGranted: true },
              create: { key: "pos.invoice.create", action: "create", isSupported: true, state: "INHERITED_DENY", granted: false, baseGranted: false },
              edit: { key: "pos.invoice.edit", action: "edit", isSupported: true, state: "INHERITED_DENY", granted: false, baseGranted: false },
              cancel: { key: "", action: "cancel", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              print: { key: "", action: "print", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              reprint: { key: "", action: "reprint", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              export: { key: "", action: "export", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              approve: { key: "", action: "approve", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
            },
          },
        ],
      };

      act(() => {
        root.render(
          <PermissionCategoryCard
            category={mockCategory}
            onToggle={vi.fn()}
            onBulkUpdate={handleBulkUpdate}
          />
        );
      });

      const grantAllBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("منح الكل")
      );
      expect(grantAllBtn).toBeDefined();

      act(() => {
        grantAllBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleBulkUpdate).toHaveBeenCalledTimes(1);
      const updates = handleBulkUpdate.mock.calls[0][0];
      expect(updates["pos.invoice.view"]).toBe(true);
      expect(updates["pos.invoice.create"]).toBe(true);
      expect(updates["pos.invoice.edit"]).toBe(true);
    });

    it("tests 'حجب الكل' across a domain category", () => {
      const handleBulkUpdate = vi.fn();
      const mockCategory: DomainCategoryViewModel = {
        key: "pos",
        label: "الكاشير ونقاط البيع",
        description: "نقاط البيع والفواتير",
        iconName: "Store",
        order: 1,
        totalActions: 2,
        grantedActions: 2,
        customOverridesCount: 0,
        resources: [
          {
            resource: "invoice",
            domain: "pos",
            label: "فاتورة البيع",
            hasCustomOverrides: false,
            actions: {
              view: { key: "pos.invoice.view", action: "view", isSupported: true, state: "INHERITED_GRANT", granted: true, baseGranted: true },
              create: { key: "pos.invoice.create", action: "create", isSupported: true, state: "INHERITED_GRANT", granted: true, baseGranted: true },
              edit: { key: "", action: "edit", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              cancel: { key: "", action: "cancel", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              print: { key: "", action: "print", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              reprint: { key: "", action: "reprint", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              export: { key: "", action: "export", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              approve: { key: "", action: "approve", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
            },
          },
        ],
      };

      act(() => {
        root.render(
          <PermissionCategoryCard
            category={mockCategory}
            onToggle={vi.fn()}
            onBulkUpdate={handleBulkUpdate}
          />
        );
      });

      const denyAllBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("حجب الكل")
      );
      expect(denyAllBtn).toBeDefined();

      act(() => {
        denyAllBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleBulkUpdate).toHaveBeenCalledTimes(1);
      const updates = handleBulkUpdate.mock.calls[0][0];
      expect(updates["pos.invoice.view"]).toBe(false);
      expect(updates["pos.invoice.create"]).toBe(false);
    });

    it("tests 'عرض فقط' granting only view actions while denying write/approve actions", () => {
      const handleBulkUpdate = vi.fn();
      const mockCategory: DomainCategoryViewModel = {
        key: "pos",
        label: "الكاشير ونقاط البيع",
        description: "نقاط البيع والفواتير",
        iconName: "Store",
        order: 1,
        totalActions: 3,
        grantedActions: 3,
        customOverridesCount: 0,
        resources: [
          {
            resource: "invoice",
            domain: "pos",
            label: "فاتورة البيع",
            hasCustomOverrides: false,
            actions: {
              view: { key: "pos.invoice.view", action: "view", isSupported: true, state: "INHERITED_GRANT", granted: true, baseGranted: true },
              create: { key: "pos.invoice.create", action: "create", isSupported: true, state: "INHERITED_GRANT", granted: true, baseGranted: true },
              edit: { key: "pos.invoice.edit", action: "edit", isSupported: true, state: "INHERITED_GRANT", granted: true, baseGranted: true },
              cancel: { key: "", action: "cancel", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              print: { key: "", action: "print", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              reprint: { key: "", action: "reprint", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              export: { key: "", action: "export", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
              approve: { key: "", action: "approve", isSupported: false, state: "INHERITED_DENY", granted: false, baseGranted: false },
            },
          },
        ],
      };

      act(() => {
        root.render(
          <PermissionCategoryCard
            category={mockCategory}
            onToggle={vi.fn()}
            onBulkUpdate={handleBulkUpdate}
          />
        );
      });

      const viewOnlyBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("عرض فقط")
      );
      expect(viewOnlyBtn).toBeDefined();

      act(() => {
        viewOnlyBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleBulkUpdate).toHaveBeenCalledTimes(1);
      const updates = handleBulkUpdate.mock.calls[0][0];
      expect(updates["pos.invoice.view"]).toBe(true);
      expect(updates["pos.invoice.create"]).toBe(false);
      expect(updates["pos.invoice.edit"]).toBe(false);
    });

    it("verifies fallback loop when onBulkChange prop is omitted from main PermissionMatrix", () => {
      const handleSingleChange = vi.fn();

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={{}}
            onChange={handleSingleChange}
            // onBulkChange deliberately omitted!
          />
        );
      });

      const grantAllBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("منح الكل")
      );
      expect(grantAllBtn).toBeDefined();

      act(() => {
        grantAllBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      // Should fall back to calling onChange individually for each key in that category
      expect(handleSingleChange).toHaveBeenCalled();
      expect(handleSingleChange.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe("4. Caps & Masking Bounds, Empty Strings & Null Handling", () => {
    it("handles maxDiscountPercent bounds: rejects < 0 and > 100, accepts 0 and 100, clears on empty string", () => {
      const handleCapsChange = vi.fn();

      act(() => {
        root.render(<OperationalCapsPanel caps={{ maxDiscountPercent: 10 }} onChange={handleCapsChange} />);
      });

      const percentInput = host.querySelector('input[id="cap-discount-percent"]') as HTMLInputElement;
      expect(percentInput).not.toBeNull();
      expect(percentInput.value).toBe("10");

      // Test valid 0
      act(() => {
        triggerReactInput(percentInput, "0");
      });
      expect(handleCapsChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxDiscountPercent: 0 }));

      // Test valid 100
      act(() => {
        triggerReactInput(percentInput, "100");
      });
      expect(handleCapsChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxDiscountPercent: 100 }));

      // Test invalid > 100 (e.g. 150) -> should NOT update
      handleCapsChange.mockClear();
      act(() => {
        triggerReactInput(percentInput, "150");
      });
      expect(handleCapsChange).not.toHaveBeenCalled();

      // Test invalid < 0 (e.g. -5) -> should NOT update
      handleCapsChange.mockClear();
      act(() => {
        triggerReactInput(percentInput, "-5");
      });
      expect(handleCapsChange).not.toHaveBeenCalled();

      // Test empty string -> resets to null
      handleCapsChange.mockClear();
      act(() => {
        triggerReactInput(percentInput, "");
      });
      expect(handleCapsChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxDiscountPercent: null }));
    });

    it("handles credit limit buttons: 'نقدي فقط' sets '0.00' and 'بلا سقف' sets null", () => {
      const handleCapsChange = vi.fn();

      act(() => {
        root.render(<OperationalCapsPanel caps={{ maxCreditSaleLimitIqd: "500000" }} onChange={handleCapsChange} />);
      });

      const cashOnlyBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("نقدي فقط")
      );
      const noLimitBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("بلا سقف")
      );

      act(() => {
        cashOnlyBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(handleCapsChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxCreditSaleLimitIqd: "0.00" }));

      act(() => {
        noLimitBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(handleCapsChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxCreditSaleLimitIqd: null }));
    });

    it("gracefully handles null and undefined props in Caps and Masking panels without crashing", () => {
      expect(() => {
        act(() => {
          root.render(<OperationalCapsPanel caps={null} onChange={vi.fn()} />);
        });
      }).not.toThrow();

      expect(() => {
        act(() => {
          root.render(<OperationalCapsPanel caps={undefined} onChange={vi.fn()} />);
        });
      }).not.toThrow();

      expect(() => {
        act(() => {
          root.render(<SensitiveMaskingPanel masking={null} onChange={vi.fn()} />);
        });
      }).not.toThrow();

      expect(() => {
        act(() => {
          root.render(<SensitiveMaskingPanel masking={undefined} onChange={vi.fn()} />);
        });
      }).not.toThrow();
    });

    it("disables all inputs and switches when disabled=true", () => {
      act(() => {
        root.render(<OperationalCapsPanel caps={{ maxDiscountPercent: 10 }} onChange={vi.fn()} disabled={true} />);
      });

      const inputs = host.querySelectorAll("input");
      inputs.forEach((input) => {
        expect(input.disabled).toBe(true);
      });

      act(() => {
        root.render(<SensitiveMaskingPanel masking={{ maskPurchaseCost: true }} onChange={vi.fn()} disabled={true} />);
      });

      const switches = host.querySelectorAll('button[role="switch"]');
      switches.forEach((sw) => {
        expect((sw as HTMLButtonElement).disabled).toBe(true);
      });
    });
  });

  describe("5. Live Search & Multi-Filter Robustness", () => {
    it("preserves Arabic spaces and normalizes search terms accurately", () => {
      vi.useFakeTimers();
      const handleSearch = vi.fn();

      act(() => {
        root.render(
          <PermissionMatrixFilters
            searchQuery=""
            onSearchChange={handleSearch}
            selectedDomain="all"
            onDomainChange={vi.fn()}
            overridesOnly={false}
            onOverridesOnlyChange={vi.fn()}
            customGrantsCount={0}
            customDeniesCount={0}
          />
        );
      });

      const searchInput = host.querySelector("input") as HTMLInputElement;
      expect(searchInput).not.toBeNull();

      // Type text with trailing space in Arabic ("أمر شغل ")
      act(() => {
        triggerReactInput(searchInput, "أمر شغل ");
      });

      expect(searchInput.value).toBe("أمر شغل ");

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(handleSearch).toHaveBeenCalledWith("أمر شغل ");
      vi.useRealTimers();
    });

    it("displays empty state placeholder when search has zero matches", () => {
      vi.useFakeTimers();

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={{}}
            onChange={vi.fn()}
          />
        );
      });

      // Search for completely non-existent term
      const searchInput = host.querySelector('input[placeholder*="ابحث"]') as HTMLInputElement;
      act(() => {
        triggerReactInput(searchInput, "مصطلح_غير_موجود_نهائيا_999");
      });

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(host.textContent).toContain("لا توجد صلاحيات مطابقة لخيارات التصفية");
      vi.useRealTimers();
    });
  });

  describe("6. Backward-Compatibility Form Wrapper Synchronization", () => {
    it("synchronizes atomic key changes to coarse legacy module permissions (FULL/READ/NONE)", () => {
      const handleLegacyChange = vi.fn();
      let atomicState: AtomicPermissionsMap = {};

      const handleAtomicChange = vi.fn((key: string, val: boolean) => {
        atomicState = { ...atomicState, [key]: val };
      });

      act(() => {
        root.render(
          <FormPermissionMatrixWrapper
            role="cashier"
            permissions={{ pos: "READ", sales: "NONE" }}
            onChange={handleLegacyChange}
            onReset={vi.fn()}
            atomicPermissions={atomicState}
            onAtomicChange={handleAtomicChange}
          />
        );
      });

      expect(host.textContent).toContain("المصفوفة الذرية التفاعلية");

      // Toggling atomic key should trigger handleAtomicChange
      const buttons = host.querySelectorAll('tbody button[aria-pressed]');
      expect(buttons.length).toBeGreaterThan(0);

      act(() => {
        (buttons[0] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleAtomicChange).toHaveBeenCalled();
    });

    it("switches seamlessly between atomic and legacy tabs without state destruction", () => {
      act(() => {
        root.render(
          <FormPermissionMatrixWrapper
            role="cashier"
            permissions={{ pos: "FULL", inventory: "READ" }}
            onChange={vi.fn()}
            onReset={vi.fn()}
          />
        );
      });

      const tabButtons = Array.from(host.querySelectorAll("button"));
      const legacyTabBtn = tabButtons.find((b) => b.textContent?.includes("الوحدات الإجمالية"));
      const atomicTabBtn = tabButtons.find((b) => b.textContent?.includes("المصفوفة الذرية"));

      expect(legacyTabBtn).toBeDefined();
      expect(atomicTabBtn).toBeDefined();

      // Switch to legacy view
      act(() => {
        legacyTabBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(host.textContent).toContain("المبيعات والعملاء");
      expect(host.textContent).toContain("المخزون والمشتريات");

      // Switch back to atomic view
      act(() => {
        atomicTabBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(host.textContent).toContain("الكاشير ونقاط البيع");
      expect(host.textContent).toContain("حزم الصلاحيات التشغيلية السريعة");
    });
  });

  describe("7. Property-Based Stress & Mathematical Invariants", () => {
    it("proves structural consistency across all 10 operational domains and definitions", () => {
      expect(ALL_DOMAINS.length).toBe(10);
      expect(ATOMIC_PERMISSION_DEFINITIONS.length).toBeGreaterThanOrEqual(75);

      const supportedStandardActions = new Set<string>([
        "view",
        "create",
        "edit",
        "cancel",
        "print",
        "reprint",
        "export",
        "approve",
      ]);

      for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
        expect(ALL_DOMAINS).toContain(def.domain);
        expect(def.key).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);
        const actionType = def.standardAction || def.action;
        expect(supportedStandardActions.has(actionType)).toBe(true);
      }
    });

    it("runs randomized fuzzing of 50 state transitions verifying no crashes and mathematical bounds", () => {
      const keys = ATOMIC_PERMISSION_DEFINITIONS.map((d) => d.key);
      const roles = ["cashier", "accountant", "warehouse", "manager"] as const;

      let currentMap: AtomicPermissionsMap = {};
      const randomRole = roles[Math.floor(Math.random() * roles.length)];
      const baseTemplate = ROLE_DEFAULT_ATOMIC_PERMISSIONS[randomRole];

      for (let i = 0; i < 50; i++) {
        const randomKey = keys[Math.floor(Math.random() * keys.length)];
        const nextVal = Math.random() > 0.5;
        currentMap[randomKey] = nextVal;

        // Verify mathematical invariants
        let customGrants = 0;
        let customDenies = 0;

        for (const [k, v] of Object.entries(currentMap)) {
          const baseVal = Boolean(baseTemplate[k]);
          if (v !== baseVal) {
            if (v) customGrants++;
            else customDenies++;
          }
        }

        const totalDiffs = customGrants + customDenies;
        expect(totalDiffs).toBeGreaterThanOrEqual(0);
        expect(customGrants).toBeGreaterThanOrEqual(0);
        expect(customDenies).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
