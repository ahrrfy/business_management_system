import {
  CalendarClock,
  ChevronLeft,
  CircleDollarSign,
  History,
  Pencil,
  Phone,
  UserRound,
} from "lucide-react";
import {
  LEAD_ALLOWED_TRANSITIONS,
  OPPORTUNITY_ALLOWED_TRANSITIONS,
  SALES_LEAD_STATUS_LABELS,
  SALES_LEAD_STATUSES,
  SALES_LEAD_SOURCE_LABELS,
  SALES_OPPORTUNITY_STAGE_LABELS,
  SALES_OPPORTUNITY_STAGES,
  type SalesLeadStatus,
  type SalesOpportunityStage,
} from "@shared/salesPipeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/PageState";
import { formatIqd } from "@/lib/money";
import { isLeadOverdue, isOpportunityOverdue, pipelineDate } from "./policy";
import type { LeadRow, OpportunityRow } from "./types";

type LeadActions = {
  onEdit: (lead: LeadRow) => void;
  onTransition: (lead: LeadRow, toStatus: SalesLeadStatus) => void;
  onConvert: (lead: LeadRow) => void;
  onHistory: (lead: LeadRow) => void;
};

type OpportunityActions = {
  onEdit: (opportunity: OpportunityRow) => void;
  onTransition: (
    opportunity: OpportunityRow,
    toStage: SalesOpportunityStage,
  ) => void;
  onHistory: (opportunity: OpportunityRow) => void;
};

function statusVariant(status: SalesLeadStatus) {
  if (status === "DISQUALIFIED") return "destructive" as const;
  if (status === "CONVERTED" || status === "QUALIFIED")
    return "default" as const;
  return "secondary" as const;
}

function stageVariant(stage: SalesOpportunityStage) {
  if (stage === "LOST") return "destructive" as const;
  if (stage === "WON") return "default" as const;
  return "secondary" as const;
}

function LeadCard({
  lead,
  canWrite,
  actions,
}: {
  lead: LeadRow;
  canWrite: boolean;
  actions: LeadActions;
}) {
  const overdue = isLeadOverdue(lead.status, lead.nextFollowUpAt);
  return (
    <Card className="rounded-md shadow-none">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold">{lead.contactName}</p>
            <p className="mt-0.5 text-2xs text-muted-foreground" dir="ltr">
              {lead.leadNumber}
            </p>
          </div>
          <Badge variant={statusVariant(lead.status)}>
            {SALES_LEAD_STATUS_LABELS[lead.status]}
          </Badge>
        </div>
        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p>
            {SALES_LEAD_SOURCE_LABELS[lead.source]}
            {lead.companyName ? ` · ${lead.companyName}` : ""}
          </p>
          <p className="flex items-center gap-1.5">
            <UserRound aria-hidden className="size-3.5" />
            {lead.ownerName || "غير مسمّى"}
          </p>
          {lead.phone && (
            <p className="flex items-center gap-1.5" dir="ltr">
              <Phone aria-hidden className="size-3.5" />
              {lead.phone}
            </p>
          )}
          <p
            className={`flex items-center gap-1.5 ${overdue ? "font-semibold text-destructive" : ""}`}
          >
            <CalendarClock aria-hidden className="size-3.5" />
            المتابعة: {pipelineDate(lead.nextFollowUpAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 border-t pt-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => actions.onHistory(lead)}
          >
            <History aria-hidden className="size-3.5" />
            السجل
          </Button>
          {canWrite && lead.status !== "CONVERTED" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => actions.onEdit(lead)}
            >
              <Pencil aria-hidden className="size-3.5" />
              تعديل
            </Button>
          )}
          {canWrite &&
            LEAD_ALLOWED_TRANSITIONS[lead.status].map((status) => (
              <Button
                key={status}
                size="sm"
                variant={status === "DISQUALIFIED" ? "destructive" : "outline"}
                onClick={() => actions.onTransition(lead, status)}
              >
                <ChevronLeft aria-hidden className="size-3.5" />
                {SALES_LEAD_STATUS_LABELS[status]}
              </Button>
            ))}
          {canWrite && lead.status === "QUALIFIED" && (
            <Button size="sm" onClick={() => actions.onConvert(lead)}>
              تحويل إلى فرصة
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function OpportunityCard({
  opportunity,
  canWrite,
  actions,
}: {
  opportunity: OpportunityRow;
  canWrite: boolean;
  actions: OpportunityActions;
}) {
  const overdue = isOpportunityOverdue(
    opportunity.stage,
    opportunity.expectedCloseDate,
  );
  return (
    <Card className="rounded-md shadow-none">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold">{opportunity.title}</p>
            <p className="mt-0.5 text-2xs text-muted-foreground" dir="ltr">
              {opportunity.opportunityNumber}
            </p>
          </div>
          <Badge variant={stageVariant(opportunity.stage)}>
            {SALES_OPPORTUNITY_STAGE_LABELS[opportunity.stage]}
          </Badge>
        </div>
        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p>
            {opportunity.customerName ||
              opportunity.leadName ||
              "جهة غير مسمّاة"}
          </p>
          <p className="flex items-center gap-1.5">
            <UserRound aria-hidden className="size-3.5" />
            {opportunity.ownerName || "غير مسمّى"}
          </p>
          <p className="flex items-center gap-1.5">
            <CircleDollarSign aria-hidden className="size-3.5" />
            {formatIqd(opportunity.expectedValue)} · احتمال{" "}
            {opportunity.probability}%
          </p>
          <p
            className={`flex items-center gap-1.5 ${overdue ? "font-semibold text-destructive" : ""}`}
          >
            <CalendarClock aria-hidden className="size-3.5" />
            الإغلاق: {pipelineDate(opportunity.expectedCloseDate)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 border-t pt-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => actions.onHistory(opportunity)}
          >
            <History aria-hidden className="size-3.5" />
            السجل
          </Button>
          {canWrite &&
            opportunity.stage !== "WON" &&
            opportunity.stage !== "LOST" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => actions.onEdit(opportunity)}
              >
                <Pencil aria-hidden className="size-3.5" />
                تعديل
              </Button>
            )}
          {canWrite &&
            OPPORTUNITY_ALLOWED_TRANSITIONS[opportunity.stage].map((stage) => (
              <Button
                key={stage}
                size="sm"
                variant={
                  stage === "LOST"
                    ? "destructive"
                    : stage === "WON"
                      ? "default"
                      : "outline"
                }
                onClick={() => actions.onTransition(opportunity, stage)}
              >
                <ChevronLeft aria-hidden className="size-3.5" />
                {SALES_OPPORTUNITY_STAGE_LABELS[stage]}
              </Button>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function LeadsBoard({
  rows,
  view,
  canWrite,
  actions,
}: {
  rows: LeadRow[];
  view: "BOARD" | "LIST";
  canWrite: boolean;
  actions: LeadActions;
}) {
  if (!rows.length)
    return (
      <EmptyState
        resourceKey="customers"
        reason="NO_MATCH_FILTER"
        title="لا يوجد عملاء محتملون مطابقون"
      />
    );
  if (view === "LIST")
    return (
      <div className="grid gap-2 lg:grid-cols-2">
        {rows.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            canWrite={canWrite}
            actions={actions}
          />
        ))}
      </div>
    );
  return (
    <div className="grid items-start gap-3 xl:grid-cols-5">
      {SALES_LEAD_STATUSES.map((status) => {
        const statusRows = rows.filter((row) => row.status === status);
        return (
          <section
            key={status}
            className="min-w-0 rounded-md border bg-muted/20 p-2"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                {SALES_LEAD_STATUS_LABELS[status]}
              </h2>
              <Badge variant="outline">
                {statusRows.length.toLocaleString("ar-IQ-u-nu-latn")}
              </Badge>
            </div>
            <div className="space-y-2">
              {statusRows.map((lead) => (
                <LeadCard
                  key={lead.id}
                  lead={lead}
                  canWrite={canWrite}
                  actions={actions}
                />
              ))}
              {!statusRows.length && (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  لا سجلات
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function OpportunitiesBoard({
  rows,
  view,
  canWrite,
  actions,
}: {
  rows: OpportunityRow[];
  view: "BOARD" | "LIST";
  canWrite: boolean;
  actions: OpportunityActions;
}) {
  if (!rows.length)
    return (
      <EmptyState
        resourceKey="generic"
        reason="NO_MATCH_FILTER"
        title="لا توجد فرص مطابقة"
      />
    );
  if (view === "LIST")
    return (
      <div className="grid gap-2 lg:grid-cols-2">
        {rows.map((opportunity) => (
          <OpportunityCard
            key={opportunity.id}
            opportunity={opportunity}
            canWrite={canWrite}
            actions={actions}
          />
        ))}
      </div>
    );
  return (
    <div className="grid items-start gap-3 xl:grid-cols-5">
      {SALES_OPPORTUNITY_STAGES.map((stage) => {
        const stageRows = rows.filter((row) => row.stage === stage);
        return (
          <section
            key={stage}
            className="min-w-0 rounded-md border bg-muted/20 p-2"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                {SALES_OPPORTUNITY_STAGE_LABELS[stage]}
              </h2>
              <Badge variant="outline">
                {stageRows.length.toLocaleString("ar-IQ-u-nu-latn")}
              </Badge>
            </div>
            <div className="space-y-2">
              {stageRows.map((opportunity) => (
                <OpportunityCard
                  key={opportunity.id}
                  opportunity={opportunity}
                  canWrite={canWrite}
                  actions={actions}
                />
              ))}
              {!stageRows.length && (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  لا سجلات
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
