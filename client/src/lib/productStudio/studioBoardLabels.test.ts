// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  backlogButtonSuffix,
  canApproveStudioCandidate,
  getStudioTaskStatusDisplay,
  isQueuedStudioTask,
  studioTaskSelection,
} from "./studioBoardLabels";

describe("studio board labels", () => {
  it("selects independent image tasks sharing the same product", () => {
    const tasks = [
      {
        id: 21,
        productId: 7,
        status: "ASSIGNED" as const,
        assignedTo: 2,
        assigneeName: "مصوّر",
      },
      {
        id: 22,
        productId: 7,
        status: "ASSIGNED" as const,
        assignedTo: null,
        assigneeName: null,
      },
      {
        id: 23,
        productId: 7,
        status: "PENDING_REVIEW" as const,
        assignedTo: 2,
        assigneeName: "مصوّر",
      },
    ];
    expect(studioTaskSelection(tasks, new Set([21]))).toEqual({
      queuedTaskIds: [22],
      allQueuedSelected: false,
      selectedAssignedTaskIds: [21],
      selectedActiveTaskIds: [21],
    });
    expect(studioTaskSelection(tasks, new Set([22]))).toEqual({
      queuedTaskIds: [22],
      allQueuedSelected: true,
      selectedAssignedTaskIds: [],
      selectedActiveTaskIds: [22],
    });
  });
  it("يميّز مهمة الطابور عن المهمة المسنَدة رغم تطابق الحالة", () => {
    // هذه هي حالة الإنتاج: ٤٢٨٥ مهمة ASSIGNED بلا منفّذ عُرضت «مسندة/قيد العمل».
    expect(isQueuedStudioTask({ status: "ASSIGNED", assigneeName: null })).toBe(
      true,
    );
    expect(
      isQueuedStudioTask({ status: "ASSIGNED", assigneeName: "علي" }),
    ).toBe(false);
    expect(
      isQueuedStudioTask({ status: "IN_PROGRESS", assigneeName: null }),
    ).toBe(false);
    expect(
      isQueuedStudioTask({ status: "PENDING_REVIEW", assigneeName: null }),
    ).toBe(false);
  });

  it("يعرض وسوم الحالة بوضوح وتمييز دقيق للمستخدم", () => {
    expect(
      getStudioTaskStatusDisplay({ status: "ASSIGNED", assigneeName: null }),
    ).toEqual({
      label: "في الطابور",
      variant: "warning",
    });
    expect(
      getStudioTaskStatusDisplay({ status: "ASSIGNED", assigneeName: "مصوّر" }),
    ).toEqual({
      label: "بانتظار التصوير",
      variant: "info",
    });
    expect(
      getStudioTaskStatusDisplay({
        status: "PENDING_REVIEW",
        assigneeName: "مصوّر",
      }),
    ).toEqual({
      label: "بانتظار الاعتماد",
      variant: "warning",
    });
    expect(
      getStudioTaskStatusDisplay({ status: "APPROVED", assigneeName: "مصوّر" }),
    ).toEqual({
      label: "مكتملة ومعتمدة",
      variant: "success",
    });
  });

  it("لا يطبع صفراً إلا حين تكون المعاينة قد نجحت فعلاً", () => {
    expect(
      backlogButtonSuffix({
        campaignSelected: false,
        isError: false,
        isPending: false,
      }),
    ).toBe("(اختر حملة)");
    expect(
      backlogButtonSuffix({
        campaignSelected: true,
        isError: true,
        isPending: false,
      }),
    ).toBe("(تعذّرت المعاينة)");
    expect(
      backlogButtonSuffix({
        campaignSelected: true,
        isError: false,
        isPending: true,
      }),
    ).toBe("(…)");
    expect(
      backlogButtonSuffix({
        campaignSelected: true,
        isError: false,
        isPending: false,
        count: 0,
      }),
    ).toBe("(0)");
  });

  it("يُعلن حجم الدفعة حين يتجاوز الناقصُ سقفَ التوليد الواحد", () => {
    expect(
      backlogButtonSuffix({
        campaignSelected: true,
        isError: false,
        isPending: false,
        count: 4285,
        batchLimit: 500,
      }),
    ).toBe("(4285 — دفعة 500)");
    expect(
      backlogButtonSuffix({
        campaignSelected: true,
        isError: false,
        isPending: false,
        count: 120,
        batchLimit: 500,
      }),
    ).toBe("(120)");
  });

  it("يمنع الاعتماد ما لم تظهر المعاينة", () => {
    const ready = {
      offline: false,
      storageDisabled: false,
      busy: false,
      reviewable: true,
      previewLoaded: true,
    };
    expect(canApproveStudioCandidate(ready)).toBe(true);
    // جوهر الثغرة: كل الشروط القديمة متحقّقة والمراجع لا يرى شيئاً.
    expect(canApproveStudioCandidate({ ...ready, previewLoaded: false })).toBe(
      false,
    );
    expect(canApproveStudioCandidate({ ...ready, offline: true })).toBe(false);
    expect(canApproveStudioCandidate({ ...ready, reviewable: false })).toBe(
      false,
    );
    expect(canApproveStudioCandidate({ ...ready, storageDisabled: true })).toBe(
      false,
    );
    expect(canApproveStudioCandidate({ ...ready, busy: true })).toBe(false);
  });
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import {
  instantCampaignFilter,
  prepareInstantCampaign,
  type InstantCampaignProps,
} from "@/components/product-studio/discovery/instantCampaign";
import { useInstantCampaign } from "@/components/product-studio/discovery/useInstantCampaign";
import { useStudioDiscovery } from "@/components/product-studio/discovery/useStudioDiscovery";
import { loadPersistedFilters } from "@/components/product-studio/discovery/discoverySettings";
import {
  STUDIO_IMAGE_HEALTH_LABELS,
  STUDIO_DISCOVERY_SORT_LABELS,
} from "@shared/terms";
const studio = vi.hoisted(() => ({
  create: vi.fn(),
  drain: vi.fn(),
  distribute: vi.fn(),
  bulk: vi.fn(),
  invalidate: vi.fn(),
  gapIds: [1, 2],
  fetching: false,
  error: false,
  allowed: true,
  assignees: [{ id: 9, name: "مصور", canStudio: true }],
}));
vi.mock("@/hooks/useOperationPermission", () => ({
  useOperationPermission: () => ({ allowed: studio.allowed }),
}));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      productStudio: new Proxy(
        {},
        { get: () => ({ invalidate: studio.invalidate }) },
      ),
    }),
    productStudio: {
      assignees: {
        useQuery: () => ({ data: studio.assignees, isError: false }),
      },
      gapProductIds: {
        useQuery: () => ({
          data: studio.gapIds,
          isFetching: studio.fetching,
          isError: studio.error,
        }),
      },
      createCampaign: { useMutation: () => ({ mutateAsync: studio.create }) },
      drainCampaignBacklog: {
        useMutation: () => ({ mutateAsync: studio.drain }),
      },
      distributeCampaignTasks: {
        useMutation: () => ({ mutateAsync: studio.distribute }),
      },
      bulkAssign: { useMutation: () => ({ mutateAsync: studio.bulk }) },
      imageHealthCounts: { useQuery: () => ({ data: undefined }) },
      topGapCategories: { useQuery: () => ({ data: [] }) },
      discoverImageGaps: {
        useQuery: () => ({
          data: { items: [{ productId: 1 }] },
          isFetching: studio.fetching,
        }),
      },
    },
  },
}));
let root: Root | undefined;
let container: HTMLDivElement;
function mountHook<T, P>(hook: (props: P) => T, initial: P) {
  let latest: T;
  function Harness({ value }: { value: P }) {
    latest = hook(value);
    return null;
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (value: P) =>
    act(() => root!.render(React.createElement(Harness, { value })));
  render(initial);
  return {
    get value() {
      return latest!;
    },
    render,
  };
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.clearAllMocks();
  studio.gapIds = [1, 2];
  studio.fetching = false;
  studio.error = false;
  studio.allowed = true;
  studio.create.mockResolvedValue({ campaignId: 71 });
  studio.drain.mockResolvedValue({
    totalCreated: 2,
    remaining: 0,
    iterations: 1,
  });
  studio.distribute.mockResolvedValue({
    distributedCount: 2,
    assigneesCount: 1,
  });
  studio.invalidate.mockResolvedValue(undefined);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container?.remove();
});
const props: InstantCampaignProps = {
  open: true,
  onOpenChange: vi.fn(),
  activeFilterStates: ["NO_IMAGES"],
  defaultScope: "CURRENT_FILTER",
  activeSearch: " قلم ",
  bundleOnly: true,
  activeSort: "NAME_ASC",
};

describe("discovery campaign scope and recovery", () => {
  it("uses the same states, search, bundle and ordering, with an explicit size guard", () => {
    expect(instantCampaignFilter("CURRENT_FILTER", props)).toEqual({
      states: ["NO_IMAGES"],
      search: "قلم",
      isBundle: true,
      sort: "NAME_ASC",
      maxLimit: 5001,
    });
    expect(instantCampaignFilter("NO_IMAGES", props)).toEqual({
      states: ["NO_IMAGES"],
      maxLimit: 5001,
    });
    expect(Object.keys(STUDIO_IMAGE_HEALTH_LABELS)).toHaveLength(11);
    expect(Object.keys(STUDIO_DISCOVERY_SORT_LABELS)).toHaveLength(4);
  });
  it("rejects inherited keys in persisted labels", () => {
    localStorage.setItem(
      "studio.discovery.filters.v1",
      JSON.stringify({
        states: ["NO_IMAGES", "toString"],
        sort: "constructor",
      }),
    );
    expect(loadPersistedFilters()).toMatchObject({
      states: ["NO_IMAGES"],
      sort: "MISSING_MOST",
    });
  });
  it("honours the initiating scope on each reopen and lets the user deselect every photographer", () => {
    const h = mountHook(useInstantCampaign, { ...props, open: false });
    h.render({ ...props, defaultScope: "SELECTED_ROWS", selectedRowIds: [6] });
    expect(h.value.scope).toBe("SELECTED_ROWS");
    act(() => h.value.setAssigneeIds([]));
    expect(h.value.assigneeIds).toEqual([]);
    h.render({ ...props, open: false });
    h.render(props);
    expect(h.value.scope).toBe("CURRENT_FILTER");
  });
  it("blocks unknown, oversized, unauthorized or loading previews", () => {
    const h = mountHook(useInstantCampaign, props);
    expect(h.value.canLaunch).toBe(true);
    studio.fetching = true;
    h.render(props);
    expect(h.value.canLaunch).toBe(false);
    studio.fetching = false;
    studio.gapIds = Array.from({ length: 5001 }, (_, n) => n + 1);
    h.render(props);
    expect(h.value.canLaunch).toBe(false);
    studio.gapIds = [1];
    studio.allowed = false;
    h.render(props);
    expect(h.value.canLaunch).toBe(false);
  });
  it("locks before the first await and resumes a known campaign after failure, even after reopening", async () => {
    let resolve!: (value: { campaignId: number }) => void;
    studio.create.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    studio.drain.mockRejectedValueOnce(new Error("تعذر الاتصال"));
    const h = mountHook(useInstantCampaign, props);
    let first!: Promise<void>;
    act(() => {
      first = h.value.launch();
      void h.value.launch();
    });
    expect(studio.create).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ campaignId: 71 });
      await first;
    });
    expect(h.value.campaignId).toBe(71);
    expect(h.value.complete).toBe(false);
    h.render({ ...props, open: false });
    h.render({ ...props, defaultScope: "HIGH_VALUE" });
    expect(h.value.campaignId).toBe(71);
    await act(() => h.value.launch());
    expect(studio.create).toHaveBeenCalledTimes(1);
    expect(studio.drain).toHaveBeenLastCalledWith({
      campaignId: 71,
      autoDistribute: false,
    });
    expect(h.value.complete).toBe(true);
  });
  it("reports remaining tasks and retries a distribution failure against the same campaign", async () => {
    studio.drain.mockResolvedValueOnce({
      totalCreated: 1,
      remaining: 1,
      iterations: 50,
    });
    const h = mountHook(useInstantCampaign, props);
    await act(() => h.value.launch());
    expect(h.value.complete).toBe(false);
    expect(h.value.message).toContain("1");
    studio.distribute.mockRejectedValueOnce(new Error("إسناد متعذر"));
    await act(() => h.value.launch());
    expect(h.value.error).toContain("إسناد متعذر");
    await act(() => h.value.launch());
    expect(h.value.complete).toBe(true);
    expect(studio.create).toHaveBeenCalledTimes(1);
  });
  it("propagates distribution errors instead of claiming success", async () => {
    await expect(
      prepareInstantCampaign({
        campaignId: 71,
        draft: { name: "اختبار", status: "ACTIVE" },
        create: studio.create,
        drain: studio.drain,
        distribute: async () => {
          throw new Error("failed");
        },
        onCreated: vi.fn(),
      }),
    ).rejects.toThrow("failed");
    expect(studio.create).not.toHaveBeenCalled();
  });
  it("clears hidden selection on filter changes and preserves selection in a newer filter after an old assignment succeeds", async () => {
    let resolve!: (value: { createdCount: number }) => void;
    studio.bulk.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const p = {
      onCreateCampaignFromProducts: vi.fn(),
      onCreateCampaignFromCategory: vi.fn(),
    };
    const h = mountHook(useStudioDiscovery, p);
    act(() => {
      h.value.setSelectedIds(new Set([1]));
      h.value.setBulkAssigneeId("9");
    });
    let pending!: Promise<void>;
    act(() => {
      pending = h.value.handleBulkAssign();
    });
    act(() => h.value.handleSearchChange("منتج جديد"));
    expect(h.value.selectedIds.size).toBe(0);
    act(() => h.value.setSelectedIds(new Set([1, 5])));
    await act(async () => {
      resolve({ createdCount: 1 });
      await pending;
    });
    expect([...h.value.selectedIds]).toEqual([1, 5]);
    studio.allowed = false;
    h.render(p);
    expect(h.value.items).toEqual([]);
  });
});
