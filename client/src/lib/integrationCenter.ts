import { normalizeSearchText } from "@shared/searchNormalize";

export type IntegrationConnectionStatus = "PENDING" | "ACTIVE" | "FAILED" | "DISABLED";
export type IntegrationConnectionChannel = "WHATSAPP" | "INSTAGRAM" | "STORE";

export type IntegrationStatusFilter = "ALL" | "ACTIVE" | "ATTENTION" | "DISABLED";
export type IntegrationChannelFilter = "ALL" | IntegrationConnectionChannel;

export interface IntegrationCenterItem {
  branchId: number;
  branchName: string | null;
  channel: IntegrationConnectionChannel;
  displayName: string | null;
  status: IntegrationConnectionStatus;
}

export interface IntegrationCenterFilters {
  query: string;
  status: IntegrationStatusFilter;
  channel: IntegrationChannelFilter;
  branchId: number | null;
}

export interface IntegrationCenterSummary {
  total: number;
  active: number;
  attention: number;
  disabled: number;
}

const ATTENTION_STATUSES: ReadonlySet<IntegrationConnectionStatus> = new Set<IntegrationConnectionStatus>(["PENDING", "FAILED"]);
const CHANNEL_SEARCH_ALIASES: Record<IntegrationConnectionChannel, string> = {
  WHATSAPP: "واتساب واتس اب",
  INSTAGRAM: "انستغرام انستجرام",
  STORE: "متجر webhook",
};

export function isAttentionStatus(status: IntegrationConnectionStatus): boolean {
  return ATTENTION_STATUSES.has(status);
}

function normalizedText(value: string | null | undefined): string {
  return normalizeSearchText(value ?? "");
}

export function summarizeIntegrations(items: readonly IntegrationCenterItem[]): IntegrationCenterSummary {
  return items.reduce<IntegrationCenterSummary>(
    (summary, item) => {
      summary.total += 1;
      if (item.status === "ACTIVE") summary.active += 1;
      else if (item.status === "DISABLED") summary.disabled += 1;
      else if (isAttentionStatus(item.status)) summary.attention += 1;
      return summary;
    },
    { total: 0, active: 0, attention: 0, disabled: 0 },
  );
}

export function filterIntegrations<T extends IntegrationCenterItem>(
  items: readonly T[],
  filters: IntegrationCenterFilters,
): T[] {
  const query = normalizedText(filters.query);

  return items.filter((item) => {
    if (filters.branchId != null && item.branchId !== filters.branchId) return false;
    if (filters.channel !== "ALL" && item.channel !== filters.channel) return false;
    if (filters.status === "ACTIVE" && item.status !== "ACTIVE") return false;
    if (filters.status === "DISABLED" && item.status !== "DISABLED") return false;
    if (filters.status === "ATTENTION" && !isAttentionStatus(item.status)) return false;

    if (!query) return true;
    return [item.displayName, item.branchName, item.channel, CHANNEL_SEARCH_ALIASES[item.channel], String(item.branchId)]
      .some((value) => normalizedText(value).includes(query));
  });
}
