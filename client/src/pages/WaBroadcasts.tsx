// بث واتساب التسويقي — تبويب «بث واتساب» في CrmHub (S5، T5.3). الخادم جاهز بالكامل
// (server/routers/broadcastsRouter.ts + server/services/whatsapp/{broadcastService,segmentService}.ts)؛
// هذا الملف يستهلكه فقط: باني شريحة (RFM + نوع عميل/فئة سعر/فرع/رصيد) + معاينة حيّة (عدد+كلفة) +
// اختيار قالب معتمَد (MARKETING/APPROVED) + ربط متغيّراته بحقول العميل + جدولة/سرعة إرسال ⇒ حفظ
// كمسودة، ثم إطلاق (SOD: فوق عتبة الجمهور يتحوّل PENDING_APPROVAL بانتظار مديرٍ آخر — لا استثناء
// حتى لـadmin، قرار مالك موثَّق في رأس broadcastService.ts)، وطابور اعتماد مخصّص، وإيقاف/استئناف/
// إلغاء، وتقرير نتائج (تجميع حالات المستلمين بنسب — نواة تقرير أداء الحملات الكامل في S6).
//
// بثّ واتساب التسويقي قناة تنفيذ منفصلة عن تبويب «الحملات» القائم (crmCampaigns — المظلّة/الهدف/
// المدة)؛ الربط بينهما اختياري فقط (crmCampaignId، للعزو لا للتبعية).
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  BarChart3,
  Calendar,
  CheckCircle2,
  Coins,
  Filter,
  Gauge,
  Info,
  LayoutTemplate,
  Pause,
  Play,
  Plus,
  RotateCcw,
  ShieldAlert,
  Users,
  XCircle,
} from "lucide-react";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { fmtDateTime } from "@/lib/date";
import { formatIqd } from "@/lib/money";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState } from "@/components/PageState";
import { DataTable } from "@/components/DataTable";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MoneyInput } from "@/components/form/MoneyInput";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const fmtCount = (n: number | null | undefined) => (n ?? 0).toLocaleString("ar-IQ-u-nu-latn");

/* ═══════════ أنواع وثوابت ═══════════ */

type BroadcastRow = RouterOutputs["broadcasts"]["list"][number];
type BroadcastDetailData = RouterOutputs["broadcasts"]["get"];
type SegmentCriteriaInput = RouterInputs["broadcasts"]["preview"]["segment"];
type WaTemplateRow = RouterOutputs["integrations"]["templates"]["list"][number];

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "danger" | "info" | "neutral";

const BROADCAST_STATUS_META: Record<string, { label: string; variant: BadgeVariant }> = {
  DRAFT: { label: "مسودة", variant: "neutral" },
  PENDING_APPROVAL: { label: "بانتظار الاعتماد", variant: "warning" },
  APPROVED: { label: "معتمدة", variant: "success" },
  RUNNING: { label: "قيد التشغيل", variant: "success" },
  PAUSED: { label: "موقوفة مؤقتاً", variant: "warning" },
  COMPLETED: { label: "مكتملة", variant: "info" },
  CANCELLED: { label: "ملغاة", variant: "neutral" },
};

const RECIPIENT_STATUS_META: Record<string, { label: string; variant: BadgeVariant }> = {
  PENDING: { label: "قيد الانتظار", variant: "neutral" },
  QUEUED: { label: "بالطابور", variant: "info" },
  SENT: { label: "أُرسلت", variant: "secondary" },
  DELIVERED: { label: "وصلت", variant: "success" },
  READ: { label: "قُرئت", variant: "success" },
  FAILED: { label: "فشلت", variant: "danger" },
  SKIPPED_OPTOUT: { label: "تخطّي (غير موافق)", variant: "warning" },
};

const CANCELLABLE_STATUSES = new Set(["DRAFT", "PENDING_APPROVAL", "APPROVED", "RUNNING", "PAUSED"]);

const CUSTOMER_TYPES = ["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"] as const;
const PRICE_TIER_OPTIONS = [
  { v: "RETAIL", l: "مفرد" },
  { v: "WHOLESALE", l: "جملة" },
  { v: "GOVERNMENT", l: "حكومي" },
] as const;
const RFM_PRESET_OPTIONS = [
  { v: "", l: "بلا رتبة جاهزة" },
  { v: "VIP", l: "VIP — نشاط/إنفاق عالٍ" },
  { v: "AT_RISK", l: "معرَّضون للفقد" },
  { v: "DORMANT", l: "خاملون" },
  { v: "NEW", l: "عملاء جدد" },
] as const;
const CUSTOMER_FIELD_OPTIONS = [
  { v: "", l: "بلا ربط" },
  { v: "name", l: "اسم العميل" },
  { v: "currentBalance", l: "الرصيد الحالي" },
  { v: "phone", l: "رقم الهاتف" },
  { v: "phoneE164", l: "رقم الهاتف (دولي)" },
] as const;

function StatusBadge({ status }: { status: string }) {
  const m = BROADCAST_STATUS_META[status] ?? { label: status, variant: "neutral" as const };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function toggleInArray<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

/* ═══════════ باني الشريحة (فلاتر + معاينة حيّة) ═══════════ */

interface SegmentFormState {
  customerTypes: string[];
  priceTiers: string[];
  branchId: string;
  balanceMin: string;
  balanceMax: string;
  rfmPreset: "" | "VIP" | "AT_RISK" | "DORMANT" | "NEW";
  recencyDays: string;
  minInvoices: string;
  minSpend: string;
  strictPreview: boolean;
}
const EMPTY_SEGMENT_FORM: SegmentFormState = {
  customerTypes: [],
  priceTiers: [],
  branchId: "",
  balanceMin: "",
  balanceMax: "",
  rfmPreset: "",
  recencyDays: "",
  minInvoices: "",
  minSpend: "",
  strictPreview: false,
};

function buildSegmentCriteria(f: SegmentFormState, isAdmin: boolean): SegmentCriteriaInput {
  const rfm: NonNullable<SegmentCriteriaInput["rfm"]> = {};
  if (f.rfmPreset) rfm.preset = f.rfmPreset;
  if (f.recencyDays.trim()) rfm.recencyDays = Number(f.recencyDays);
  if (f.minInvoices.trim()) rfm.minInvoices = Number(f.minInvoices);
  if (f.minSpend.trim()) rfm.minSpend = f.minSpend.trim();
  return {
    customerTypes: f.customerTypes.length ? (f.customerTypes as SegmentCriteriaInput["customerTypes"]) : undefined,
    priceTiers: f.priceTiers.length ? (f.priceTiers as SegmentCriteriaInput["priceTiers"]) : undefined,
    branchId: isAdmin && f.branchId ? Number(f.branchId) : undefined,
    balanceMin: f.balanceMin.trim() || undefined,
    balanceMax: f.balanceMax.trim() || undefined,
    rfm: Object.keys(rfm).length ? rfm : undefined,
    requireOptIn: f.strictPreview || undefined,
  };
}

function SegmentBuilder({
  value,
  onChange,
  isAdmin,
  branches,
}: {
  value: SegmentFormState;
  onChange: (v: SegmentFormState) => void;
  isAdmin: boolean;
  branches: { id: number; name: string }[];
}) {
  const set = <K extends keyof SegmentFormState>(k: K, v: SegmentFormState[K]) => onChange({ ...value, [k]: v });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <Filter aria-hidden className="size-4" /> باني الشريحة
        </CardTitle>
        <CardDescription>كل الفلاتر تُجمَع بعملية AND — شريحة أضيق كلما أضفت معياراً.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">نوع العميل</label>
          <div className="flex flex-wrap gap-1.5">
            {CUSTOMER_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => set("customerTypes", toggleInArray(value.customerTypes, t))}
                aria-pressed={value.customerTypes.includes(t)}
                className={`text-xs px-3 py-1 rounded-md font-medium border transition-colors ${
                  value.customerTypes.includes(t)
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted text-muted-foreground border-transparent hover:bg-accent"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">فئة السعر</label>
          <div className="flex flex-wrap gap-1.5">
            {PRICE_TIER_OPTIONS.map((t) => (
              <button
                key={t.v}
                type="button"
                onClick={() => set("priceTiers", toggleInArray(value.priceTiers, t.v))}
                aria-pressed={value.priceTiers.includes(t.v)}
                className={`text-xs px-3 py-1 rounded-md font-medium border transition-colors ${
                  value.priceTiers.includes(t.v)
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted text-muted-foreground border-transparent hover:bg-accent"
                }`}
              >
                {t.l}
              </button>
            ))}
          </div>
        </div>

        {isAdmin ? (
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">الفرع (يحدّد أيضاً نشاط الشراء المقاس لـRFM)</label>
            <select className={`${selectCls} w-full sm:w-64`} value={value.branchId} onChange={(e) => set("branchId", e.target.value)}>
              <option value="">كل الفروع</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">الفرع مثبَّت تلقائياً على فرعك — يفرضه الخادم.</p>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">الرصيد الحالي — من (د.ع)</label>
            <MoneyInput value={value.balanceMin} onChange={(v) => set("balanceMin", v)} allowNegative placeholder="بلا حدّ أدنى" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">الرصيد الحالي — إلى (د.ع)</label>
            <MoneyInput value={value.balanceMax} onChange={(v) => set("balanceMax", v)} allowNegative placeholder="بلا حدّ أعلى" />
          </div>
        </div>

        <div className="rounded-lg border bg-muted/20 p-3 space-y-2.5">
          <label className="text-xs font-bold text-muted-foreground">RFM (الحداثة/التكرار/الإنفاق)</label>
          <select className={`${selectCls} w-full sm:w-64`} value={value.rfmPreset} onChange={(e) => set("rfmPreset", e.target.value as SegmentFormState["rfmPreset"])}>
            {RFM_PRESET_OPTIONS.map((o) => (
              <option key={o.v} value={o.v}>{o.l}</option>
            ))}
          </select>
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">اشترى خلال آخر (يوم)</label>
              <Input type="number" min={1} inputMode="numeric" value={value.recencyDays} onChange={(e) => set("recencyDays", e.target.value)} placeholder="—" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">عدد فواتير لا يقل عن</label>
              <Input type="number" min={1} inputMode="numeric" value={value.minInvoices} onChange={(e) => set("minInvoices", e.target.value)} placeholder="—" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">إجمالي شراء لا يقل عن (د.ع)</label>
              <MoneyInput value={value.minSpend} onChange={(v) => set("minSpend", v)} placeholder="—" />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">الرتبة الجاهزة والمعايير اليدوية تُجمَع معاً (AND) إن مُلئت كلتاهما.</p>
        </div>

        <div className="flex items-center gap-2.5 pt-1">
          <Switch id="strictPreview" checked={value.strictPreview} onCheckedChange={(v) => set("strictPreview", v)} />
          <label htmlFor="strictPreview" className="text-xs text-muted-foreground">
            احسب المعاينة بمعيار الإرسال الفعلي (موافقون على التسويق OPTED_IN فقط)
          </label>
        </div>
      </CardContent>
    </Card>
  );
}

function LivePreviewCard({ criteria }: { criteria: SegmentCriteriaInput }) {
  const debounced = useDebouncedValue(criteria, 350);
  const previewQ = trpc.broadcasts.preview.useQuery({ segment: debounced });
  return (
    <Card className="bg-muted/30">
      <CardContent className="p-3 flex flex-wrap items-center gap-5">
        <div className="flex items-center gap-1.5">
          <Users aria-hidden className="size-4 text-muted-foreground" />
          <span className="text-lg font-bold tabular-nums">{previewQ.isFetching ? "…" : fmtCount(previewQ.data?.audienceCount)}</span>
          <span className="text-xs text-muted-foreground">مستلم مطابق للشريحة</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Coins aria-hidden className="size-4 text-muted-foreground" />
          <span className="text-lg font-bold tabular-nums">{previewQ.isFetching ? "…" : formatIqd(previewQ.data?.costEstimate ?? "0")}</span>
          <span className="text-xs text-muted-foreground">كلفة تقديرية</span>
        </div>
        {previewQ.isError && <span className="text-xs text-destructive">تعذّر حساب المعاينة.</span>}
      </CardContent>
      <div className="px-3 pb-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <Info aria-hidden className="size-3.5 shrink-0 mt-0.5" />
        <span>سيُرسَل فعلياً للموافقين على التسويق فقط (OPTED_IN) دائماً — هذه المعاينة قد تشمل غير المؤكَّدين ما لم تُفعِّل «معيار الإرسال الفعلي» أعلاه.</span>
      </div>
    </Card>
  );
}

/* ═══════════ القالب + ربط المتغيّرات ═══════════ */

function buildPreviewText(template: WaTemplateRow | null, varsMap: Record<string, string>): string {
  if (!template) return "";
  let text = template.bodyText ?? "";
  for (let i = 1; i <= template.variableCount; i++) {
    const field = varsMap[String(i)];
    const label = field ? (CUSTOMER_FIELD_OPTIONS.find((o) => o.v === field)?.l ?? field) : null;
    text = text.replace(new RegExp(`\\{\\{\\s*${i}\\s*\\}\\}`, "g"), label ? `«${label}»` : `{{${i}}}`);
  }
  return text;
}

function TemplatePicker({
  templates,
  isLoading,
  isError,
  selectedId,
  onSelect,
  varsMap,
  onVarsMapChange,
}: {
  templates: WaTemplateRow[];
  isLoading: boolean;
  isError: boolean;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  varsMap: Record<string, string>;
  onVarsMapChange: (m: Record<string, string>) => void;
}) {
  const selected = templates.find((t) => Number(t.id) === selectedId) ?? null;
  const preview = buildPreviewText(selected, varsMap);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <LayoutTemplate aria-hidden className="size-4" /> القالب
        </CardTitle>
        <CardDescription>قوالب تسويقية (Marketing) معتمَدة عند Meta فقط — الوسيلة الوحيدة للإرسال الجماعي خارج نافذة الردّ الحرّ.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <p className="text-xs text-muted-foreground">جارٍ تحميل القوالب…</p>}
        {isError && <p className="text-xs text-destructive">تعذّر تحميل القوالب.</p>}
        {!isLoading && !isError && templates.length === 0 && (
          <p className="text-xs text-muted-foreground">لا قوالب تسويقية معتمَدة بعد — زامِنها من إعدادات مركز واتساب.</p>
        )}
        {!isLoading && templates.length > 0 && (
          <select
            className={`${selectCls} w-full`}
            value={selectedId ?? ""}
            onChange={(e) => { onSelect(e.target.value ? Number(e.target.value) : null); onVarsMapChange({}); }}
          >
            <option value="">اختر قالباً…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.language})</option>
            ))}
          </select>
        )}
        {selected && selected.variableCount > 0 && (
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">ربط متغيّرات القالب بحقول العميل</label>
            <div className="grid sm:grid-cols-2 gap-2">
              {Array.from({ length: selected.variableCount }, (_, i) => i + 1).map((i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted-foreground w-10 shrink-0">{`{{${i}}}`}</span>
                  <select
                    className={`${selectCls} flex-1`}
                    value={varsMap[String(i)] ?? ""}
                    onChange={(e) => onVarsMapChange({ ...varsMap, [String(i)]: e.target.value })}
                  >
                    {CUSTOMER_FIELD_OPTIONS.map((o) => (
                      <option key={o.v} value={o.v}>{o.l}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}
        {selected && (
          <div className="rounded-md border bg-background p-2.5 text-xs whitespace-pre-wrap">
            {preview || "—"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ═══════════ حملة جديدة ═══════════ */

function NewBroadcastDialog({
  isAdmin,
  branches,
  onClose,
  onCreated,
}: {
  isAdmin: boolean;
  branches: { id: number; name: string }[];
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [crmCampaignId, setCrmCampaignId] = useState("");
  const [segment, setSegment] = useState<SegmentFormState>(EMPTY_SEGMENT_FORM);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [varsMap, setVarsMap] = useState<Record<string, string>>({});
  const [scheduledAt, setScheduledAt] = useState("");
  const [throttle, setThrottle] = useState("10");

  const campaignsQ = trpc.crm.campaigns.list.useQuery();
  const templatesQ = trpc.integrations.templates.list.useQuery({ category: "MARKETING", statusFilter: "APPROVED" });
  const templates = templatesQ.data ?? [];
  const selectedTemplate = templates.find((t) => Number(t.id) === templateId) ?? null;

  const criteria = useMemo(() => buildSegmentCriteria(segment, isAdmin), [segment, isAdmin]);

  const create = trpc.broadcasts.create.useMutation({
    onSuccess: async (res) => {
      notify.ok("حُفظت الحملة كمسودة", `الجمهور المقدَّر: ${fmtCount(res.audienceCount)} — الكلفة: ${formatIqd(res.costEstimate)}`);
      await utils.broadcasts.list.invalidate();
      onCreated(res.broadcastId);
    },
    onError: (e) => notify.err(e),
  });

  const unmappedCount = selectedTemplate
    ? Array.from({ length: selectedTemplate.variableCount }, (_, i) => i + 1).filter((i) => !varsMap[String(i)]).length
    : 0;

  const canSubmit = name.trim().length >= 2 && templateId != null && !create.isPending;

  function submit() {
    if (!templateId) return;
    const varsMapClean: Record<string, string> = {};
    if (selectedTemplate) {
      for (let i = 1; i <= selectedTemplate.variableCount; i++) {
        const f = varsMap[String(i)];
        if (f) varsMapClean[String(i)] = f;
      }
    }
    create.mutate({
      name: name.trim(),
      branchId: isAdmin && segment.branchId ? Number(segment.branchId) : undefined,
      crmCampaignId: crmCampaignId ? Number(crmCampaignId) : undefined,
      templateId,
      varsMapJson: Object.keys(varsMapClean).length ? varsMapClean : undefined,
      segment: criteria,
      throttlePerMinute: throttle.trim() ? Number(throttle) : undefined,
      scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>حملة بث واتساب جديدة</DialogTitle>
          <DialogDescription>
            تُحفَظ كمسودة أولاً — الإطلاق خطوة منفصلة قد تتطلّب اعتماد مديرٍ آخر فوق عتبة حجم الجمهور (فصل المهام).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">اسم الحملة<span className="text-destructive"> *</span></label>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="مثال: عرض القرطاسية — بداية العام الدراسي" autoFocus />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">ربط بحملة CRM (اختياري — للعزو)</label>
              <select className={`${selectCls} w-full`} value={crmCampaignId} onChange={(e) => setCrmCampaignId(e.target.value)}>
                <option value="">بلا ربط</option>
                {(campaignsQ.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>

          <SegmentBuilder value={segment} onChange={setSegment} isAdmin={isAdmin} branches={branches} />
          <LivePreviewCard criteria={criteria} />
          <TemplatePicker
            templates={templates}
            isLoading={templatesQ.isLoading}
            isError={templatesQ.isError}
            selectedId={templateId}
            onSelect={setTemplateId}
            varsMap={varsMap}
            onVarsMapChange={setVarsMap}
          />
          {selectedTemplate && unmappedCount > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
              <Info aria-hidden className="size-3.5" /> {unmappedCount} متغيّر بلا ربط — سيُرسَل فارغاً.
            </p>
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground flex items-center gap-1.5"><Calendar aria-hidden className="size-3.5" /> الجدولة (اختياري)</label>
              <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground flex items-center gap-1.5"><Gauge aria-hidden className="size-3.5" /> سرعة الإرسال (رسالة/دقيقة)</label>
              <Input type="number" min={1} max={120} inputMode="numeric" value={throttle} onChange={(e) => setThrottle(e.target.value)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {create.isPending ? "جارٍ الحفظ…" : "حفظ كمسودة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════ طابور الاعتماد ═══════════ */

function ApprovalQueueCard({
  rows,
  myId,
  canManage,
  onOpen,
}: {
  rows: BroadcastRow[];
  myId: number | undefined;
  canManage: boolean;
  onOpen: (id: number) => void;
}) {
  const utils = trpc.useUtils();
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const approve = trpc.broadcasts.approve.useMutation({
    onSuccess: async (res) => {
      notify.ok("اعتُمدت الحملة وبدأ التشغيل", `${fmtCount(res.audienceCount)} مستلم`);
      setApprovingId(null);
      await Promise.all([utils.broadcasts.list.invalidate(), utils.broadcasts.get.invalidate(), utils.broadcasts.results.invalidate()]);
    },
    onError: (e) => { notify.err(e); setApprovingId(null); },
  });

  const pending = rows.filter((r) => r.broadcastStatus === "PENDING_APPROVAL");
  if (!canManage || pending.length === 0) return null;

  return (
    <Card className="border-amber-300/70 dark:border-amber-800/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
          <ShieldAlert aria-hidden className="size-4" /> بانتظار الاعتماد ({pending.length})
        </CardTitle>
        <CardDescription>فوق عتبة حجم الجمهور — يلزم اعتماد مديرٍ آخر غير منشئ الحملة (فصل المهام، بلا استثناء).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {pending.map((r) => {
          const isSelf = myId != null && r.createdBy === myId;
          return (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-2.5">
              <div className="min-w-0">
                <div className="font-medium truncate">{r.name}</div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  {fmtCount(r.audienceCount)} مستلم — {formatIqd(r.costEstimate)}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button variant="ghost" size="sm" onClick={() => onOpen(r.id)}>تفاصيل</Button>
                <Button
                  size="sm"
                  disabled={isSelf || (approve.isPending && approvingId === r.id)}
                  title={isSelf ? "لا يجوز اعتماد بثٍّ أنشأتَه بنفسك (فصل المهام)" : undefined}
                  onClick={() => { setApprovingId(r.id); approve.mutate({ broadcastId: r.id }); }}
                >
                  <CheckCircle2 aria-hidden className="size-3.5" />
                  {approve.isPending && approvingId === r.id ? "جارٍ…" : "اعتماد وإطلاق"}
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/* ═══════════ تفاصيل الحملة ═══════════ */

function ResultsSection({ broadcastId }: { broadcastId: number }) {
  const resultsQ = trpc.broadcasts.results.useQuery({ broadcastId });
  return (
    <div className="border-t pt-3 space-y-2">
      <h4 className="text-sm font-bold flex items-center gap-1.5">
        <BarChart3 aria-hidden className="size-4" /> نتائج الإرسال
      </h4>
      {resultsQ.isLoading && <LoadingState className="p-4" />}
      {resultsQ.isError && <ErrorState message="تعذّر تحميل نتائج الإرسال." onRetry={() => resultsQ.refetch()} className="p-4" />}
      {resultsQ.data && resultsQ.data.totalRecipients === 0 && (
        <p className="text-xs text-muted-foreground">لم يبدأ التقطير بعد — لا نتائج متاحة حتى الآن.</p>
      )}
      {resultsQ.data && resultsQ.data.totalRecipients > 0 && (
        <div className="space-y-1.5">
          {Object.entries(resultsQ.data.counts).map(([status, count]) => {
            const m = RECIPIENT_STATUS_META[status] ?? { label: status, variant: "neutral" as const };
            const pct = resultsQ.data.percentages[status] ?? "0.00";
            return (
              <div key={status} className="flex items-center gap-2 text-xs">
                <Badge variant={m.variant} className="w-32 justify-center shrink-0">{m.label}</Badge>
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${Math.min(100, Number(pct))}%` }} />
                </div>
                <span className="tabular-nums w-28 text-end shrink-0">{fmtCount(count)} ({pct}٪)</span>
              </div>
            );
          })}
          <p className="text-[11px] text-muted-foreground pt-1">
            الإجمالي: {fmtCount(resultsQ.data.totalRecipients)} من أصل {fmtCount(resultsQ.data.audienceCount)} بالجمهور المستهدَف وقت آخر حساب.
          </p>
        </div>
      )}
    </div>
  );
}

function BroadcastDetailDialog({
  broadcastId,
  myId,
  canManage,
  templatesMap,
  branchesMap,
  usersMap,
  onClose,
}: {
  broadcastId: number;
  myId: number | undefined;
  canManage: boolean;
  templatesMap: Map<number, string>;
  branchesMap: Map<number, string>;
  usersMap: Map<number, string>;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const detailQ = trpc.broadcasts.get.useQuery({ broadcastId });

  const invalidateAll = async () => {
    await Promise.all([
      utils.broadcasts.list.invalidate(),
      utils.broadcasts.get.invalidate({ broadcastId }),
      utils.broadcasts.results.invalidate({ broadcastId }),
    ]);
  };

  const launch = trpc.broadcasts.launch.useMutation({
    onSuccess: (r) => {
      notify.ok(
        r.status === "PENDING_APPROVAL" ? "أُرسلت للاعتماد" : "أُطلقت الحملة",
        r.status === "PENDING_APPROVAL"
          ? "الجمهور يتجاوز العتبة — بانتظار اعتماد مديرٍ آخر."
          : `قيد التشغيل الآن — ${fmtCount(r.audienceCount)} مستلم.`,
      );
      void invalidateAll();
    },
    onError: (e) => notify.err(e),
  });
  const approve = trpc.broadcasts.approve.useMutation({
    onSuccess: (r) => { notify.ok("اعتُمدت الحملة وبدأ التشغيل", `${fmtCount(r.audienceCount)} مستلم`); void invalidateAll(); },
    onError: (e) => notify.err(e),
  });
  const [showPause, setShowPause] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  const pause = trpc.broadcasts.pause.useMutation({
    onSuccess: () => { notify.ok("أُوقفت الحملة مؤقتاً"); setShowPause(false); setPauseReason(""); void invalidateAll(); },
    onError: (e) => notify.err(e),
  });
  const resume = trpc.broadcasts.resume.useMutation({
    onSuccess: () => { notify.ok("استُؤنفت الحملة"); void invalidateAll(); },
    onError: (e) => notify.err(e),
  });
  const cancel = trpc.broadcasts.cancel.useMutation({
    onSuccess: () => { notify.ok("أُلغيت الحملة"); void invalidateAll(); },
    onError: (e) => notify.err(e),
  });

  if (detailQ.isLoading) {
    return (
      <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>تفاصيل الحملة</DialogTitle></DialogHeader>
          <LoadingState />
        </DialogContent>
      </Dialog>
    );
  }
  if (detailQ.isError || !detailQ.data) {
    return (
      <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>تفاصيل الحملة</DialogTitle></DialogHeader>
          <ErrorState message="تعذّر تحميل تفاصيل الحملة." onRetry={() => detailQ.refetch()} />
        </DialogContent>
      </Dialog>
    );
  }

  const d: BroadcastDetailData = detailQ.data;
  const isSelfCreator = myId != null && d.createdBy === myId;
  const nameOf = (uid: number | null) => (uid == null ? "—" : usersMap.get(uid) ?? (myId === uid ? "أنت" : `مستخدم #${uid}`));

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            {d.name} <StatusBadge status={d.broadcastStatus} />
          </DialogTitle>
          {d.pausedReason && <DialogDescription>سبب الإيقاف: {d.pausedReason}</DialogDescription>}
        </DialogHeader>

        <div className="grid sm:grid-cols-2 gap-2 text-sm">
          <InfoRow label="الجمهور" value={fmtCount(d.audienceCount)} />
          <InfoRow label="الكلفة التقديرية" value={formatIqd(d.costEstimate)} />
          <InfoRow label="القالب" value={templatesMap.get(d.templateId) ?? `قالب #${d.templateId}`} />
          <InfoRow label="الفرع" value={d.branchId == null ? "كل الفروع" : branchesMap.get(d.branchId) ?? `فرع #${d.branchId}`} />
          <InfoRow label="أنشأها" value={nameOf(d.createdBy)} />
          <InfoRow label="أُنشئت" value={fmtDateTime(d.createdAt)} />
          {d.approvedBy != null && <InfoRow label="اعتمدها" value={nameOf(d.approvedBy)} />}
          {d.scheduledAt && <InfoRow label="مجدولة لـ" value={fmtDateTime(d.scheduledAt)} />}
          {d.startedAt && <InfoRow label="بدأت" value={fmtDateTime(d.startedAt)} />}
          {d.completedAt && <InfoRow label="اكتملت" value={fmtDateTime(d.completedAt)} />}
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            {(d.broadcastStatus === "DRAFT" || d.broadcastStatus === "APPROVED") && (
              <Button size="sm" disabled={launch.isPending} onClick={() => launch.mutate({ broadcastId })}>
                <Play aria-hidden className="size-3.5" /> {launch.isPending ? "جارٍ…" : "إطلاق"}
              </Button>
            )}
            {d.broadcastStatus === "PENDING_APPROVAL" && (
              <Button
                size="sm"
                disabled={approve.isPending || isSelfCreator}
                title={isSelfCreator ? "لا يجوز اعتماد بثٍّ أنشأتَه بنفسك (فصل المهام)" : undefined}
                onClick={() => approve.mutate({ broadcastId })}
              >
                <CheckCircle2 aria-hidden className="size-3.5" /> {approve.isPending ? "جارٍ…" : "اعتماد وإطلاق"}
              </Button>
            )}
            {d.broadcastStatus === "RUNNING" && (
              <Button size="sm" variant="outline" onClick={() => setShowPause(true)}>
                <Pause aria-hidden className="size-3.5" /> إيقاف مؤقت
              </Button>
            )}
            {d.broadcastStatus === "PAUSED" && (
              <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate({ broadcastId })}>
                <RotateCcw aria-hidden className="size-3.5" /> {resume.isPending ? "جارٍ…" : "استئناف"}
              </Button>
            )}
            {CANCELLABLE_STATUSES.has(d.broadcastStatus) && (
              <Button
                size="sm"
                variant="destructive"
                disabled={cancel.isPending}
                onClick={() => {
                  if (window.confirm("إلغاء هذه الحملة نهائياً؟ لا يمكن التراجع.")) cancel.mutate({ broadcastId });
                }}
              >
                <XCircle aria-hidden className="size-3.5" /> إلغاء
              </Button>
            )}
          </div>
        )}

        {isSelfCreator && d.broadcastStatus === "PENDING_APPROVAL" && (
          <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
            <ShieldAlert aria-hidden className="size-3.5" /> أنت منشئ هذه الحملة — يلزم اعتمادها من مديرٍ آخر (فصل المهام، بلا استثناء).
          </p>
        )}

        {showPause && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <label className="text-xs text-muted-foreground">سبب الإيقاف المؤقت<span className="text-destructive"> *</span></label>
            <Input value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} placeholder="مثال: مراجعة محتوى القالب…" maxLength={200} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setShowPause(false); setPauseReason(""); }}>تراجع</Button>
              <Button
                size="sm"
                disabled={pauseReason.trim().length < 1 || pause.isPending}
                onClick={() => pause.mutate({ broadcastId, reason: pauseReason.trim() })}
              >
                {pause.isPending ? "جارٍ…" : "تأكيد الإيقاف"}
              </Button>
            </div>
          </div>
        )}

        <ResultsSection broadcastId={broadcastId} />

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════ الصفحة ═══════════ */

export default function WaBroadcasts() {
  const me = trpc.auth.me.useQuery();
  const role = (me.data?.role ?? "") as RoleKey;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const isAdmin = role === "admin";
  const canManage = !!role && moduleAccessAllowed(role, override, "campaigns", "FULL", ["manager"]);
  const myId = me.data?.id != null ? Number(me.data.id) : undefined;

  const list = trpc.broadcasts.list.useQuery();
  const branches = trpc.branches.list.useQuery();
  const canReadTemplates = role === "admin" || role === "manager";
  const templatesAll = trpc.integrations.templates.list.useQuery(undefined, { enabled: canReadTemplates });
  const usersAll = trpc.users.list.useQuery({ limit: 500, includeInactive: true }, { enabled: isAdmin });

  const branchesMap = useMemo(() => new Map((branches.data ?? []).map((b) => [b.id, b.name])), [branches.data]);
  const templatesMap = useMemo(() => new Map((templatesAll.data ?? []).map((t) => [Number(t.id), t.name])), [templatesAll.data]);
  const usersMap = useMemo(
    () => new Map((usersAll.data?.rows ?? []).map((u) => [Number(u.id), u.name ?? `مستخدم #${u.id}`])),
    [usersAll.data],
  );

  const [statusFilter, setStatusFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const rows = useMemo(
    () => (list.data ?? []).filter((r) => !statusFilter || r.broadcastStatus === statusFilter),
    [list.data, statusFilter],
  );

  const columns: ColumnDef<BroadcastRow>[] = useMemo(
    () => [
      { header: "الاسم", accessorKey: "name", cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
      { header: "الحالة", accessorKey: "broadcastStatus", cell: ({ row }) => <StatusBadge status={row.original.broadcastStatus} /> },
      {
        header: "القالب",
        accessorKey: "templateId",
        cell: ({ row }) => <span className="text-xs">{templatesMap.get(row.original.templateId) ?? `#${row.original.templateId}`}</span>,
      },
      {
        header: "الجمهور",
        accessorKey: "audienceCount",
        cell: ({ row }) => <span className="tabular-nums" dir="ltr">{fmtCount(row.original.audienceCount)}</span>,
      },
      {
        header: "الكلفة التقديرية",
        accessorKey: "costEstimate",
        cell: ({ row }) => <span className="tabular-nums" dir="ltr">{formatIqd(row.original.costEstimate)}</span>,
      },
      {
        header: "منشئها",
        accessorKey: "createdBy",
        cell: ({ row }) => {
          const uid = row.original.createdBy;
          return <span className="text-xs">{uid == null ? "—" : usersMap.get(uid) ?? (myId === uid ? "أنت" : `#${uid}`)}</span>;
        },
      },
      {
        header: "التاريخ",
        accessorKey: "createdAt",
        cell: ({ row }) => <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(row.original.createdAt)}</span>,
      },
      {
        header: "تفاصيل",
        id: "actions",
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => setDetailId(row.original.id)}>عرض</Button>
        ),
      },
    ],
    [templatesMap, usersMap, myId],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="بث واتساب التسويقي"
        description="ابنِ شريحة جمهور (نوع عميل/فئة سعر/RFM)، اختر قالباً معتمَداً، واحسب الكلفة قبل الإطلاق — الإرسال الفعلي للموافقين على التسويق فقط."
        actions={canManage ? <Button onClick={() => setShowNew(true)}><Plus aria-hidden className="size-4" /> حملة جديدة</Button> : undefined}
      />

      <ApprovalQueueCard rows={list.data ?? []} myId={myId} canManage={canManage} onOpen={setDetailId} />

      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-2">
          <select className={selectCls} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">كل الحالات</option>
            {Object.entries(BROADCAST_STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
          <Button variant="outline" size="sm" onClick={() => list.refetch()} className="gap-1.5">
            <RotateCcw aria-hidden className="size-3.5" /> تحديث
          </Button>
        </CardContent>
      </Card>

      {list.isLoading && <LoadingState />}
      {list.isError && <ErrorState message="تعذّر تحميل الحملات." onRetry={() => list.refetch()} />}
      {!list.isLoading && !list.isError && (
        <DataTable data={rows} columns={columns} emptyText="لا حملات بثّ بعد." filterPlaceholder="ابحث بالاسم…" pageSize={20} />
      )}

      {showNew && (
        <NewBroadcastDialog
          isAdmin={isAdmin}
          branches={branches.data ?? []}
          onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); setDetailId(id); }}
        />
      )}

      {detailId != null && (
        <BroadcastDetailDialog
          broadcastId={detailId}
          myId={myId}
          canManage={canManage}
          templatesMap={templatesMap}
          branchesMap={branchesMap}
          usersMap={usersMap}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  );
}
