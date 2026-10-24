import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import { notify } from "@/lib/notify";
import {
  DEFAULT_FILTERS,
  loadPersistedFilters,
  persistFilters,
  type Health,
  type SortOption,
} from "./discoverySettings";
import type { InstantCampaignScope } from "./instantCampaign";
export function useStudioDiscovery({
  onCreateCampaignFromProducts,
  onCreateCampaignFromCategory,
}: {
  onCreateCampaignFromProducts: (ids: number[]) => void;
  onCreateCampaignFromCategory: (id: number) => void;
}) {
  const studioCan = {
    assignees: useOperationPermission("productStudio.assignees").allowed,
    bulkAssign: useOperationPermission("productStudio.bulkAssign").allowed,
    discoverImageGaps: useOperationPermission("productStudio.discoverImageGaps")
      .allowed,
    imageHealthCounts: useOperationPermission("productStudio.imageHealthCounts")
      .allowed,
    topGapCategories: useOperationPermission("productStudio.topGapCategories")
      .allowed,
  };
  const utils = trpc.useUtils();
  const initialFilters = useMemo(() => loadPersistedFilters(), []);
  const [selectedStates, setSelectedStates] = useState<Health[]>(
    initialFilters.states,
  );
  const [search, setSearch] = useState(initialFilters.search);
  const [bundleOnly, setBundleOnly] = useState(initialFilters.bundleOnly);
  const [sort, setSort] = useState<SortOption>(initialFilters.sort);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const filterRevision = useRef(0);
  const assigning = useRef(false);
  const resetSelection = () => {
    filterRevision.current++;
    setSelectedIds(new Set());
    setPage(1);
  };
  const [expandedHint, setExpandedHint] = useState<Health | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState<boolean>(false);
  const [bulkAssigneeId, setBulkAssigneeId] = useState<string>("");

  // Pagination state
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // Instant Campaign Launcher Modal state
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherScope, setLauncherScope] =
    useState<InstantCampaignScope>("HIGH_VALUE");

  useEffect(() => {
    persistFilters({ states: selectedStates, search, bundleOnly, sort });
  }, [selectedStates, search, bundleOnly, sort]);

  // Reset page when filters change
  const handleStateChange = (newStates: Health[]) => {
    setSelectedStates(newStates);
    resetSelection();
  };

  const handleSearchChange = (newSearch: string) => {
    setSearch(newSearch);
    resetSelection();
  };

  const handleBundleToggle = () => {
    setBundleOnly((prev) => !prev);
    resetSelection();
  };

  const handleSortChange = (newSort: SortOption) => {
    setSort(newSort);
    resetSelection();
  };

  const countsQuery = trpc.productStudio.imageHealthCounts.useQuery(undefined, {
    enabled: studioCan.imageHealthCounts,
    staleTime: 60_000,
  });
  const counts = {
    ...countsQuery,
    data: studioCan.imageHealthCounts ? countsQuery.data : undefined,
  };
  const topCategoriesQuery = trpc.productStudio.topGapCategories.useQuery(
    { limit: 8 },
    { enabled: studioCan.topGapCategories, staleTime: 120_000 },
  );
  const topCategories = {
    ...topCategoriesQuery,
    data: studioCan.topGapCategories ? topCategoriesQuery.data : undefined,
  };
  const assigneesQuery = trpc.productStudio.assignees.useQuery(undefined, {
    enabled: studioCan.assignees,
    staleTime: 120_000,
  });
  const assignees = {
    ...assigneesQuery,
    data: studioCan.assignees ? assigneesQuery.data : undefined,
  };

  const bulkAssignMutation = trpc.productStudio.bulkAssign.useMutation();

  const handleCardClick = (state: Health) => {
    if (multiSelectMode) {
      handleStateChange(
        selectedStates.includes(state)
          ? selectedStates.filter((s) => s !== state)
          : [...selectedStates, state],
      );
    } else {
      if (selectedStates.length === 1 && selectedStates[0] === state) {
        handleStateChange(DEFAULT_FILTERS.states);
      } else {
        handleStateChange([state]);
      }
    }
  };

  const gaps = trpc.productStudio.discoverImageGaps.useQuery(
    {
      states: selectedStates.length > 0 ? selectedStates : undefined,
      isBundle: bundleOnly || undefined,
      search: search.trim() || undefined,
      limit: pageSize,
      cursor: (page - 1) * pageSize,
      sort,
    },
    { enabled: studioCan.discoverImageGaps, staleTime: 30_000 },
  );

  const items =
    studioCan.discoverImageGaps && !gaps.isError
      ? (gaps.data?.items ?? [])
      : [];
  const allShownSelected =
    items.length > 0 && items.every((i) => selectedIds.has(i.productId));

  const handleBulkAssign = async () => {
    if (
      assigning.current ||
      gaps.isFetching ||
      !studioCan.discoverImageGaps ||
      !studioCan.bulkAssign ||
      !studioCan.assignees ||
      !bulkAssigneeId ||
      selectedIds.size === 0 ||
      selectedIds.size > 100
    )
      return;
    assigning.current = true;
    const revision = filterRevision.current;
    const productIds = Array.from(selectedIds);
    try {
      const res = await bulkAssignMutation.mutateAsync({
        productIds,
        assigneeId: Number(bulkAssigneeId),
      });
      notify.ok(`تم إسناد ${res.createdCount} منتج بنجاح`);
      if (revision === filterRevision.current) {
        setSelectedIds(
          (current) =>
            new Set(
              Array.from(current).filter((id) => !productIds.includes(id)),
            ),
        );
      }
      await Promise.all([
        utils.productStudio.imageHealthCounts.invalidate(),
        utils.productStudio.discoverImageGaps.invalidate(),
        utils.productStudio.tasks.invalidate(),
      ]);
    } catch (error) {
      notify.err(error);
    } finally {
      assigning.current = false;
    }
  };
  return {
    studioCan,
    selectedStates,
    search,
    bundleOnly,
    sort,
    selectedIds,
    setSelectedIds,
    expandedHint,
    setExpandedHint,
    multiSelectMode,
    setMultiSelectMode,
    bulkAssigneeId,
    setBulkAssigneeId,
    page,
    setPage,
    pageSize,
    launcherOpen,
    setLauncherOpen,
    launcherScope,
    setLauncherScope,
    counts,
    topCategories,
    assignees,
    bulkAssignMutation,
    handleBulkAssign,
    handleStateChange,
    handleSearchChange,
    handleBundleToggle,
    handleSortChange,
    handleCardClick,
    gaps,
    items,
    allShownSelected,
    onCreateCampaignFromProducts,
    onCreateCampaignFromCategory,
  };
}
export type DiscoveryModel = ReturnType<typeof useStudioDiscovery>;
