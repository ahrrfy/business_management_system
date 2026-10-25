import React from "react";
import type { WorkflowStation } from "@shared/deliveryWorkflow";
import {
  Ban,
  FilePenLine,
  HandCoins,
  PackageCheck,
  RefreshCcw,
  ScanBarcode,
  Truck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  WORKFLOW_MODES,
  workflowModeDefinition,
  workflowModeForSection,
  type WorkflowMode,
} from "./workflowModes";

export interface WorkflowModeNavigationProps {
  activeSection: WorkflowStation;
  disabled?: boolean;
  disabledReason?: string;
  nextStep?: string;
  onModeChange(mode: WorkflowMode): void;
  onSectionChange(section: WorkflowStation): void;
}

const MODE_ICONS = {
  assignment: Truck,
  money: HandCoins,
  returns: PackageCheck,
} as const;

const OPERATION_ICONS = {
  dispatch: ScanBarcode,
  cancelAssignment: Ban,
  edit: FilePenLine,
  collect: HandCoins,
  return: RefreshCcw,
  aftercare: PackageCheck,
} as const;

export function WorkflowModeNavigation({
  activeSection,
  disabled = false,
  disabledReason = "انتظر اكتمال العملية الجارية قبل تغيير المحطة.",
  nextStep = "أكمل العملية الحالية ثم اختر الإجراء التالي.",
  onModeChange,
  onSectionChange,
}: WorkflowModeNavigationProps) {
  const activeMode = workflowModeForSection(activeSection);
  const currentMode = workflowModeDefinition(activeMode);

  return (
    <div
      className="shrink-0 border-b bg-card"
      aria-label="أوضاع سير عمل التوصيل"
    >
      <div
        className="grid grid-cols-3 border-b"
        role="tablist"
        aria-label="المحطات الرئيسية"
      >
        {WORKFLOW_MODES.map((mode) => {
          const Icon = MODE_ICONS[mode.key];
          const selected = activeMode === mode.key;
          return (
            <button
              key={mode.key}
              id={`workflow-mode-${mode.key}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="workflow-active-panel"
              disabled={disabled}
              title={disabled ? `${disabledReason} ${nextStep}` : mode.tooltip}
              onClick={() => {
                if (!selected) onModeChange(mode.key);
              }}
              className={cn(
                "flex min-h-12 items-center justify-center gap-2 border-s-2 border-transparent px-3 py-2 text-sm font-extrabold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-55 sm:border-s-0 sm:border-b-2",
                selected
                  ? "border-primary bg-primary/5 text-primary"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <Icon aria-hidden className="size-4" />
              <span>{mode.label}</span>
            </button>
          );
        })}
      </div>

      <div
        className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-2"
        role="tablist"
        aria-label="إجراءات المحطة المختارة"
      >
        <span className="text-xs font-bold text-muted-foreground">
          الإجراء:
        </span>
        {currentMode.operations.map((operation) => {
          const Icon = OPERATION_ICONS[operation.section];
          const selected = activeSection === operation.section;
          return (
            <button
              key={operation.section}
              id={`workflow-tab-${operation.section}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="workflow-active-panel"
              disabled={disabled}
              title={
                disabled ? `${disabledReason} ${nextStep}` : operation.tooltip
              }
              onClick={() => onSectionChange(operation.section)}
              className={cn(
                "inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-foreground hover:bg-muted",
              )}
            >
              <Icon aria-hidden className="size-3.5" />
              {operation.label}
            </button>
          );
        })}
        {disabled && (
          <p className="basis-full text-xs text-destructive" role="status">
            {disabledReason} <span className="font-bold">الخطوة التالية:</span>{" "}
            {nextStep}
          </p>
        )}
      </div>
    </div>
  );
}
