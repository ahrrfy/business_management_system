import type { WorkflowStation } from "@shared/deliveryWorkflow";
import {
  termCompact,
  termProse,
  termTooltip,
} from "@shared/deliveryTerminology";

export type WorkflowMode = "assignment" | "money" | "returns";

export interface WorkflowOperationDefinition {
  section: WorkflowStation;
  label: string;
  tooltip: string;
}

export interface WorkflowModeDefinition {
  key: WorkflowMode;
  label: string;
  prose: string;
  tooltip: string;
  defaultSection: WorkflowStation;
  operations: readonly WorkflowOperationDefinition[];
}

export const WORKFLOW_MODE_STORAGE_KEY = "delivery.workflow.mode.v1";

export const WORKFLOW_MODES: readonly WorkflowModeDefinition[] = [
  {
    key: "assignment",
    label: termCompact("assignmentMode"),
    prose: termProse("assignmentMode"),
    tooltip: termTooltip("assignmentMode"),
    defaultSection: "dispatch",
    operations: [
      {
        section: "dispatch",
        label: termCompact("assignShipment"),
        tooltip: termTooltip("assignShipment"),
      },
      {
        section: "cancelAssignment",
        label: termCompact("cancelAssignment"),
        tooltip: termTooltip("cancelAssignment"),
      },
      {
        section: "edit",
        label: termCompact("correctInvoice"),
        tooltip: termTooltip("correctInvoice"),
      },
    ],
  },
  {
    key: "money",
    label: termCompact("collectionAndRemittanceMode"),
    prose: termProse("collectionAndRemittanceMode"),
    tooltip: termTooltip("collectionAndRemittanceMode"),
    defaultSection: "collect",
    operations: [
      {
        section: "collect",
        label: termProse("collectionAndRemittanceMode"),
        tooltip: termTooltip("collectionAndRemittanceMode"),
      },
    ],
  },
  {
    key: "returns",
    label: termCompact("returnsAndAftercareMode"),
    prose: termProse("returnsAndAftercareMode"),
    tooltip: termTooltip("returnsAndAftercareMode"),
    defaultSection: "return",
    operations: [
      {
        section: "return",
        label: termCompact("receivePhysicalReturn"),
        tooltip: termTooltip("receivePhysicalReturn"),
      },
      {
        section: "aftercare",
        label: termCompact("aftercare"),
        tooltip: termTooltip("aftercare"),
      },
    ],
  },
] as const;

const WORKFLOW_MODE_BY_SECTION: Record<WorkflowStation, WorkflowMode> = {
  dispatch: "assignment",
  cancelAssignment: "assignment",
  edit: "assignment",
  collect: "money",
  return: "returns",
  aftercare: "returns",
};

export interface WorkflowModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function browserWorkflowModeStorage(): WorkflowModeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function workflowModeForSection(section: WorkflowStation): WorkflowMode {
  return WORKFLOW_MODE_BY_SECTION[section];
}

export function workflowModeDefinition(
  mode: WorkflowMode,
): WorkflowModeDefinition {
  return WORKFLOW_MODES.find((item) => item.key === mode) ?? WORKFLOW_MODES[0];
}

export function workflowDefaultSection(mode: WorkflowMode): WorkflowStation {
  return workflowModeDefinition(mode).defaultSection;
}

export function parseWorkflowMode(
  value: string | null | undefined,
): WorkflowMode | null {
  return value === "assignment" || value === "money" || value === "returns"
    ? value
    : null;
}

export function readStoredWorkflowMode(
  storage?: WorkflowModeStorage | null,
): WorkflowMode | null {
  if (!storage) return null;
  try {
    return parseWorkflowMode(storage.getItem(WORKFLOW_MODE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function persistWorkflowMode(
  storage: WorkflowModeStorage | null | undefined,
  mode: WorkflowMode,
): void {
  if (!storage) return;
  try {
    storage.setItem(WORKFLOW_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage may be unavailable in private/restricted browser contexts.
  }
}
