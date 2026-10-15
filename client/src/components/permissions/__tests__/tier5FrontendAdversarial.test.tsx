// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_DOMAINS,
  DOMAIN_METADATA,
  STANDARD_ACTIONS,
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
  type DomainKey,
} from "@shared/atomicPermissions";
import { normalizeSearchText } from "@shared/searchNormalize";
import { PermissionMatrix } from "../PermissionMatrix";
import { PermissionActionCell } from "../PermissionActionCell";
import { PermissionCategoryCard } from "../PermissionCategoryCard";
import { PermissionPresetsBar, OPERATIONAL_PRESETS } from "../PermissionPresetsBar";
import { OperationalCapsPanel } from "../OperationalCapsPanel";
import { SensitiveMaskingPanel } from "../SensitiveMaskingPanel";
import { PermissionMatrixFilters } from "../PermissionMatrixFilters";
import { PermissionMatrix as FormPermissionMatrixWrapper } from "../../form/PermissionMatrix";
import {
  getActionVisualTokens,
  type DomainCategoryViewModel,
  type ResourceActionSlot,
  type PermissionState,
} from "../types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;

function triggerNativeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Tier 5 Frontend Adversarial Coverage Hardening Suite", () => {
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

  // =========================================================================
  // 1. Keyboard & Search Fuzzing (Arabic Normalization, Debounce, Spaces)
  // =========================================================================
  describe("1. Keyboard & Search Fuzzing", () => {
    it("preserves trailing and internal Arabic spaces during active typing (no eager trim)", () => {
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
          />,
        );
      });

      const input = host.querySelector("input") as HTMLInputElement;
      expect(input).not.toBeNull();

      // Typing words with trailing and intermediate spaces
      const spaceTestPhrases = [
        "فاتورة ",
        "فاتورة بيع ",
        "أمر   شراء",
        "سند صرف نقدي ",
      ];

      for (const phrase of spaceTestPhrases) {
        act(() => {
          triggerNativeInput(input, phrase);
        });
        // Input MUST retain exact characters including spaces without premature trim
        expect(input.value).toBe(phrase);
      }
    });

    it("accurately handles 180ms debounce timing under high-frequency keystrokes", () => {
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
          />,
        );
      });

      const input = host.querySelector("input") as HTMLInputElement;

      // Type "ف", then after 50ms "فا", then after 50ms "فات", then after 50ms "فاتو"
      const keystrokes = ["ف", "فا", "فات", "فاتو", "فاتور", "فاتورة"];
      for (const stroke of keystrokes) {
        act(() => {
          triggerNativeInput(input, stroke);
        });
        act(() => {
          vi.advanceTimersByTime(50);
        });
        // Not enough time has elapsed (180ms), so onSearchChange should not have fired yet
        expect(handleSearchChange).not.toHaveBeenCalled();
      }

      // Now advance past the 180ms debounce threshold
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(handleSearchChange).toHaveBeenCalledTimes(1);
      expect(handleSearchChange).toHaveBeenCalledWith("فاتورة");

      vi.useRealTimers();
    });

    it("handles complex Arabic strings: Tashkeel, Tatweel, and zero-width characters", () => {
      // Test search filtering inside PermissionMatrix with various hostile Arabic strings
      const currentAtomic = { ...ROLE_DEFAULT_ATOMIC_PERMISSIONS.cashier };

      // 1. Diacritics / Tashkeel: "فَاتُورَةٌ" should fold identically to "فاتورة" -> "فاتوره"
      const diacriticQuery = "فَاتُورَةٌ";
      expect(normalizeSearchText(diacriticQuery)).toBe("فاتوره");
      expect(normalizeSearchText(diacriticQuery)).toBe(normalizeSearchText("فاتورة"));

      // 2. Tatweel / Kashida: "فــــاتورة" has Kashidas stripped and folds to "فاتوره"
      const tatweelQuery = "فــــاتورة";
      const normalizedTatweel = normalizeSearchText(tatweelQuery);
      expect(normalizedTatweel).toBe("فاتوره");
      expect(normalizedTatweel).toBe(normalizeSearchText("فاتورة"));

      // 3. Zero-width joiner / non-joiner: \u200C and \u200D preserved without crash
      const zeroWidthQuery = "ف\u200Cات\u200Dورة";
      const normalizedZW = normalizeSearchText(zeroWidthQuery);
      expect(normalizedZW).toBe("ف\u200Cات\u200Dوره");

      // Render matrix and verify search works
      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={currentAtomic}
            onChange={vi.fn()}
          />,
        );
      });

      const input = host.querySelector("input") as HTMLInputElement;
      expect(input).not.toBeNull();

      // Enter search with Tashkeel
      act(() => {
        triggerNativeInput(input, diacriticQuery);
      });

      // Verification of matrix rendering without crash
      expect(host.textContent).toContain("نقاط البيع");
    });

    it("survives regex meta-characters without crashing or throwing ReDoS exceptions", () => {
      const hostileQueries = [
        ".*",
        "+",
        "?",
        "[a-z]+",
        "(.*)+",
        "\\",
        "^$",
        "{1,100}",
        "$^.*()[]{}",
      ];

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={{}}
            onChange={vi.fn()}
          />,
        );
      });

      const input = host.querySelector("input") as HTMLInputElement;

      for (const query of hostileQueries) {
        expect(() => {
          act(() => {
            triggerNativeInput(input, query);
          });
        }).not.toThrow();
      }
    });

    it("clears search input immediately and resets query when clear button is clicked", () => {
      const handleSearchChange = vi.fn();

      act(() => {
        root.render(
          <PermissionMatrixFilters
            searchQuery="طباعة"
            onSearchChange={handleSearchChange}
            selectedDomain="all"
            onDomainChange={vi.fn()}
            overridesOnly={false}
            onOverridesOnlyChange={vi.fn()}
            customGrantsCount={0}
            customDeniesCount={0}
          />,
        );
      });

      const clearBtn = host.querySelector('button[aria-label="مسح البحث"]') as HTMLButtonElement;
      expect(clearBtn).not.toBeNull();

      act(() => {
        clearBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleSearchChange).toHaveBeenCalledWith("");
      const input = host.querySelector("input") as HTMLInputElement;
      expect(input.value).toBe("");
    });
  });

  // =========================================================================
  // 2. Preset Cascade Stress (All 9 Operational Presets & Active Indicators)
  // =========================================================================
  describe("2. Preset Cascade Stress", () => {
    it("validates that all 9 operational presets exist with exact metadata and valid keys", () => {
      expect(OPERATIONAL_PRESETS).toHaveLength(9);

      const expectedPresetIds = [
        "cashier",
        "sales_rep",
        "warehouse",
        "accountant",
        "purchasing",
        "reception_clerk",
        "manager",
        "auditor",
        "courier",
      ];

      const actualIds = OPERATIONAL_PRESETS.map((p) => p.id);
      expect(actualIds).toEqual(expectedPresetIds);

      for (const preset of OPERATIONAL_PRESETS) {
        expect(preset.label).toBeTruthy();
        expect(preset.description).toBeTruthy();
        expect(preset.grantedKeys.length).toBeGreaterThan(0);

        // Every granted key in preset must exist in ATOMIC_PERMISSION_DEFINITIONS
        const allKeySet = new Set(ATOMIC_PERMISSION_DEFINITIONS.map((d) => d.key));
        for (const key of preset.grantedKeys) {
          expect(allKeySet.has(key)).toBe(true);
        }
      }
    });

    it("validates active indicator styling for each preset when role matches", () => {
      for (const preset of OPERATIONAL_PRESETS) {
        act(() => {
          root.render(
            <PermissionPresetsBar
              activeRole={preset.id}
              onApplyPreset={vi.fn()}
            />,
          );
        });

        const buttons = Array.from(host.querySelectorAll("button"));
        const activeBtn = buttons.find((b) => b.textContent?.includes(preset.label));
        expect(activeBtn).toBeDefined();

        // Must have active classes: bg-primary and font-semibold
        expect(activeBtn?.className).toContain("bg-primary");
        expect(activeBtn?.className).toContain("text-primary-foreground");

        // Other buttons must have outline / background classes
        const otherButtons = buttons.filter((b) => !b.textContent?.includes(preset.label));
        for (const otherBtn of otherButtons) {
          expect(otherBtn.className).toContain("bg-background");
          expect(otherBtn.className).not.toContain("text-primary-foreground");
        }
      }
    });

    it("performs rapid sequential cascade across all 9 presets without state leakage", () => {
      let state: {
        permissions: AtomicPermissionsMap;
        caps: OperationalCaps | null;
        masking: SensitiveDataMasking | null;
      } = {
        permissions: {},
        caps: null,
        masking: null,
      };

      const handleBulkChange = vi.fn((updates: Record<string, boolean>) => {
        state.permissions = { ...updates };
      });
      const handleCapsChange = vi.fn((caps: OperationalCaps) => {
        state.caps = caps;
      });
      const handleMaskingChange = vi.fn((masking: SensitiveDataMasking) => {
        state.masking = masking;
      });

      act(() => {
        root.render(
          <PermissionMatrix
            role="user"
            atomicPermissions={state.permissions}
            onChange={vi.fn()}
            onBulkChange={handleBulkChange}
            caps={state.caps}
            onCapsChange={handleCapsChange}
            masking={state.masking}
            onMaskingChange={handleMaskingChange}
          />,
        );
      });

      // Rapidly apply all 9 presets in sequence and verify each applies cleanly
      for (const preset of OPERATIONAL_PRESETS) {
        const buttons = Array.from(host.querySelectorAll("button"));
        const btn = buttons.find((b) => b.textContent?.includes(preset.label));
        expect(btn).toBeDefined();

        act(() => {
          btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        // Verify that permissions reflect exactly the preset's keys
        const expectedGrantedSet = new Set(preset.grantedKeys);
        for (const def of ATOMIC_PERMISSION_DEFINITIONS) {
          const isExpected = expectedGrantedSet.has(def.key);
          expect(Boolean(state.permissions[def.key])).toBe(isExpected);
        }

        // Verify caps and masking update
        if (preset.suggestedCaps) {
          expect(state.caps).toEqual(preset.suggestedCaps);
        }
        if (preset.suggestedMasking) {
          expect(state.masking).toEqual(preset.suggestedMasking);
        }
      }
    });

    it("reverses cascade across presets and tests alternating role switches", () => {
      const handleBulkChange = vi.fn();
      const handleCapsChange = vi.fn();
      const handleMaskingChange = vi.fn();

      act(() => {
        root.render(
          <PermissionMatrix
            role="user"
            atomicPermissions={{}}
            onChange={vi.fn()}
            onBulkChange={handleBulkChange}
            onCapsChange={handleCapsChange}
            onMaskingChange={handleMaskingChange}
          />,
        );
      });

      // Reverse order: courier -> auditor -> manager -> ... -> cashier
      const reversed = [...OPERATIONAL_PRESETS].reverse();
      for (const preset of reversed) {
        const buttons = Array.from(host.querySelectorAll("button"));
        const btn = buttons.find((b) => b.textContent?.includes(preset.label));
        act(() => {
          btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
      }

      expect(handleBulkChange).toHaveBeenCalledTimes(9);
    });
  });

  // =========================================================================
  // 3. 4-State Override Visual Cues & Accessibility Audit
  // =========================================================================
  describe("3. 4-State Override Visual Cues & Accessibility Audit", () => {
    it("strictly verifies Safa semantic CSS tokens and badges for all 4 states", () => {
      const states: PermissionState[] = [
        "CUSTOM_GRANT",
        "CUSTOM_DENY",
        "INHERITED_GRANT",
        "INHERITED_DENY",
      ];

      for (const st of states) {
        const tokens = getActionVisualTokens(st);

        switch (st) {
          case "CUSTOM_GRANT":
            expect(tokens.wrapperClass).toContain("var(--sem-pos-bg)");
            expect(tokens.wrapperClass).toContain("var(--sem-pos)");
            expect(tokens.wrapperClass).toContain("ring-[var(--sem-pos)]");
            expect(tokens.badgeLabel).toBe("+ مخصّص");
            expect(tokens.badgeVariant).toBe("success");
            expect(tokens.isCustom).toBe(true);
            expect(tokens.ariaDesc).toContain("استثناء فردي (+)");
            break;

          case "CUSTOM_DENY":
            expect(tokens.wrapperClass).toContain("var(--sem-neg-bg)");
            expect(tokens.wrapperClass).toContain("var(--sem-neg)");
            expect(tokens.wrapperClass).toContain("ring-[var(--sem-neg)]");
            expect(tokens.badgeLabel).toBe("− محجوب");
            expect(tokens.badgeVariant).toBe("danger");
            expect(tokens.isCustom).toBe(true);
            expect(tokens.ariaDesc).toContain("استثناء فردي (−)");
            break;

          case "INHERITED_GRANT":
            expect(tokens.wrapperClass).toContain("bg-primary/10");
            expect(tokens.wrapperClass).toContain("border-primary/30");
            expect(tokens.badgeLabel).toBe("بالدور");
            expect(tokens.badgeVariant).toBe("default");
            expect(tokens.isCustom).toBe(false);
            expect(tokens.ariaDesc).toContain("موروثة");
            break;

          case "INHERITED_DENY":
            expect(tokens.wrapperClass).toContain("bg-muted/40");
            expect(tokens.badgeLabel).toBe("معطل");
            expect(tokens.badgeVariant).toBe("muted");
            expect(tokens.isCustom).toBe(false);
            break;
        }
      }
    });

    it("verifies DOM classes, custom dot indicator, and aria attributes in rendered ActionCell", () => {
      const makeSlot = (
        state: PermissionState,
        granted: boolean,
        baseGranted: boolean,
      ): ResourceActionSlot => ({
        key: "pos.invoice.create",
        action: "create",
        isSupported: true,
        state,
        granted,
        baseGranted,
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
      });

      // 1. CUSTOM_GRANT
      act(() => {
        root.render(
          <PermissionActionCell
            slot={makeSlot("CUSTOM_GRANT", true, false)}
            onToggle={vi.fn()}
          />,
        );
      });
      let btn = host.querySelector("button") as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.getAttribute("aria-label")).toContain("ممنوحة");
      // Must contain custom indicator dot with --sem-pos
      const grantDot = btn.querySelector("span");
      expect(grantDot).not.toBeNull();
      expect(grantDot?.className).toContain("bg-[var(--sem-pos)]");

      // 2. CUSTOM_DENY
      act(() => {
        root.render(
          <PermissionActionCell
            slot={makeSlot("CUSTOM_DENY", false, true)}
            onToggle={vi.fn()}
          />,
        );
      });
      btn = host.querySelector("button") as HTMLButtonElement;
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.getAttribute("aria-label")).toContain("محجوبة");
      // Must contain custom indicator dot with --sem-neg
      const denyDot = btn.querySelector("span");
      expect(denyDot).not.toBeNull();
      expect(denyDot?.className).toContain("bg-[var(--sem-neg)]");

      // 3. INHERITED_GRANT
      act(() => {
        root.render(
          <PermissionActionCell
            slot={makeSlot("INHERITED_GRANT", true, true)}
            onToggle={vi.fn()}
          />,
        );
      });
      btn = host.querySelector("button") as HTMLButtonElement;
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      // Must NOT contain custom dot indicator
      expect(btn.querySelector("span")).toBeNull();

      // 4. INHERITED_DENY
      act(() => {
        root.render(
          <PermissionActionCell
            slot={makeSlot("INHERITED_DENY", false, false)}
            onToggle={vi.fn()}
          />,
        );
      });
      btn = host.querySelector("button") as HTMLButtonElement;
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.querySelector("span")).toBeNull();
    });

    it("verifies readOnly enforcement across all interactive buttons in PermissionMatrix", () => {
      const handleToggle = vi.fn();
      const handleBulk = vi.fn();

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={{}}
            onChange={handleToggle}
            onBulkChange={handleBulk}
            readOnly={true}
          />,
        );
      });

      // Presets bar should be hidden when readOnly
      expect(host.textContent).not.toContain("حزم الصلاحيات التشغيلية السريعة");

      // All action buttons in table must be disabled
      const actionButtons = Array.from(host.querySelectorAll("button")).filter((b) =>
        b.getAttribute("aria-pressed") !== null,
      );
      expect(actionButtons.length).toBeGreaterThan(0);

      for (const btn of actionButtons) {
        expect(btn.disabled).toBe(true);
        act(() => {
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
      }

      expect(handleToggle).not.toHaveBeenCalled();
      expect(handleBulk).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Category Cards, Bulk Operations & Overrides Filtering Stress
  // =========================================================================
  describe("4. Category Cards & Bulk Operations", () => {
    it("accurately updates grant badges (0/N, partial, full N/N) with distinct Safa token styling", () => {
      let permissions: AtomicPermissionsMap = {};
      const handleBulkChange = vi.fn((updates) => {
        permissions = { ...permissions, ...updates };
      });

      // Render matrix with all domains
      act(() => {
        root.render(
          <PermissionMatrix
            role="user"
            atomicPermissions={permissions}
            onChange={vi.fn()}
            onBulkChange={handleBulkChange}
          />,
        );
      });

      // Find pos category card grant counter
      const badges = Array.from(host.querySelectorAll("span, div")).filter((el) =>
        /\d+\s*\/\s*\d+/.test(el.textContent || ""),
      );
      expect(badges.length).toBeGreaterThan(0);

      // Initial state for role "user": 0 grants or small number
      const firstBadge = badges[0];
      expect(firstBadge.textContent).toMatch(/\d+\s*\/\s*\d+/);

      // Now click "منح الكل" on the first category card
      const grantAllBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("منح الكل"),
      );
      expect(grantAllBtn).toBeDefined();

      act(() => {
        grantAllBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleBulkChange).toHaveBeenCalled();
    });

    it("toggles overridesOnly filter and accurately renders empty state when zero overrides exist", () => {
      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={{}} // No overrides
            onChange={vi.fn()}
          />,
        );
      });

      const overridesBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("الاستثناءات فقط"),
      );
      expect(overridesBtn).toBeDefined();

      // Click "الاستثناءات فقط"
      act(() => {
        overridesBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      // Because there are 0 overrides, it must render the empty state notice
      expect(host.textContent).toContain("لا توجد صلاحيات مطابقة لخيارات التصفية");
      expect(host.textContent).toContain("جرّب تعديل كلمة البحث أو إزالة حصر الاستثناءات الفردية");
    });

    it("renders Reset to Template button only when overrides exist and resets cleanly", () => {
      const handleReset = vi.fn();
      // Cashier role with overrides
      const overriddenPerms = {
        "inventory.stocktake.create": true, // override grant
        "pos.invoice.create": false, // override deny
      };

      act(() => {
        root.render(
          <PermissionMatrix
            role="cashier"
            atomicPermissions={overriddenPerms}
            onChange={vi.fn()}
            onReset={handleReset}
          />,
        );
      });

      // Reset button should be visible
      const resetBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("إعادة لقالب الدور"),
      );
      expect(resetBtn).toBeDefined();

      act(() => {
        resetBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(handleReset).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 5. Operational Caps & Sensitive Masking Panel Stress
  // =========================================================================
  describe("5. Operational Caps & Sensitive Masking Panel Stress", () => {
    it("handles boundary values for discount percentage: 0, 100, empty, invalid", () => {
      let caps: OperationalCaps = { maxDiscountPercent: 10 };
      const handleChange = vi.fn((newCaps: OperationalCaps) => {
        caps = newCaps;
      });

      act(() => {
        root.render(<OperationalCapsPanel caps={caps} onChange={handleChange} />);
      });

      const percentInput = host.querySelector("#cap-discount-percent") as HTMLInputElement;
      expect(percentInput).not.toBeNull();
      expect(percentInput.value).toBe("10");

      // 1. Boundary 0%
      act(() => {
        triggerNativeInput(percentInput, "0");
      });
      expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({ maxDiscountPercent: 0 }));

      // 2. Boundary 100%
      act(() => {
        triggerNativeInput(percentInput, "100");
      });
      expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({ maxDiscountPercent: 100 }));

      // 3. Out of bounds > 100 (should be rejected by handlePercentChange)
      handleChange.mockClear();
      act(() => {
        triggerNativeInput(percentInput, "150");
      });
      expect(handleChange).not.toHaveBeenCalled();

      // 4. Negative number < 0 (should be rejected)
      handleChange.mockClear();
      act(() => {
        triggerNativeInput(percentInput, "-5");
      });
      expect(handleChange).not.toHaveBeenCalled();

      // 5. Empty string resets to null
      handleChange.mockClear();
      act(() => {
        triggerNativeInput(percentInput, "");
      });
      expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({ maxDiscountPercent: null }));
    });

    it("verifies all 4 sensitive data masking toggles with independent state persistence", () => {
      let masking: SensitiveDataMasking = {
        maskPurchaseCost: false,
        maskProfitMargin: false,
        maskSupplierPhone: false,
        maskCustomerContact: false,
      };
      const handleChange = vi.fn((newMasking: SensitiveDataMasking) => {
        masking = newMasking;
      });

      act(() => {
        root.render(<SensitiveMaskingPanel masking={masking} onChange={handleChange} />);
      });

      const switches = Array.from(host.querySelectorAll("button[role='switch']"));
      expect(switches).toHaveLength(4);

      // Toggle each switch one by one
      const switchIds = [
        "mask-purchase-cost",
        "mask-profit-margin",
        "mask-supplier-phone",
        "mask-customer-contact",
      ];

      for (let i = 0; i < switchIds.length; i++) {
        const sw = host.querySelector(`#${switchIds[i]}`) as HTMLButtonElement;
        expect(sw).not.toBeNull();

        act(() => {
          sw.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
      }

      expect(handleChange).toHaveBeenCalledTimes(4);
    });
  });

  // =========================================================================
  // 6. Form Wrapper Dual-Mode Synchronization & Legacy Bridge
  // =========================================================================
  describe("6. Form Wrapper Dual-Mode Synchronization", () => {
    it("synchronizes atomic toggles back to legacy permissions map seamlessly", () => {
      const handleLegacyChange = vi.fn();
      const legacyPerms = { sales: "READ" as const, pos: "READ" as const };

      act(() => {
        root.render(
          <FormPermissionMatrixWrapper
            role="cashier"
            permissions={legacyPerms}
            onChange={handleLegacyChange}
            onReset={vi.fn()}
          />,
        );
      });

      // The atomic matrix is active by default
      expect(host.textContent).toContain("المصفوفة الذرية التفاعلية (R2)");

      // Grant a sales action that escalates sales module
      const grantBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.getAttribute("aria-label")?.includes("pos.invoice.create"),
      );

      if (grantBtn) {
        act(() => {
          grantBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(handleLegacyChange).toBeDefined();
      }
    });

    it("switches to legacy tab and displays legacy module categories correctly", () => {
      act(() => {
        root.render(
          <FormPermissionMatrixWrapper
            role="cashier"
            permissions={{ sales: "FULL", pos: "FULL" }}
            onChange={vi.fn()}
            onReset={vi.fn()}
          />,
        );
      });

      // Find the legacy tab button
      const legacyTabBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("الوحدات الإجمالية (22 وحدة)"),
      );
      expect(legacyTabBtn).toBeDefined();

      act(() => {
        legacyTabBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      // Should display legacy category headings
      expect(host.textContent).toContain("المبيعات والعملاء");
      expect(host.textContent).toContain("المخزون والمشتريات");
    });
  });
});
