import { useMemo, useState } from "react";
import { Columns3, List, Plus, Search, UserPlus, X } from "lucide-react";
import {
  SALES_LEAD_STATUSES,
  SALES_LEAD_STATUS_LABELS,
  SALES_OPPORTUNITY_STAGES,
  SALES_OPPORTUNITY_STAGE_LABELS,
  type SalesLeadStatus,
  type SalesOpportunityStage,
} from "@shared/salesPipeline";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import {
  LeadFormDialog,
  OpportunityFormDialog,
  PipelineHistoryDialog,
  PipelineTransitionDialog,
  type LeadFormValue,
  type OpportunityFormValue,
} from "@/components/salesPipeline/PipelineDialogs";
import {
  LeadsBoard,
  OpportunitiesBoard,
} from "@/components/salesPipeline/PipelineBoard";
import { PipelineSummary } from "@/components/salesPipeline/PipelineSummary";
import type {
  DashboardData,
  LeadRow,
  OpportunityRow,
  PipelineOptions,
} from "@/components/salesPipeline/types";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";

type LeadFormState = { initial: LeadRow | null; requestKey: string } | null;
type OpportunityFormState = {
  initial: OpportunityRow | null;
  lead: LeadRow | null;
  requestKey: string;
} | null;
type TransitionState =
  | {
      kind: "LEAD";
      row: LeadRow;
      toStatus: SalesLeadStatus;
      requestKey: string;
    }
  | {
      kind: "OPPORTUNITY";
      row: OpportunityRow;
      toStage: SalesOpportunityStage;
      requestKey: string;
    }
  | null;
type HistoryState = {
  kind: "LEAD" | "OPPORTUNITY";
  id: number;
  title: string;
} | null;

function requestKey(): string {
  return crypto.randomUUID();
}

export default function SalesPipeline() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canWrite =
    !!me.data?.role &&
    moduleAccessAllowed(
      me.data.role as RoleKey,
      (me.data.permissionsOverride ?? null) as PermissionMap | null,
      "crm",
      "FULL",
      ["cashier", "manager", "sales_rep"],
    );
  const [section, setSection] = useState<"LEADS" | "OPPORTUNITIES">("LEADS");
  const [view, setView] = useState<"BOARD" | "LIST">("BOARD");
  const [q, setQ] = useState("");
  const [leadStatus, setLeadStatus] = useState("");
  const [opportunityStage, setOpportunityStage] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [optionBranchId, setOptionBranchId] = useState<number | null>(null);
  const [leadForm, setLeadForm] = useState<LeadFormState>(null);
  const [opportunityForm, setOpportunityForm] =
    useState<OpportunityFormState>(null);
  const [transition, setTransition] = useState<TransitionState>(null);
  const [history, setHistory] = useState<HistoryState>(null);

  const dashboardQ = trpc.salesPipeline.dashboard.useQuery();
  const optionsQ = trpc.salesPipeline.options.useQuery({
    branchId: optionBranchId,
  });
  const leadsQ = trpc.salesPipeline.leads.list.useInfiniteQuery(
    {
      q: q.trim() || undefined,
      status: (leadStatus || undefined) as SalesLeadStatus | undefined,
      overdueOnly,
      limit: 100,
    },
    {
      enabled: section === "LEADS",
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const opportunitiesQ = trpc.salesPipeline.opportunities.list.useInfiniteQuery(
    {
      q: q.trim() || undefined,
      stage: (opportunityStage || undefined) as
        | SalesOpportunityStage
        | undefined,
      overdueOnly,
      limit: 100,
    },
    {
      enabled: section === "OPPORTUNITIES",
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const leadHistoryQ = trpc.salesPipeline.leads.get.useQuery(
    { leadId: history?.id ?? 0 },
    { enabled: history?.kind === "LEAD" },
  );
  const opportunityHistoryQ = trpc.salesPipeline.opportunities.get.useQuery(
    { opportunityId: history?.id ?? 0 },
    { enabled: history?.kind === "OPPORTUNITY" },
  );

  const options = (optionsQ.data ?? {
    selectedBranchId: null,
    branches: [],
    owners: [],
    customers: [],
    quotations: [],
    invoices: [],
  }) as PipelineOptions;
  const leads = (leadsQ.data?.pages.flatMap((page) => page.rows) ??
    []) as LeadRow[];
  const opportunities = (opportunitiesQ.data?.pages.flatMap(
    (page) => page.rows,
  ) ?? []) as OpportunityRow[];
  const invalidate = async () => {
    await Promise.all([
      utils.salesPipeline.dashboard.invalidate(),
      utils.salesPipeline.leads.list.invalidate(),
      utils.salesPipeline.opportunities.list.invalidate(),
      utils.salesPipeline.options.invalidate(),
    ]);
  };

  const createLead = trpc.salesPipeline.leads.create.useMutation({
    onSuccess: async () => {
      await invalidate();
      setLeadForm(null);
      notify.ok("تم إنشاء العميل المحتمل");
    },
    onError: (error: unknown) => notify.err(error),
  });
  const updateLead = trpc.salesPipeline.leads.update.useMutation({
    onSuccess: async () => {
      await invalidate();
      setLeadForm(null);
      notify.ok("تم تحديث العميل المحتمل");
    },
    onError: (error: unknown) => notify.err(error),
  });
  const transitionLead = trpc.salesPipeline.leads.transition.useMutation({
    onSuccess: async () => {
      await invalidate();
      setTransition(null);
      notify.ok("تم تحديث حالة العميل المحتمل");
    },
    onError: (error: unknown) => notify.err(error),
  });
  const convertLead = trpc.salesPipeline.leads.convert.useMutation({
    onSuccess: async () => {
      await invalidate();
      setOpportunityForm(null);
      setSection("OPPORTUNITIES");
      notify.ok("تم تحويل العميل المحتمل إلى فرصة");
    },
    onError: (error: unknown) => notify.err(error),
  });
  const createOpportunity = trpc.salesPipeline.opportunities.create.useMutation(
    {
      onSuccess: async () => {
        await invalidate();
        setOpportunityForm(null);
        notify.ok("تم إنشاء الفرصة");
      },
      onError: (error: unknown) => notify.err(error),
    },
  );
  const updateOpportunity = trpc.salesPipeline.opportunities.update.useMutation(
    {
      onSuccess: async () => {
        await invalidate();
        setOpportunityForm(null);
        notify.ok("تم تحديث الفرصة");
      },
      onError: (error: unknown) => notify.err(error),
    },
  );
  const transitionOpportunity =
    trpc.salesPipeline.opportunities.transition.useMutation({
      onSuccess: async () => {
        await invalidate();
        setTransition(null);
        notify.ok("تم تحديث مرحلة الفرصة");
      },
      onError: (error: unknown) => notify.err(error),
    });

  const filteredCount =
    section === "LEADS" ? leads.length : opportunities.length;
  const filterActive =
    q.trim() !== "" ||
    overdueOnly ||
    leadStatus !== "" ||
    opportunityStage !== "";
  const historyEvents = useMemo(() => {
    if (history?.kind === "LEAD") return leadHistoryQ.data?.events ?? [];
    if (history?.kind === "OPPORTUNITY")
      return opportunityHistoryQ.data?.events ?? [];
    return [];
  }, [history, leadHistoryQ.data, opportunityHistoryQ.data]);
  const initialError =
    dashboardQ.isError ||
    optionsQ.isError ||
    (section === "LEADS" ? leadsQ.isError : opportunitiesQ.isError);
  const initialLoading =
    dashboardQ.isLoading ||
    optionsQ.isLoading ||
    (section === "LEADS" ? leadsQ.isLoading : opportunitiesQ.isLoading);

  const submitLeadForm = (value: LeadFormValue) => {
    if (!leadForm) return;
    if (leadForm.initial) {
      updateLead.mutate({
        leadId: leadForm.initial.id,
        expectedVersion: leadForm.initial.version,
        requestKey: leadForm.requestKey,
        reason: value.reason || "تحديث بيانات المتابعة",
        source: value.source,
        contactName: value.contactName,
        companyName: value.companyName,
        phone: value.phone,
        email: value.email,
        customerId: value.customerId,
        ownerId: value.ownerId ?? undefined,
        nextFollowUpAt: value.nextFollowUpAt,
      });
    } else {
      createLead.mutate({
        branchId: value.branchId,
        source: value.source,
        contactName: value.contactName,
        companyName: value.companyName,
        phone: value.phone,
        email: value.email,
        customerId: value.customerId,
        ownerId: value.ownerId,
        nextFollowUpAt: value.nextFollowUpAt,
        clientRequestId: leadForm.requestKey,
      });
    }
  };

  const submitOpportunityForm = (value: OpportunityFormValue) => {
    if (!opportunityForm) return;
    if (opportunityForm.lead) {
      convertLead.mutate({
        leadId: opportunityForm.lead.id,
        expectedVersion: opportunityForm.lead.version,
        customerId: value.customerId,
        ownerId: value.ownerId,
        title: value.title,
        expectedValue: value.expectedValue,
        probability: value.probability,
        expectedCloseDate: value.expectedCloseDate,
        quotationId: value.quotationId,
        requestKey: opportunityForm.requestKey,
        reason: value.reason || "تأهيل العميل وتحويله إلى فرصة",
      });
    } else if (opportunityForm.initial) {
      updateOpportunity.mutate({
        opportunityId: opportunityForm.initial.id,
        expectedVersion: opportunityForm.initial.version,
        requestKey: opportunityForm.requestKey,
        reason: value.reason || "تحديث بيانات الفرصة",
        customerId: value.customerId,
        ownerId: value.ownerId ?? undefined,
        title: value.title,
        expectedValue: value.expectedValue,
        probability: value.probability,
        expectedCloseDate: value.expectedCloseDate,
        quotationId: value.quotationId,
      });
    } else if (value.customerId != null) {
      createOpportunity.mutate({
        branchId: value.branchId,
        customerId: value.customerId,
        ownerId: value.ownerId,
        title: value.title,
        expectedValue: value.expectedValue,
        probability: value.probability,
        expectedCloseDate: value.expectedCloseDate,
        quotationId: value.quotationId,
        clientRequestId: opportunityForm.requestKey,
      });
    }
  };

  return (
    <div className="mx-auto max-w-[1800px] space-y-4 pb-8">
      <PageHeader
        title="مسار المبيعات"
        description="متابعة العملاء المحتملين والفرص من أول اتصال حتى فاتورة الفوز، مع مسؤول وموعد وأثر لكل انتقال."
        actions={
          canWrite ? (
            <>
              <Button
                variant="outline"
                onClick={() =>
                  setLeadForm({ initial: null, requestKey: requestKey() })
                }
              >
                <UserPlus aria-hidden className="size-4" />
                عميل محتمل
              </Button>
              <Button
                onClick={() =>
                  setOpportunityForm({
                    initial: null,
                    lead: null,
                    requestKey: requestKey(),
                  })
                }
              >
                <Plus aria-hidden className="size-4" />
                فرصة لعميل
              </Button>
            </>
          ) : undefined
        }
        actionsClassName="sm:w-auto"
      />
      {dashboardQ.data && (
        <PipelineSummary data={dashboardQ.data as DashboardData} />
      )}
      <Card className="rounded-md shadow-none">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="flex rounded-md border p-0.5">
            <Button
              size="sm"
              variant={section === "LEADS" ? "default" : "ghost"}
              onClick={() => setSection("LEADS")}
            >
              العملاء المحتملون
            </Button>
            <Button
              size="sm"
              variant={section === "OPPORTUNITIES" ? "default" : "ghost"}
              onClick={() => setSection("OPPORTUNITIES")}
            >
              الفرص
            </Button>
          </div>
          <div className="relative min-w-56 flex-1 sm:max-w-sm">
            <Search
              aria-hidden
              className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="بحث بالاسم أو الرقم…"
              className="pr-8"
            />
          </div>
          {section === "LEADS" ? (
            <AppSelect
              value={leadStatus}
              onValueChange={setLeadStatus}
              className="w-44"
            >
              <option value="">كل الحالات</option>
              {SALES_LEAD_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {SALES_LEAD_STATUS_LABELS[status]}
                </option>
              ))}
            </AppSelect>
          ) : (
            <AppSelect
              value={opportunityStage}
              onValueChange={setOpportunityStage}
              className="w-44"
            >
              <option value="">كل المراحل</option>
              {SALES_OPPORTUNITY_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {SALES_OPPORTUNITY_STAGE_LABELS[stage]}
                </option>
              ))}
            </AppSelect>
          )}
          <Button
            size="sm"
            variant={overdueOnly ? "default" : "outline"}
            onClick={() => setOverdueOnly((value) => !value)}
          >
            المتأخر فقط
          </Button>
          <div className="flex rounded-md border p-0.5">
            <Button
              size="icon-sm"
              variant={view === "BOARD" ? "secondary" : "ghost"}
              onClick={() => setView("BOARD")}
              aria-label="عرض كانبان"
            >
              <Columns3 aria-hidden className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant={view === "LIST" ? "secondary" : "ghost"}
              onClick={() => setView("LIST")}
              aria-label="عرض قائمة"
            >
              <List aria-hidden className="size-4" />
            </Button>
          </div>
          {filterActive && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQ("");
                setLeadStatus("");
                setOpportunityStage("");
                setOverdueOnly(false);
              }}
            >
              <X aria-hidden className="size-4" />
              مسح
            </Button>
          )}
          <span className="ms-auto text-xs text-muted-foreground">
            {filteredCount.toLocaleString("ar-IQ-u-nu-latn")} سجل
          </span>
        </CardContent>
      </Card>
      {initialError ? (
        <ErrorState
          message="تعذّر تحميل مسار المبيعات."
          onRetry={() => {
            void dashboardQ.refetch();
            void optionsQ.refetch();
            void leadsQ.refetch();
            void opportunitiesQ.refetch();
          }}
        />
      ) : initialLoading ? (
        <LoadingState message={ACTION_LABELS.loading} />
      ) : section === "LEADS" ? (
        <LeadsBoard
          rows={leads}
          view={view}
          canWrite={canWrite}
          actions={{
            onEdit: (row) =>
              setLeadForm({ initial: row, requestKey: requestKey() }),
            onTransition: (row, toStatus) =>
              setTransition({
                kind: "LEAD",
                row,
                toStatus,
                requestKey: requestKey(),
              }),
            onConvert: (row) =>
              setOpportunityForm({
                initial: null,
                lead: row,
                requestKey: requestKey(),
              }),
            onHistory: (row) =>
              setHistory({ kind: "LEAD", id: row.id, title: row.contactName }),
          }}
        />
      ) : (
        <OpportunitiesBoard
          rows={opportunities}
          view={view}
          canWrite={canWrite}
          actions={{
            onEdit: (row) =>
              setOpportunityForm({
                initial: row,
                lead: null,
                requestKey: requestKey(),
              }),
            onTransition: (row, toStage) =>
              setTransition({
                kind: "OPPORTUNITY",
                row,
                toStage,
                requestKey: requestKey(),
              }),
            onHistory: (row) =>
              setHistory({ kind: "OPPORTUNITY", id: row.id, title: row.title }),
          }}
        />
      )}

      {(section === "LEADS"
        ? leadsQ.hasNextPage
        : opportunitiesQ.hasNextPage) && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={
              section === "LEADS"
                ? leadsQ.isFetchingNextPage
                : opportunitiesQ.isFetchingNextPage
            }
            onClick={() => {
              if (section === "LEADS") void leadsQ.fetchNextPage();
              else void opportunitiesQ.fetchNextPage();
            }}
          >
            تحميل المزيد
          </Button>
        </div>
      )}

      <LeadFormDialog
        open={leadForm != null}
        onOpenChange={(open) => {
          if (!open) setLeadForm(null);
        }}
        options={options}
        initial={leadForm?.initial}
        pending={createLead.isPending || updateLead.isPending}
        onBranchChange={setOptionBranchId}
        onSubmit={submitLeadForm}
      />
      <OpportunityFormDialog
        open={opportunityForm != null}
        onOpenChange={(open) => {
          if (!open) setOpportunityForm(null);
        }}
        options={options}
        initial={opportunityForm?.initial}
        lead={opportunityForm?.lead}
        pending={
          createOpportunity.isPending ||
          updateOpportunity.isPending ||
          convertLead.isPending
        }
        onBranchChange={setOptionBranchId}
        onSubmit={submitOpportunityForm}
      />
      <PipelineTransitionDialog
        open={transition != null}
        onOpenChange={(open) => {
          if (!open) setTransition(null);
        }}
        kind={transition?.kind ?? "LEAD"}
        leadStatus={
          transition?.kind === "LEAD" ? transition.toStatus : undefined
        }
        opportunityStage={
          transition?.kind === "OPPORTUNITY" ? transition.toStage : undefined
        }
        customerId={
          transition?.kind === "OPPORTUNITY" ? transition.row.customerId : null
        }
        options={options}
        pending={transitionLead.isPending || transitionOpportunity.isPending}
        onSubmit={({ reason, invoiceId }) => {
          if (transition?.kind === "LEAD")
            transitionLead.mutate({
              leadId: transition.row.id,
              expectedVersion: transition.row.version,
              requestKey: transition.requestKey,
              toStatus: transition.toStatus,
              reason,
            });
          else if (transition?.kind === "OPPORTUNITY")
            transitionOpportunity.mutate({
              opportunityId: transition.row.id,
              expectedVersion: transition.row.version,
              requestKey: transition.requestKey,
              toStage: transition.toStage,
              reason,
              invoiceId,
            });
        }}
      />
      <PipelineHistoryDialog
        open={history != null}
        onOpenChange={(open) => {
          if (!open) setHistory(null);
        }}
        title={history?.title ?? "السجل"}
        loading={
          history?.kind === "LEAD"
            ? leadHistoryQ.isLoading
            : opportunityHistoryQ.isLoading
        }
        error={
          history?.kind === "LEAD"
            ? leadHistoryQ.isError
            : opportunityHistoryQ.isError
        }
        onRetry={() => {
          if (history?.kind === "LEAD") void leadHistoryQ.refetch();
          else void opportunityHistoryQ.refetch();
        }}
        events={historyEvents}
      />
    </div>
  );
}
