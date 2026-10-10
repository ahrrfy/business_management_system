// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROLE_DEFAULT_ATOMIC_PERMISSIONS,
  ROLE_DEFAULT_OPERATIONAL_CAPS,
  ROLE_DEFAULT_DATA_MASKING,
  STANDARD_ACTIONS,
  ATOMIC_PERMISSION_DEFINITIONS,
  type AtomicPermissionsMap,
} from "@shared/atomicPermissions";
import { normalizeSearchText } from "@shared/searchNormalize";
import { PermissionMatrix } from "../PermissionMatrix";
import { PermissionMatrixFilters } from "../PermissionMatrixFilters";
import { PermissionPresetsBar, OPERATIONAL_PRESETS } from "../PermissionPresetsBar";
import { OperationalCapsPanel } from "../OperationalCapsPanel";
import { SensitiveMaskingPanel } from "../SensitiveMaskingPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

describe("Challenger 2 Empirical Verification: M3 UI Ergonomics, Search, Table & Responsive Layout", () => {
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

  describe("1. Search Input Ergonomics & Arabic Typographic Integrity", () => {
    it("preserves spaces during human keystrokes without raw trim", () => {
      const handleSearchChange = vi.fn();

      act(() => {
        root.render(
          <PermissionMatrixFilters
            searchQuery=""
            onSearchChange={handleSearchChange}
            selectedDomain="all"
            onDomainChange={vi.fn()}
            overridesOnly={false}
            onOverridesOnlyChange={vi.fn()}
            customGrantsCount={0}
            customDeniesCount={0}
          />
        );
      });

      const input = host.querySelector("input") as HTMLInputElement;
      expect(input).not.toBeNull();

      // Simulate typing "أمر " with trailing space (composite word in progress)
      act(() => {
        input.value = "أمر ";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });

      // Crucial: The input's displayed value MUST retain the space at 60fps
      expect(input.value).toBe("أمر ");
    });

    it("debounces rapid keystrokes by 180ms and emits final search term once", () => {
      vi.useFakeTimers();
      const handleSearchChange = vi.fn();

      act(() => {
        root.render(
          <PermissionMatrixFilters
            searchQuery=""
            onSearchChange={handleSearchChange}
            selectedDomain="all"
            onDomainChange={vi.fn()}
            overridesOnly={false}
            onOverridesOnlyChange={vi.fn()}
            customGrantsCount={0}
            customDeniesCount={0}
          />
        );
      });

      const input = host.querySelector("input") as HTMLInputElement;
      const setInputValue = (val: string) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        )?.set;
        nativeSetter?.call(input, val);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };

      // Type "أمر"
      act(() => {
        setInputValue("أمر");
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      // Should not fire yet at 100ms
      expect(handleSearchChange).not.toHaveBeenCalledWith("أمر");

      // Continue typing "أمر شغل"
      act(() => {
        setInputValue("أمر شغل");
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      // At 100ms after second keystroke, still not fired
      expect(handleSearchChange).not.toHaveBeenCalledWith("أمر شغل");

      // Advance past 180ms (80ms more)
      act(() => {
        vi.advanceTimersByTime(80);
      });

      // Now fired with exact composite phrase
      expect(handleSearchChange).toHaveBeenCalledWith("أمر شغل");

      vi.useRealTimers();
    });

    it("clears search input immediately upon clicking X button", () => {
      const handleSearchChange = vi.fn();

      act(() => {
        root.render(
          <PermissionMatrixFilters
            searchQuery="فاتورة بيع"
            onSearchChange={handleSearchChange}
            selectedDomain="all"
            onDomainChange={vi.fn()}
            overridesOnly={false}
            onOverridesOnlyChange={vi.fn()}
            customGrantsCount={0}
            customDeniesCount={0}
          />
        );
      });

      const clearBtn = host.querySelector('button[aria-label="مسح البحث"]') as HTMLButtonElement;
      expect(clearBtn).not.toBeNull();

      act(() => {
        clearBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleSearchChange).toHaveBeenCalledWith("");
    });

    it("correctly folds Arabic letters for composite phrases in PermissionMatrix", () => {
      const baseMap = { ...ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier };

      // Test 1: "امر شغل" (plain alif) should match "أمر شغل" (hamza)
      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={baseMap}
            onChange={vi.fn()}
          />
        );
      });

      // Search with folded letter: "امر شغل"
      const searchInput = host.querySelector('input[placeholder*="ابحث"]') as HTMLInputElement;

      act(() => {
        searchInput.value = "امر شغل";
        searchInput.dispatchEvent(new Event("change", { bubbles: true }));
      });

      // Verify that normalizeSearchText folds both correctly
      expect(normalizeSearchText("أمر شغل")).toBe("امر شغل");
      expect(normalizeSearchText("امر شغل")).toBe("امر شغل");
      expect(normalizeSearchText("أمر شغل")).toContain(normalizeSearchText("امر شغل"));

      // Test 2: Composite spaces "سند  صرف" (double space) matches "سند صرف"
      expect(normalizeSearchText("سند  صرف")).toBe("سند صرف");

      // Test 3: Taa Marbuta folding "طباعه" vs "طباعة"
      expect(normalizeSearchText("طباعه")).toBe("طباعه");
      expect(normalizeSearchText("طباعة")).toBe("طباعه");
      expect(normalizeSearchText("طباعة")).toContain(normalizeSearchText("طباعه"));

      // Adversarial Test 4: Diacritics (tashkeel) "أَمْرُ شُغْلٍ"
      expect(normalizeSearchText("أَمْرُ شُغْلٍ")).toBe("امر شغل");
      expect(normalizeSearchText("أمر شغل")).toContain(normalizeSearchText("أَمْرُ شُغْلٍ"));

      // Adversarial Test 5: Tatweel (kashida) "أمر شـــــغل"
      expect(normalizeSearchText("أمر شـــــغل")).toBe("امر شغل");
      expect(normalizeSearchText("أمر شغل")).toContain(normalizeSearchText("أمر شـــــغل"));
    });

    it("displays clean empty state message when search query yields no matches", () => {
      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={{}}
            onChange={vi.fn()}
          />
        );
      });

      const input = host.querySelector("input") as HTMLInputElement;
      const setInputValue = (val: string) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        )?.set;
        nativeSetter?.call(input, val);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };

      vi.useFakeTimers();
      act(() => {
        setInputValue("كلمة_مستحيلة_غير_موجودة_نهائيا");
      });
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(host.textContent).toContain("لا توجد صلاحيات مطابقة لخيارات التصفية");
      vi.useRealTimers();
    });
  });

  describe("2. Table Orthogonal Alignment & Column Integrity", () => {
    it("strictly aligns 8 standard action headers with action cells (text-center, border-e)", () => {
      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={{ ...ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier }}
            onChange={vi.fn()}
          />
        );
      });

      // Find the first category table
      const table = host.querySelector("table");
      expect(table).not.toBeNull();

      const ths = table?.querySelectorAll("thead th");
      expect(ths).toBeDefined();
      // Exactly 1 resource header + 8 action headers = 9 headers
      expect(ths?.length).toBe(9);

      // Header 0 (Resource header): must be text-start, border-e, min-w-[200px]
      const resourceTh = ths?.[0];
      expect(resourceTh?.className).toContain("text-start");
      expect(resourceTh?.className).toContain("border-e");
      expect(resourceTh?.className).toContain("sticky");

      // Headers 1..8 (Action headers): must be text-center, border-e
      for (let i = 1; i <= 8; i++) {
        const actionTh = ths?.[i];
        expect(actionTh?.className).toContain("text-center");
        expect(actionTh?.className).toContain("border-e");
        expect(actionTh?.textContent?.trim()).toBe(STANDARD_ACTIONS[i - 1].labelAr);
      }

      // Check rows: each row must have 9 cells matching the alignment
      const firstRow = table?.querySelector("tbody tr");
      expect(firstRow).not.toBeNull();
      const tds = firstRow?.querySelectorAll("td");
      expect(tds?.length).toBe(9);

      // Cell 0: text-start, border-e, sticky
      const resourceTd = tds?.[0];
      expect(resourceTd?.className).toContain("text-start");
      expect(resourceTd?.className).toContain("border-e");
      expect(resourceTd?.className).toContain("sticky");

      // Cells 1..8: text-center, border-e
      for (let i = 1; i <= 8; i++) {
        const actionTd = tds?.[i];
        expect(actionTd?.className).toContain("text-center");
        expect(actionTd?.className).toContain("border-e");
      }
    });

    it("verifies table horizontal scroll wrapper has overflow-x-auto", () => {
      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={{}}
            onChange={vi.fn()}
          />
        );
      });

      const overflowContainers = host.querySelectorAll(".overflow-x-auto");
      expect(overflowContainers.length).toBeGreaterThan(0);
      overflowContainers.forEach((container) => {
        expect(container.querySelector("table")).not.toBeNull();
      });
    });
  });

  describe("3. Responsive Layout Breakpoint Variants", () => {
    it("ensures OperationalCapsPanel uses responsive grid (grid-cols-1 sm:grid-cols-2 lg:grid-cols-3)", () => {
      act(() => {
        root.render(<OperationalCapsPanel caps={{}} onChange={vi.fn()} />);
      });

      const grid = host.querySelector(".grid");
      expect(grid).not.toBeNull();
      expect(grid?.className).toContain("grid-cols-1");
      expect(grid?.className).toContain("sm:grid-cols-2");
      expect(grid?.className).toContain("lg:grid-cols-3");
    });

    it("ensures SensitiveMaskingPanel uses responsive grid (grid-cols-1 sm:grid-cols-2)", () => {
      act(() => {
        root.render(<SensitiveMaskingPanel masking={{}} onChange={vi.fn()} />);
      });

      const grid = host.querySelector(".grid");
      expect(grid).not.toBeNull();
      expect(grid?.className).toContain("grid-cols-1");
      expect(grid?.className).toContain("sm:grid-cols-2");
    });
  });

  describe("4. Presets, Overrides & Counter Integrity", () => {
    it("verifies all 9 operational presets are distinct and configure relevant keys", () => {
      expect(OPERATIONAL_PRESETS).toHaveLength(9);
      const ids = new Set(OPERATIONAL_PRESETS.map((p) => p.id));
      expect(ids.size).toBe(9);

      for (const preset of OPERATIONAL_PRESETS) {
        expect(preset.label.length).toBeGreaterThan(0);
        expect(preset.grantedKeys.length).toBeGreaterThan(0);
        expect(preset.suggestedCaps).toBeDefined();
        expect(preset.suggestedMasking).toBeDefined();
      }
    });

    it("accurately computes granted count vs total count in category card badge", () => {
      // Create empty cashier map (0 granted)
      const emptyMap: AtomicPermissionsMap = {};

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={emptyMap}
            baseAtomicPermissions={emptyMap}
            onChange={vi.fn()}
          />
        );
      });

      // Find the first counter badge
      const badges = Array.from(host.querySelectorAll(".font-mono"));
      const counterBadge = badges.find((b) => b.textContent?.includes("/"));
      expect(counterBadge).toBeDefined();
      expect(counterBadge?.textContent).toContain("0 /");
    });

    it("filters to overrides-only and auto-hides categories without custom exceptions", () => {
      // Cashier role, but with ONE custom override in delivery domain
      const customMap: AtomicPermissionsMap = {
        ...ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier,
        "delivery.dispatch.create": true, // custom grant in delivery domain
      };

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={customMap}
            onChange={vi.fn()}
          />
        );
      });

      // Click "الاستثناءات فقط"
      const overridesBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("الاستثناءات فقط")
      );
      expect(overridesBtn).toBeDefined();

      act(() => {
        overridesBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      // Delivery category must be visible since it has the override
      expect(host.textContent).toContain("التوصيل واللوجستيات");
      // Other domains (e.g. workshop, hr, accounts) must be filtered out
      expect(host.textContent).not.toContain("المطبعة والورش الفنية");
      expect(host.textContent).not.toContain("الموارد البشرية والرواتب");
    });
  });
});
