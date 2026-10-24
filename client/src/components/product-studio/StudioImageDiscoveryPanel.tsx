import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles } from "lucide-react";
import { StudioInstantCampaignLauncher } from "./StudioInstantCampaignLauncher";
import { useStudioDiscovery } from "./discovery/useStudioDiscovery";
import { DiscoverySummary } from "./discovery/DiscoverySummary";
import { DiscoveryFilters } from "./discovery/DiscoveryFilters";
import { DiscoveryResults } from "./discovery/DiscoveryResults";
export function StudioImageDiscoveryPanel(
  props: Parameters<typeof useStudioDiscovery>[0],
) {
  const model = useStudioDiscovery(props);
  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
            <Sparkles aria-hidden className="size-4" /> كشف فجوات الصور
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <DiscoverySummary model={model} />
          <DiscoveryFilters model={model} />
          {model.studioCan.discoverImageGaps ? (
            <DiscoveryResults model={model} />
          ) : (
            <p role="alert">لا تملك صلاحية عرض نتائج فجوات الصور.</p>
          )}
        </CardContent>
      </Card>
      <StudioInstantCampaignLauncher
        open={model.launcherOpen}
        onOpenChange={model.setLauncherOpen}
        defaultScope={model.launcherScope}
        selectedRowIds={Array.from(model.selectedIds)}
        activeFilterStates={model.selectedStates}
        activeSearch={model.search}
        bundleOnly={model.bundleOnly}
        activeSort={model.sort}
        counts={model.counts.data?.counts}
        onSuccess={() => model.setSelectedIds(new Set())}
      />
    </>
  );
}
