import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DiscoveryModel } from "./useStudioDiscovery";
import {
  STUDIO_IMAGE_HEALTH_LABELS as STATE_LABEL,
  STUDIO_DISCOVERY_SORT_LABELS as SORT_LABEL,
} from "@shared/terms";
import {
  DEFAULT_FILTERS,
  STATE_VARIANT,
  STATE_TOOLTIP,
  type Health,
  type SortOption,
} from "./discoverySettings";
import { AppSelect } from "@/components/ui/AppSelect";
import { Label } from "@/components/ui/label";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { ArrowUpDown, Package, Sparkles, UserCheck, Zap } from "lucide-react";
export function DiscoveryFilters({ model }: { model: DiscoveryModel }) {
  const {
    search,
    handleSearchChange,
    bundleOnly,
    handleBundleToggle,
    sort,
    handleSortChange,
    selectedIds,
    setSelectedIds,
    bulkAssigneeId,
    setBulkAssigneeId,
    bulkAssignMutation,
    handleBulkAssign,
    studioCan,
    gaps,
    assignees,
    setLauncherScope,
    setLauncherOpen,
    onCreateCampaignFromProducts,
  } = model;
  return (
    <>
      {/* فلاترُ البحث والفرز */}
      <div className="grid gap-3 md:grid-cols-4">
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="discovery-search">بحث باسم المنتج</Label>
          <UnifiedSearchInput
            id="discovery-search"
            value={search}
            onChange={handleSearchChange}
            placeholder="اكتب جزءاً من الاسم أو SKU أو امسح الباركود… (F2)"
            debounceMs={250}
            maxLength={80}
            barcode={true}
            size="default"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="discovery-bundle">تصفية</Label>
          <Button
            id="discovery-bundle"
            type="button"
            variant={bundleOnly ? "default" : "outline"}
            className="min-h-11 w-full"
            onClick={handleBundleToggle}
          >
            <Package aria-hidden className="size-4" /> البكج فقط
            {bundleOnly ? " (مفعَّل)" : ""}
          </Button>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="discovery-sort" className="flex items-center gap-1">
            <ArrowUpDown aria-hidden className="size-3" /> فرز
          </Label>
          <AppSelect
            id="discovery-sort"
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={sort}
            onValueChange={(v) => handleSortChange(v as SortOption)}
          >
            {(Object.keys(SORT_LABEL) as SortOption[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </AppSelect>
        </div>
      </div>

      {/* شريط الإجراءات — يظهر عند التحديد */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-primary/5 p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              <strong>{selectedIds.size}</strong> منتج مُحدَّد
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => setSelectedIds(new Set())}
            >
              إلغاء التحديد
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* إسنادٌ مباشر لمصوّر */}
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <div className="min-w-0 w-full sm:w-44">
                <AppSelect
                  id="discovery-bulk-assignee"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                  value={bulkAssigneeId}
                  onValueChange={setBulkAssigneeId}
                  disabled={bulkAssignMutation.isPending}
                >
                  <option value="">اختر موظفاً للإسناد المباشر…</option>
                  {(assignees.data ?? []).map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.name}
                    </option>
                  ))}
                </AppSelect>
              </div>
              <Button
                type="button"
                size="sm"
                className="min-h-9"
                disabled={
                  !studioCan.discoverImageGaps ||
                  !studioCan.bulkAssign ||
                  !studioCan.assignees ||
                  gaps.isFetching ||
                  selectedIds.size > 100 ||
                  !bulkAssigneeId ||
                  bulkAssignMutation.isPending
                }
                onClick={handleBulkAssign}
              >
                <UserCheck aria-hidden className="size-3.5" />
                {bulkAssignMutation.isPending
                  ? "جارٍ الإسناد…"
                  : "إسناد مباشر (حتى 100)"}
              </Button>
            </div>

            <div className="h-6 w-px bg-border" />

            <Button
              type="button"
              variant="default"
              size="sm"
              className="min-h-9 gap-1"
              onClick={() => {
                setLauncherScope("SELECTED_ROWS");
                setLauncherOpen(true);
              }}
            >
              <Zap aria-hidden className="size-3.5" /> إطلاق حملة وتوزيع
              المحدَّد
            </Button>

            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="min-h-9"
              onClick={() => {
                const ids = Array.from(selectedIds);
                onCreateCampaignFromProducts(ids);
              }}
            >
              <Sparkles aria-hidden className="size-3.5" /> فتح في منشئ الحملة
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
