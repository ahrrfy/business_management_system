export type DecisionSeverity = "critical" | "warning" | "info";

export type ExecutiveDecision = {
  id: string;
  severity: DecisionSeverity;
  title: string;
  context: string;
  actionLabel: string;
};

export type OwnerDecisionCenter = {
  asOf: string;
  scopeLabel: string;
  health: "healthy" | "degraded";
  decisions: ExecutiveDecision[];
  metrics: {
    label: string;
    value: string;
    detail: string;
    available: boolean;
  }[];
};

export function visibleDecisions(decisions: ExecutiveDecision[], expanded: boolean): ExecutiveDecision[] {
  return expanded ? decisions : decisions.slice(0, 3);
}
