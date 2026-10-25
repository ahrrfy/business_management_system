import { useMemo, useState } from "react";
import {
  CalendarClock,
  ChevronLeft,
  CircleDollarSign,
  Columns3,
  Download,
  FileSpreadsheet,
  History,
  List,
  Pencil,
  Phone,
  Plus,
  Search,
  User,
  UserPlus,
  UserRound,
  X,
} from "lucide-react";
import {
  LEAD_ALLOWED_TRANSITIONS,
  OPPORTUNITY_ALLOWED_TRANSITIONS,
  SALES_LEAD_SOURCES,
  SALES_LEAD_SOURCE_LABELS,
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
import { EmptyState, ErrorState, LoadingState } from "@/components/PageState";
import {
  LeadFormDialog,
  OpportunityFormDialog,
  PipelineHistoryDialog,
  PipelineTransitionDialog,
  type LeadFormValue,
  type OpportunityFormValue,
} from "@/components/salesPipeline/PipelineDialogs";
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
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { formatIqd } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { buildOperationalContactMessage } from "@/lib/whatsapp";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";
import {
  isLeadOverdue,
  isOpportunityOverdue,
  pipelineDate,
} from "@/components/salesPipeline/policy";

function EnhancedLeadCard({
  lead,
  canWrite,
  actions,
  onOpenDossier,
}: {
  lead: LeadRow;
  canWrite: boolean;
  actions: {
    onEdit: (lead: LeadRow) => void;
    onTransition: (lead: LeadRow, toStatus: SalesLeadStatus) => void;
    onConvert: (lead: LeadRow) => void;
    onHistory: (lead: LeadRow) => void;
  };
  onOpenDossier: (customerId: number) => void;
}) {
  const overdue = isLeadOverdue(lead.status, lead.nextFollowUpAt);
  const statusStyles: Record<SalesLeadStatus, string> = {
    NEW: "border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
    CONTACTED: "border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
    QUALIFIED: "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
    DISQUALIFIED: "border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
    CONVERTED: "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
  };

  return (
    <Card className="rounded-md shadow-none border">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold">{lead.contactName}</p>
            <p className="mt-0.5 text-2xs text-muted-foreground" dir="ltr">{lead.leadNumber}</p>
          </div>
          <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${statusStyles[lead.status] ?? "border-border bg-muted/40 text-muted-foreground"}`}>
            {SALES_LEAD_STATUS_LABELS[lead.status]}
          </span>
        </div>

        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p>{SALES_LEAD_SOURCE_LABELS[lead.source]}{lead.companyName ? ` · ${lead.companyName}` : ""}</p>
          <p className="flex items-center gap-1.5"><UserRound aria-hidden className="size-3.5" />{lead.ownerName || "غير مسمّى"}</p>
          {lead.phone && (
            <p className="flex items-center gap-1.5" dir="ltr"><Phone aria-hidden className="size-3.5 text-[var(--sem-pos)]" />{lead.phone}</p>
          )}
          <p className={`flex items-center gap-1.5 ${overdue ? "font-semibold text-[var(--sem-neg)]" : ""}`}>
            <CalendarClock aria-hidden className="size-3.5" />المتابعة: {pipelineDate(lead.nextFollowUpAt)}
          </p>
        </div>

        {/* أدوات تشغيلية سريعة: ملف شامل 360، اتصال، وواتساب */}
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
          {lead.customerId && (
            <Button type="button" variant="ghost" size="icon-sm" className="size-7 text-primary hover:bg-primary/10" onClick={() => onOpenDossier(lead.customerId!)} title="الملف الشامل 360°" aria-label={`الملف الشامل 360° للعميل ${lead.contactName}`}>
              <User className="size-3.5" aria-hidden />
            </Button>
          )}
          {lead.phone && (
            <Button asChild variant="ghost" size="icon-sm" className="size-7 text-[var(--sem-pos)] hover:bg-accent" title={`اتصال: ${lead.phone}`} aria-label={`اتصال بالعميل ${lead.contactName}`}>
              <a href={`tel:${lead.phone}`}><Phone className="size-3.5" aria-hidden /></a>
            </Button>
          )}
          {lead.phone && (
            <WhatsAppShare phone={lead.phone} message={buildOperationalContactMessage({ partyName: lead.contactName, entityLabel: "طلب استفسار ومتابعة", nextAction: "نتواصل معكم لمتابعة تفاصيل الطلب وتزويدكم بالأسعار المناسبة." })} iconOnly size="icon-sm" className="size-7" label={`واتساب ${lead.contactName}`} />
          )}

          <div className="ms-auto flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => actions.onHistory(lead)} title="سجل الحركات">
              <History aria-hidden className="size-3.5" />السجل
            </Button>
            {canWrite && lead.status !== "CONVERTED" && (
              <Button size="sm" variant="outline" onClick={() => actions.onEdit(lead)} title="تعديل البيانات">
                <Pencil aria-hidden className="size-3.5" />تعديل
              </Button>
            )}
            {canWrite && LEAD_ALLOWED_TRANSITIONS[lead.status].map((status) => (
              <Button key={status} size="sm" variant={status === "DISQUALIFIED" ? "destructive" : "outline"} onClick={() => actions.onTransition(lead, status)}>
                <ChevronLeft aria-hidden className="size-3.5" />{SALES_LEAD_STATUS_LABELS[status]}
              </Button>
            ))}
            {canWrite && lead.status === "QUALIFIED" && (
              <Button size="sm" onClick={() => actions.onConvert(lead)}>تحويل إلى صفقة</Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EnhancedOpportunityCard({
  opportunity,
  options,
  canWrite,
  actions,
  onOpenDossier,
}: {
  opportunity: OpportunityRow;
  options: PipelineOptions;
  canWrite: boolean;
  actions: {
    onEdit: (opportunity: OpportunityRow) => void;
    onTransition: (opportunity: OpportunityRow, toStage: SalesOpportunityStage) => void;
    onHistory: (opportunity: OpportunityRow) => void;
  };
  onOpenDossier: (customerId: number) => void;
}) {
  const overdue = isOpportunityOverdue(opportunity.stage, opportunity.expectedCloseDate);
  const customer = options.customers.find((c) => c.id === opportunity.customerId);
  const customerPhone = customer?.phone;

  const stageStyles: Record<SalesOpportunityStage, string> = {
    DISCOVERY: "border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
    PROPOSAL: "border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
    NEGOTIATION: "border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
    WON: "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
    LOST: "border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
  };

  return (
    <Card className="rounded-md shadow-none border">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold">{opportunity.title}</p>
            <p className="mt-0.5 text-2xs text-muted-foreground" dir="ltr">{opportunity.opportunityNumber}</p>
          </div>
          <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${stageStyles[opportunity.stage] ?? "border-border bg-muted/40 text-muted-foreground"}`}>
            {SALES_OPPORTUNITY_STAGE_LABELS[opportunity.stage]}
          </span>
        </div>

        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p>{opportunity.customerName || opportunity.leadName || "جهة غير مسمّاة"}</p>
          <p className="flex items-center gap-1.5"><UserRound aria-hidden className="size-3.5" />{opportunity.ownerName || "غير مسمّى"}</p>
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <CircleDollarSign aria-hidden className="size-3.5 text-[var(--sem-pos)]" />
            {formatIqd(opportunity.expectedValue)} · احتمال {opportunity.probability}%
          </p>
          {customerPhone && (
            <p className="flex items-center gap-1.5" dir="ltr"><Phone aria-hidden className="size-3.5 text-[var(--sem-pos)]" />{customerPhone}</p>
          )}
          <p className={`flex items-center gap-1.5 ${overdue ? "font-semibold text-[var(--sem-neg)]" : ""}`}>
            <CalendarClock aria-hidden className="size-3.5" />الإغلاق المتوقع: {pipelineDate(opportunity.expectedCloseDate)}
          </p>
        </div>

        {/* أدوات تشغيلية ميدانية سريعة */}
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
          {opportunity.customerId && (
            <Button type="button" variant="ghost" size="icon-sm" className="size-7 text-primary hover:bg-primary/10" onClick={() => onOpenDossier(opportunity.customerId!)} title="الملف الشامل 360° للزبون" aria-label={`الملف الشامل 360° للزبون ${opportunity.customerName ?? ""}`}>
              <User className="size-3.5" aria-hidden />
            </Button>
          )}
          {customerPhone && (
            <Button asChild variant="ghost" size="icon-sm" className="size-7 text-[var(--sem-pos)] hover:bg-accent" title={`اتصال مباشر: ${customerPhone}`} aria-label={`اتصال بالزبون ${opportunity.customerName ?? ""}`}>
              <a href={`tel:${customerPhone}`}><Phone className="size-3.5" aria-hidden /></a>
            </Button>
          )}
          {customerPhone && (
            <WhatsAppShare phone={customerPhone} message={buildOperationalContactMessage({ partyName: opportunity.customerName ?? "الزبون", entityLabel: `صفقة ${opportunity.title}`, nextAction: "نتواصل معكم لمتابعة تفاصيل العرض والاتفاق وموعد التنفيذ." })} iconOnly size="icon-sm" className="size-7" label={`واتساب ${opportunity.customerName ?? "الزبون"}`} />
          )}

          <div className="ms-auto flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => actions.onHistory(opportunity)} title="سجل الحركات">
              <History aria-hidden className="size-3.5" />السجل
            </Button>
            {canWrite && opportunity.stage !== "WON" && opportunity.stage !== "LOST" && (
              <Button size="sm" variant="outline" onClick={() => actions.onEdit(opportunity)}>
                <Pencil aria-hidden className="size-3.5" />تعديل
              </Button>
            )}
            {canWrite && OPPORTUNITY_ALLOWED_TRANSITIONS[opportunity.stage].map((stage) => (
              <Button key={stage} size="sm" variant={stage === "LOST" ? "destructive" : stage === "WON" ? "default" : "outline"} onClick={() => actions.onTransition(opportunity, stage)}>
                <ChevronLeft aria-hidden className="size-3.5" />{SALES_OPPORTUNITY_STAGE_LABELS[stage]}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EnhancedLeadsBoard({
  rows,
  view,
  canWrite,
  actions,
  onOpenDossier,
}: {
  rows: LeadRow[];
  view: "BOARD" | "LIST";
  canWrite: boolean;
  actions: {
    onEdit: (lead: LeadRow) => void;
    onTransition: (lead: LeadRow, toStatus: SalesLeadStatus) => void;
    onConvert: (lead: LeadRow) => void;
    onHistory: (lead: LeadRow) => void;
  };
  onOpenDossier: (customerId: number) => void;
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
          <EnhancedLeadCard
            key={lead.id}
            lead={lead}
            canWrite={canWrite}
            actions={actions}
            onOpenDossier={onOpenDossier}
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
              <span className="inline-block rounded-full border px-1.5 py-0.5 text-2xs font-semibold">
                {statusRows.length.toLocaleString("ar-IQ-u-nu-latn")}
              </span>
            </div>
            <div className="space-y-2">
              {statusRows.map((lead) => (
                <EnhancedLeadCard
                  key={lead.id}
                  lead={lead}
                  canWrite={canWrite}
                  actions={actions}
                  onOpenDossier={onOpenDossier}
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

function EnhancedOpportunitiesBoard({
  rows,
  options,
  view,
  canWrite,
  actions,
  onOpenDossier,
}: {
  rows: OpportunityRow[];
  options: PipelineOptions;
  view: "BOARD" | "LIST";
  canWrite: boolean;
  actions: {
    onEdit: (opportunity: OpportunityRow) => void;
    onTransition: (
      opportunity: OpportunityRow,
      toStage: SalesOpportunityStage,
    ) => void;
    onHistory: (opportunity: OpportunityRow) => void;
  };
  onOpenDossier: (customerId: number) => void;
}) {
  if (!rows.length)
    return (
      <EmptyState
        resourceKey="generic"
        reason="NO_MATCH_FILTER"
        title="لا توجد صفقات مطابقة"
      />
    );

  if (view === "LIST")
    return (
      <div className="grid gap-2 lg:grid-cols-2">
        {rows.map((opportunity) => (
          <EnhancedOpportunityCard
            key={opportunity.id}
            opportunity={opportunity}
            options={options}
            canWrite={canWrite}
            actions={actions}
            onOpenDossier={onOpenDossier}
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
              <h2 className="text-sm font-semibold truncate">
                {SALES_OPPORTUNITY_STAGE_LABELS[stage]}
              </h2>
              <span className="inline-block rounded-full border px-1.5 py-0.5 text-2xs font-semibold">
                {stageRows.length.toLocaleString("ar-IQ-u-nu-latn")}
              </span>
            </div>
            <div className="space-y-2">
              {stageRows.map((opportunity) => (
                <EnhancedOpportunityCard
                  key={opportunity.id}
                  opportunity={opportunity}
                  options={options}
                  canWrite={canWrite}
                  actions={actions}
                  onOpenDossier={onOpenDossier}
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
  const [selectedDossierCustomerId, setSelectedDossierCustomerId] =
    useState<number | null>(null);
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

  const handleExport = (format: "xlsx" | "csv") => {
    if (section === "OPPORTUNITIES") {
      if (opportunities.length === 0) {
        notify.err("لا توجد صفقات لتصديرها");
        return;
      }
      void exportRows<OpportunityRow>(opportunities, {
        filename: `متابعة-الصفقات-والطلبات-${fmtDate(new Date())}`,
        format,
        columns: [
          { key: "opportunityNumber", header: "رقم الطلب/الصفقة", map: (r) => r.opportunityNumber },
          { key: "title", header: "عنوان الصفقة", map: (r) => r.title },
          { key: "customerName", header: "الزبون", map: (r) => r.customerName ?? r.leadName ?? "—" },
          { key: "ownerName", header: "المسؤول", map: (r) => r.ownerName ?? "—" },
          { key: "stage", header: "المرحلة", map: (r) => SALES_OPPORTUNITY_STAGE_LABELS[r.stage] ?? r.stage },
          { key: "expectedValue", header: "القيمة التقديرية (د.ع)", money: true, map: (r) => Number(r.expectedValue) },
          { key: "probability", header: "نسبة الاحتمال", map: (r) => `${r.probability}%` },
          { key: "expectedCloseDate", header: "تاريخ الإغلاق المتوقع", map: (r) => pipelineDate(r.expectedCloseDate) },
        ],
      });
    } else {
      if (leads.length === 0) {
        notify.err("لا يوجد عملاء محتملون لتصديرهم");
        return;
      }
      void exportRows<LeadRow>(leads, {
        filename: `العملاء-المحتملون-${fmtDate(new Date())}`,
        format,
        columns: [
          { key: "leadNumber", header: "رقم السجل", map: (r) => r.leadNumber },
          { key: "contactName", header: "جهة الاتصال", map: (r) => r.contactName },
          { key: "companyName", header: "الشركة", map: (r) => r.companyName ?? "—" },
          { key: "phone", header: "الهاتف", map: (r) => r.phone ?? "—" },
          { key: "source", header: "المصدر", map: (r) => SALES_LEAD_SOURCE_LABELS[r.source] ?? r.source },
          { key: "ownerName", header: "المسؤول", map: (r) => r.ownerName ?? "—" },
          { key: "status", header: "الحالة", map: (r) => SALES_LEAD_STATUS_LABELS[r.status] ?? r.status },
          { key: "nextFollowUpAt", header: "موعد المتابعة", map: (r) => pipelineDate(r.nextFollowUpAt) },
        ],
      });
    }
  };

  return (
    <div className="mx-auto max-w-[1800px] space-y-4 pb-8">
      <PageHeader
        title="متابعة الصفقات والطلبات"
        description="متابعة مسار صفقات وطلبات الزبائن والعملاء المحتملين من أول تواصل حتى إتمام البيع وفاتورة الفوز."
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
              الفرص والطلبات
            </Button>
          </div>
          <UnifiedSearchInput
            value={q}
            onChange={setQ}
            placeholder="بحث بالاسم أو الرقم… (F2)"
            barcode={false}
            debounceMs={250}
            size="default"
            className="min-w-56 flex-1 sm:max-w-sm"
          />
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
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleExport("xlsx")}
              title="تصدير Excel"
              aria-label="تصدير Excel"
            >
              <FileSpreadsheet aria-hidden className="size-3.5" />
              Excel
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleExport("csv")}
              title="تصدير CSV"
              aria-label="تصدير CSV"
            >
              <Download aria-hidden className="size-3.5" />
              CSV
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
          message="تعذّر تحميل متابعة الصفقات والطلبات."
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
        <EnhancedLeadsBoard
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
          onOpenDossier={setSelectedDossierCustomerId}
        />
      ) : (
        <EnhancedOpportunitiesBoard
          rows={opportunities}
          options={options}
          view={view}
          canWrite={canWrite}
          actions={{
            onEdit: (row) =>
              setOpportunityForm({
                initial: row,
                lead: null,
                requestKey: requestKey(),
              }),
            onTransition: (row, toStage) => {
              setOptionBranchId(row.branchId);
              setTransition({
                kind: "OPPORTUNITY",
                row,
                toStage,
                requestKey: requestKey(),
              });
            },
            onHistory: (row) =>
              setHistory({ kind: "OPPORTUNITY", id: row.id, title: row.title }),
          }}
          onOpenDossier={setSelectedDossierCustomerId}
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
        key={transition?.requestKey ?? "closed-transition"}
        open={transition != null}
        onOpenChange={(open) => {
          if (!open) setTransition(null);
        }}
        kind={transition?.kind ?? "LEAD"}
        branchId={transition?.row.branchId ?? null}
        optionsError={optionsQ.isError}
        onRetryOptions={() => void optionsQ.refetch()}
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

      <CustomerDossierDrawer
        customerId={selectedDossierCustomerId}
        open={selectedDossierCustomerId != null}
        onClose={() => setSelectedDossierCustomerId(null)}
      />
    </div>
  );
}
