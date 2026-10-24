import type { RouterInputs, RouterOutputs } from "@/lib/trpc";
import type { StudioImageHealth, StudioDiscoverySort } from "@shared/terms";

export type InstantCampaignScope =
  | "HIGH_VALUE"
  | "NO_IMAGES"
  | "CURRENT_FILTER"
  | "SELECTED_ROWS";
export interface InstantCampaignProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultScope?: InstantCampaignScope;
  selectedRowIds?: number[];
  activeFilterStates: StudioImageHealth[];
  activeSearch?: string;
  bundleOnly?: boolean;
  activeSort?: StudioDiscoverySort;
  counts?: Record<StudioImageHealth, number>;
  onSuccess?: (campaignId: number) => void;
}

export function instantCampaignFilter(
  scope: InstantCampaignScope,
  props: InstantCampaignProps,
): RouterInputs["productStudio"]["gapProductIds"] {
  if (scope === "HIGH_VALUE")
    return { states: ["HIGH_VALUE_NO_IMAGE"], maxLimit: 5001 };
  if (scope === "NO_IMAGES") return { states: ["NO_IMAGES"], maxLimit: 5001 };
  return {
    states: props.activeFilterStates.length
      ? props.activeFilterStates
      : undefined,
    search: props.activeSearch?.trim() || undefined,
    isBundle: props.bundleOnly || undefined,
    sort: props.activeSort,
    // Detect the campaign limit without silently truncating the selected scope.
    maxLimit: 5001,
  };
}

export type CampaignDraft = RouterInputs["productStudio"]["createCampaign"];
type DrainResult = RouterOutputs["productStudio"]["drainCampaignBacklog"];
type DistributionResult =
  RouterOutputs["productStudio"]["distributeCampaignTasks"];

/** Resume the known campaign after a task-generation or distribution failure. */
export async function prepareInstantCampaign(input: {
  campaignId: number | null;
  draft: CampaignDraft;
  create: (draft: CampaignDraft) => Promise<{ campaignId: number }>;
  drain: (input: {
    campaignId: number;
    autoDistribute: boolean;
  }) => Promise<DrainResult>;
  distribute: (input: { campaignId: number }) => Promise<DistributionResult>;
  onCreated: (id: number) => void;
}) {
  let campaignId = input.campaignId;
  if (campaignId === null) {
    const created = await input.create(input.draft);
    campaignId = Number(created.campaignId);
    input.onCreated(campaignId);
  }
  const generated = await input.drain({ campaignId, autoDistribute: false });
  // autoDistribute suppresses server errors; explicit distribution exposes them for retry.
  const distribution = await input.distribute({ campaignId });
  return {
    campaignId,
    ...generated,
    distributedCount: distribution.distributedCount,
  };
}
