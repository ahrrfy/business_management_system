// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BundleKitMaterialsStep } from "../BundleKitMaterialsStep";
import { BundleKitReviewStep } from "../BundleKitReviewStep";
import type { AggregatedMaterialDto, ComponentRequirementDto } from "@shared/bundleProductionTypes";
import type { BundleKitComponentBatch } from "../BundleKitComponentsStep";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Bundle Kit Dialog Badges & Action Buttons Layout Contract", () => {
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

  const mockMaterials: AggregatedMaterialDto[] = [
    {
      materialVariantId: 301,
      materialName: "ورق طباعة 80 غم",
      sku: "PAPER-80G",
      unitName: "ماوع",
      totalRequiredBase: "5",
      availableInBranch: 10,
      isSufficient: true,
      deficitBase: "0",
      isSubstituted: false,
    },
    {
      materialVariantId: 302,
      materialName: "كرتون مقوى 300 غم",
      sku: "BOARD-300G",
      unitName: "لوح",
      totalRequiredBase: "20",
      availableInBranch: 5,
      isSufficient: false,
      deficitBase: "15",
      isSubstituted: false,
    },
    {
      materialVariantId: 303,
      materialName: "غراء تجليد حراري",
      sku: "GLUE-HOT",
      unitName: "كغم",
      totalRequiredBase: "2",
      availableInBranch: 5,
      isSufficient: true,
      deficitBase: "0",
      isSubstituted: true,
      originalMaterialName: "غراء سائل أبيض",
    },
  ];

  it("BundleKitMaterialsStep: تلتزم شارة السقف الممكن وعنق الزجاجة بـ whitespace-nowrap shrink-0", () => {
    act(() => {
      root.render(
        <BundleKitMaterialsStep
          materials={mockMaterials}
          maxBundlesPossible={5}
          limitingFactorName="كرتون مقوى 300 غم"
          limitingFactorType="RAW_MATERIAL"
          requestedBundleQty={10}
          branchId={1}
          materialSubstitutions={[]}
          onApplySubstitution={vi.fn()}
          onRemoveSubstitution={vi.fn()}
        />,
      );
    });

    const ceilingBadge = Array.from(
      host.querySelectorAll<HTMLElement>("[data-slot='badge']"),
    ).find((el) => el.textContent?.includes("السقف الممكن: 5 طقم"));
    expect(ceilingBadge).toBeDefined();
    expect(ceilingBadge?.className).toContain("whitespace-nowrap");
    expect(ceilingBadge?.className).toContain("shrink-0");
  });

  it("BundleKitMaterialsStep: تلتزم شارات الكفاية والعجز والبديل بـ whitespace-nowrap shrink-0", () => {
    act(() => {
      root.render(
        <BundleKitMaterialsStep
          materials={mockMaterials}
          maxBundlesPossible={5}
          limitingFactorName="كرتون مقوى 300 غم"
          limitingFactorType="RAW_MATERIAL"
          requestedBundleQty={10}
          branchId={1}
          materialSubstitutions={[]}
          onApplySubstitution={vi.fn()}
          onRemoveSubstitution={vi.fn()}
        />,
      );
    });

    const sufficientBadge = Array.from(
      host.querySelectorAll<HTMLElement>("[data-slot='badge']"),
    ).find((el) => el.textContent?.trim() === "متوفر بكفاية");
    expect(sufficientBadge).toBeDefined();
    expect(sufficientBadge?.className).toContain("whitespace-nowrap");
    expect(sufficientBadge?.className).toContain("shrink-0");

    const deficitBadge = Array.from(
      host.querySelectorAll<HTMLElement>("[data-slot='badge']"),
    ).find((el) => el.textContent?.trim() === "غير كافٍ");
    expect(deficitBadge).toBeDefined();
    expect(deficitBadge?.className).toContain("whitespace-nowrap");
    expect(deficitBadge?.className).toContain("shrink-0");

    const subBadge = Array.from(
      host.querySelectorAll<HTMLElement>("[data-slot='badge']"),
    ).find((el) => el.textContent?.includes("مادة بديلة"));
    expect(subBadge).toBeDefined();
    expect(subBadge?.className).toContain("whitespace-nowrap");
    expect(subBadge?.className).toContain("shrink-0");
  });

  it("BundleKitMaterialsStep: جميع رؤوس الأعمدة الثمانية تلتزم بـ whitespace-nowrap select-none", () => {
    act(() => {
      root.render(
        <BundleKitMaterialsStep
          materials={mockMaterials}
          maxBundlesPossible={10}
          limitingFactorName={null}
          limitingFactorType={null}
          requestedBundleQty={10}
          branchId={1}
          materialSubstitutions={[]}
          onApplySubstitution={vi.fn()}
          onRemoveSubstitution={vi.fn()}
        />,
      );
    });

    const headers = host.querySelectorAll("thead th");
    expect(headers.length).toBe(8);
    headers.forEach((th) => {
      expect(th.className).toContain("whitespace-nowrap");
      expect(th.className).toContain("select-none");
    });
  });

  it("BundleKitReviewStep: شارة الكمية المطلوبة تلتزم بـ whitespace-nowrap shrink-0", () => {
    const mockComponents: ComponentRequirementDto[] = [];
    const mockBatches: BundleKitComponentBatch[] = [];

    act(() => {
      root.render(
        <BundleKitReviewStep
          bundleName="طقم مكتبي"
          bundleSku="SET-01"
          requestedBundleQty={15}
          components={mockComponents}
          batches={mockBatches}
          notes=""
          onNotesChange={vi.fn()}
          linkedWorkOrderId={null}
          onLinkedWorkOrderChange={vi.fn()}
          estimatedLaborCost="0"
          estimatedMaterialsCost="0"
          estimatedTotalCost="0"
          isSubmitting={false}
          onSubmit={vi.fn()}
        />,
      );
    });

    const badge = Array.from(
      host.querySelectorAll<HTMLElement>("[data-slot='badge']"),
    ).find((el) => el.textContent?.trim() === "15 طقم");
    expect(badge).toBeDefined();
    expect(badge?.className).toContain("whitespace-nowrap");
    expect(badge?.className).toContain("shrink-0");
  });
});
