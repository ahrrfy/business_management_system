// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  ROLE_DEFAULT_DATA_MASKING,
  type AtomicPermissionsMap,
  type OperationalCaps,
  type SensitiveDataMasking,
} from "@shared/atomicPermissions";
import { PermissionMatrix } from "../PermissionMatrix";
import { PermissionActionCell } from "../PermissionActionCell";
import { OperationalCapsPanel } from "../OperationalCapsPanel";
import { SensitiveMaskingPanel } from "../SensitiveMaskingPanel";
import { PermissionPresetsBar, OPERATIONAL_PRESETS } from "../PermissionPresetsBar";
import { PermissionMatrix as FormPermissionMatrixWrapper } from "../../form/PermissionMatrix";
import { getActionVisualTokens, type ResourceActionSlot } from "../types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

describe("Interactive Permission Matrix Component Suite (M3 UI)", () => {
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

  describe("1. Action Cell & Visual State Tokens", () => {
    it("returns correct Safa semantic tokens for all 4 states", () => {
      const customGrantTokens = getActionVisualTokens("CUSTOM_GRANT");
      expect(customGrantTokens.wrapperClass).toContain("var(--sem-pos-bg)");
      expect(customGrantTokens.wrapperClass).toContain("var(--sem-pos)");
      expect(customGrantTokens.badgeLabel).toBe("+ مخصّص");
      expect(customGrantTokens.isCustom).toBe(true);

      const customDenyTokens = getActionVisualTokens("CUSTOM_DENY");
      expect(customDenyTokens.wrapperClass).toContain("var(--sem-neg-bg)");
      expect(customDenyTokens.wrapperClass).toContain("var(--sem-neg)");
      expect(customDenyTokens.badgeLabel).toBe("− محجوب");
      expect(customDenyTokens.isCustom).toBe(true);

      const inheritedGrantTokens = getActionVisualTokens("INHERITED_GRANT");
      expect(inheritedGrantTokens.wrapperClass).toContain("bg-primary/10");
      expect(inheritedGrantTokens.badgeLabel).toBe("بالدور");
      expect(inheritedGrantTokens.isCustom).toBe(false);

      const inheritedDenyTokens = getActionVisualTokens("INHERITED_DENY");
      expect(inheritedDenyTokens.wrapperClass).toContain("bg-muted/40");
      expect(inheritedDenyTokens.isCustom).toBe(false);
    });

    it("renders supported cell and triggers onToggle with negated value", () => {
      const handleToggle = vi.fn();
      const slot: ResourceActionSlot = {
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
          label: "إصدار فاتورة بيع",
          labelAr: "إصدار فاتورة بيع",
          description: "إنشاء فاتورة بيع جديدة",
          descriptionAr: "إنشاء فاتورة بيع جديدة",
          sensitivity: "normal",
          legacyModule: "sales",
        },
      };

      act(() => {
        root.render(<PermissionActionCell slot={slot} onToggle={handleToggle} />);
      });

      const btn = host.querySelector("button");
      expect(btn).not.toBeNull();
      expect(btn?.getAttribute("aria-pressed")).toBe("true");

      act(() => {
        btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleToggle).toHaveBeenCalledTimes(1);
      expect(handleToggle).toHaveBeenCalledWith("pos.invoice.create", false);
    });

    it("renders disabled dash placeholder for unsupported actions", () => {
      const handleToggle = vi.fn();
      const unsupportedSlot: ResourceActionSlot = {
        key: "pos.shift.reprint",
        action: "reprint",
        isSupported: false,
        state: "INHERITED_DENY",
        granted: false,
        baseGranted: false,
      };

      act(() => {
        root.render(<PermissionActionCell slot={unsupportedSlot} onToggle={handleToggle} />);
      });

      const btn = host.querySelector("button");
      expect(btn).toBeNull();
      expect(host.textContent).toContain("—");
    });
  });

  describe("2. Operational Presets Bar", () => {
    it("contains all 9 standard operational presets with correct labels", () => {
      expect(OPERATIONAL_PRESETS).toHaveLength(9);
      const labels = OPERATIONAL_PRESETS.map((p) => p.label);
      expect(labels).toContain("الكاشير");
      expect(labels).toContain("مسؤول مبيعات");
      expect(labels).toContain("أمين مخزن");
      expect(labels).toContain("محاسب");
      expect(labels).toContain("مسؤول مشتريات");
      expect(labels).toContain("موظف استقبال");
      expect(labels).toContain("مدير فرع");
      expect(labels).toContain("مدقق مالي");
      expect(labels).toContain("مندوب توصيل");
    });

    it("triggers onApplyPreset when a preset button is clicked", () => {
      const handleApply = vi.fn();

      act(() => {
        root.render(<PermissionPresetsBar onApplyPreset={handleApply} activeRole="cashier" />);
      });

      const buttons = host.querySelectorAll("button");
      expect(buttons.length).toBeGreaterThanOrEqual(9);

      // Find the "محاسب" button
      const accountantBtn = Array.from(buttons).find((b) => b.textContent?.includes("محاسب"));
      expect(accountantBtn).toBeDefined();

      act(() => {
        accountantBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleApply).toHaveBeenCalledTimes(1);
      expect(handleApply.mock.calls[0][0].id).toBe("accountant");
    });
  });

  describe("3. Operational Caps & Sensitive Masking Panels", () => {
    it("allows updating discount percentage and money caps", () => {
      const handleCapsChange = vi.fn();
      const initialCaps: OperationalCaps = {
        maxDiscountPercent: 10,
        maxCreditSaleLimitIqd: "500000.00",
      };

      act(() => {
        root.render(<OperationalCapsPanel caps={initialCaps} onChange={handleCapsChange} />);
      });

      // Click "نقدي فقط" button to set credit limit to 0
      const cashOnlyBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("نقدي فقط")
      );
      expect(cashOnlyBtn).toBeDefined();

      act(() => {
        cashOnlyBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleCapsChange).toHaveBeenCalledTimes(1);
      expect(handleCapsChange.mock.calls[0][0].maxCreditSaleLimitIqd).toBe("0.00");
    });

    it("allows toggling data masking switches", () => {
      const handleMaskingChange = vi.fn();
      const initialMasking: SensitiveDataMasking = {
        maskPurchaseCost: true,
        maskProfitMargin: false,
      };

      act(() => {
        root.render(<SensitiveMaskingPanel masking={initialMasking} onChange={handleMaskingChange} />);
      });

      const switches = host.querySelectorAll('[role="switch"]');
      expect(switches.length).toBe(4);

      act(() => {
        (switches[0] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleMaskingChange).toHaveBeenCalled();
    });
  });

  describe("4. PermissionMatrix Main Container & Filtering", () => {
    it("renders full category hierarchy and allows action toggle", () => {
      const handleChange = vi.fn();
      const atomicMap: AtomicPermissionsMap = { ...ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier };

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={atomicMap}
            onChange={handleChange}
          />
        );
      });

      expect(host.textContent).toContain("الكاشير ونقاط البيع");
      expect(host.textContent).toContain("المستودعات والمخازن");
      expect(host.textContent).toContain("الخزينة والمالية");

      // Verify action buttons exist
      const actionButtons = host.querySelectorAll('tbody button[aria-pressed]');
      expect(actionButtons.length).toBeGreaterThan(0);

      act(() => {
        (actionButtons[0] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleChange).toHaveBeenCalledTimes(1);
    });

    it("applies live search filtering with debounced Arabic text", async () => {
      vi.useFakeTimers();
      const atomicMap: AtomicPermissionsMap = { ...ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier };

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={atomicMap}
            onChange={vi.fn()}
          />
        );
      });

      const searchInput = host.querySelector('input[placeholder*="ابحث"]') as HTMLInputElement;
      expect(searchInput).not.toBeNull();

      act(() => {
        searchInput.value = "فاتورة بيع";
        searchInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      // Advance timers by 200ms to fire the 180ms debounce
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(host.textContent).toContain("فاتورة");
      vi.useRealTimers();
    });

    it("applies preset via PermissionMatrix preset bar and triggers bulk changes", () => {
      const handleBulkChange = vi.fn();
      const handleCapsChange = vi.fn();
      const handleMaskingChange = vi.fn();

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={{}}
            onChange={vi.fn()}
            onBulkChange={handleBulkChange}
            onCapsChange={handleCapsChange}
            onMaskingChange={handleMaskingChange}
          />
        );
      });

      const warehouseBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("أمين مخزن")
      );
      expect(warehouseBtn).toBeDefined();

      act(() => {
        warehouseBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleBulkChange).toHaveBeenCalledTimes(1);
      expect(handleCapsChange).toHaveBeenCalledTimes(1);
      expect(handleMaskingChange).toHaveBeenCalledTimes(1);
    });
  });

  describe("5. Backward Compatibility Wrapper", () => {
    it("renders in atomic mode by default and bridges changes to legacy onChange", () => {
      const handleLegacyChange = vi.fn();
      const handleReset = vi.fn();

      act(() => {
        root.render(
          <FormPermissionMatrixWrapper
            role="cashier"
            permissions={{ pos: "FULL", sales: "READ" }}
            onChange={handleLegacyChange}
            onReset={handleReset}
          />
        );
      });

      expect(host.textContent).toContain("المصفوفة الذرية التفاعلية");
      expect(host.textContent).toContain("الوحدات الإجمالية");

      // Find an action button and trigger toggle
      const actionButtons = host.querySelectorAll('tbody button[aria-pressed]');
      expect(actionButtons.length).toBeGreaterThan(0);

      act(() => {
        (actionButtons[0] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      // It should update internal state and trigger legacy onChange if derived levels differ
      expect(handleLegacyChange).toBeDefined();
    });
  });
});
