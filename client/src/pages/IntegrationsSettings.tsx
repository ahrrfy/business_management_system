import { Badge } from "@/components/ui/badge";
import { FILTER_LABELS } from "@shared/uiContracts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppSelect } from "@/components/ui/AppSelect";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, AlertCircle, AlertTriangle, Cable, CheckCircle2, ChevronDown, Clock, Copy, Eye, EyeOff, KeyRound, LayoutTemplate, Loader2, Plus, Power, RefreshCw, RotateCcw, Save, Scissors, Search, Settings2, ShoppingBag, Trash2, User, Wand2, MessageSquare } from "lucide-react";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  filterIntegrations,
  summarizeIntegrations,
  type IntegrationChannelFilter,
  type IntegrationConnectionChannel,
  type IntegrationConnectionStatus,
  type IntegrationStatusFilter,
} from "@/lib/integrationCenter";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { Switch } from "@/components/ui/switch";
import { useEffect, useMemo, useState } from "react";

/**
 * مركز التكاملات — `/settings/integrations`.
 *
 * يجمع اتصالات القنوات، وأتمتة واتساب، وخدمات محتوى المنتجات في أقسام واضحة:
 *   - بطاقة تشغيلية لكل (فرع × قناة).
 *   - حقول secrets مقنّعة (•••abcd) مع زر «أظهر/أخف».
 *   - زر «تحقّق» يختبر Meta أو سلامة secret لقناة المتجر المخصّصة.
 *   - زر «انسخ webhook URL» للصق لدى مزوّد القناة.
 *   - قناة المتجر Webhook موقّع فقط، بلا مزامنة للمنتجات أو المخزون.
 *   - تعطيل/تفعيل/حذف بلا فقد audit history.
 *
 * RBAC: adminProcedure فقط (محمي في App.tsx بـRequireRole + في tRPC).
 * المتطلّب الوحيد: INTEGRATIONS_ENCRYPTION_KEY في .env (يتحقّق بـcryptoReady).
 */

type Integration = RouterOutputs["integrations"]["list"][number];

const CHANNEL_META: Record<IntegrationConnectionChannel, { label: string; Icon: typeof MessageSquare; cls: string }> = {
  WHATSAPP: { label: "واتساب", Icon: MessageSquare, cls: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)]/30" },
  INSTAGRAM: { label: "انستغرام", Icon: User, cls: "bg-pink-500/10 text-pink-700 dark:text-pink-400 border-pink-500/30" },
  STORE: { label: "Webhook متجر مخصص", Icon: ShoppingBag, cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30" },
};

const STATUS_META: Record<IntegrationConnectionStatus, { label: string; cls: string }> = {
  PENDING: { label: "بانتظار التحقّق", cls: "badge-status-pending" },
  ACTIVE: { label: "فعّال", cls: "badge-status-active" },
  FAILED: { label: "فشل", cls: "badge-stock-out" },
  DISABLED: { label: "معطّل", cls: "badge-status-cancelled" },
};

type CenterSection = "connections" | "whatsapp" | "content";

function CenterMetric({
  label,
  value,
  icon: Icon,
  iconClassName,
}: {
  label: string;
  value: number;
  icon: typeof Activity;
  iconClassName: string;
}) {
  return (
    <div className="flex min-h-24 items-center justify-between rounded-lg border bg-card p-4">
      <div>
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      </div>
      <div className="grid size-10 place-items-center rounded-lg border bg-muted/30">
        <Icon aria-hidden className={`size-5 ${iconClassName}`} />
      </div>
    </div>
  );
}

/** حقل secret: قناع •••• افتراضي + زر إظهار + إدخال نصّ جديد (يستبدل القديم). */
function SecretField({
  label,
  hint,
  masked,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  masked: string | null;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      <div className="flex gap-2">
        <div className="relative flex-1" dir="ltr">
          <input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={masked ? `الحالي: ${masked}` : (placeholder ?? "الصق القيمة الجديدة")}
            dir="ltr"
            aria-label={label}
            className="w-full h-9 px-3 pe-9 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute end-1 top-1/2 -translate-y-1/2 size-7 grid place-items-center text-muted-foreground hover:text-foreground"
            title={show ? "إخفاء" : "إظهار"}
            aria-label={show ? `إخفاء ${label}` : `إظهار ${label}`}
          >
            {show ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

interface DraftState {
  displayName: string;
  phoneNumberId: string;
  wabaId: string;
  verifyToken: string;
  appSecret: string;
  accessToken: string;
}

type PublicDraftField = "displayName" | "phoneNumberId" | "wabaId";
const CLEAN_PUBLIC_DRAFT: Record<PublicDraftField, boolean> = {
  displayName: false,
  phoneNumberId: false,
  wabaId: false,
};

function IntegrationCard({ integ, onChanged, wide = false }: { integ: Integration; onChanged: () => void; wide?: boolean }) {
  const ch = CHANNEL_META[integ.channel as IntegrationConnectionChannel];
  const st = STATUS_META[integ.status] ?? STATUS_META.PENDING;
  const [draft, setDraft] = useState<DraftState>({
    displayName: integ.displayName ?? "",
    phoneNumberId: integ.phoneNumberId ?? "",
    wabaId: integ.wabaId ?? "",
    verifyToken: "",
    appSecret: "",
    accessToken: "",
  });
  const [publicDirty, setPublicDirty] = useState(CLEAN_PUBLIC_DRAFT);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setDraft((current) => ({
      ...current,
      displayName: publicDirty.displayName ? current.displayName : (integ.displayName ?? ""),
      phoneNumberId: publicDirty.phoneNumberId ? current.phoneNumberId : (integ.phoneNumberId ?? ""),
      wabaId: publicDirty.wabaId ? current.wabaId : (integ.wabaId ?? ""),
    }));
  }, [integ.displayName, integ.phoneNumberId, integ.wabaId, publicDirty]);

  const utils = trpc.useUtils();
  const upsert = trpc.integrations.upsert.useMutation({
    onSuccess: () => {
      notify.ok("تم الحفظ", "الـtokens مشفّرة في DB. اضغط «تحقّق» لاختبار الاتصال.");
      setPublicDirty(CLEAN_PUBLIC_DRAFT);
      utils.integrations.list.invalidate();
      onChanged();
    },
    onError: (e) => notify.err(e),
  });
  const verify = trpc.integrations.verify.useMutation({
    onSuccess: (r) => {
      const successTitle = integ.channel === "STORE" ? "الإعداد صالح" : "متّصل";
      (r.ok ? notify.ok : notify.warn)(r.ok ? successTitle : "فشل التحقّق", r.message);
      utils.integrations.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const disable = trpc.integrations.disable.useMutation({
    onSuccess: () => { notify.ok("تم التعطيل"); utils.integrations.list.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const enable = trpc.integrations.enable.useMutation({
    onSuccess: () => { notify.ok("تم التفعيل"); utils.integrations.list.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const del = trpc.integrations.delete.useMutation({
    onSuccess: () => { notify.ok("تم الحذف"); utils.integrations.list.invalidate(); onChanged(); },
    onError: (e) => notify.err(e),
  });

  const save = () => {
    upsert.mutate({
      branchId: integ.branchId,
      channel: integ.channel as IntegrationConnectionChannel,
      displayName: publicDirty.displayName ? (draft.displayName.trim() || null) : undefined,
      phoneNumberId: publicDirty.phoneNumberId ? (draft.phoneNumberId.trim() || null) : undefined,
      wabaId: publicDirty.wabaId ? (draft.wabaId.trim() || null) : undefined,
      // فقط الحقول التي كتب فيها نصّ جديد ⇒ undefined لبقاء القديم.
      verifyToken: draft.verifyToken ? draft.verifyToken : undefined,
      appSecret: draft.appSecret ? draft.appSecret : undefined,
      accessToken: draft.accessToken ? draft.accessToken : undefined,
    });
    setDraft((d) => ({ ...d, verifyToken: "", appSecret: "", accessToken: "" })); // امسح النصّ بعد الحفظ.
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(integ.webhookUrl);
      notify.ok("تم النسخ", "نُسخ عنوان webhook إلى الحافظة.");
    } catch {
      notify.err("تعذّر النسخ إلى الحافظة. حدّد العنوان وانسخه يدوياً.");
    }
  };
  const hasDraftChanges = Object.values(publicDirty).some(Boolean)
    || Boolean(draft.verifyToken || draft.appSecret || draft.accessToken);

  return (
    <Card className={`gap-0 overflow-hidden py-0 shadow-none ${open || wide ? "xl:col-span-2" : ""}`}>
      <CardHeader className="p-4 pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`size-10 rounded-lg grid place-items-center flex-shrink-0 border ${ch.cls}`}>
              <ch.Icon aria-hidden className="size-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base"><h3>{ch.label}</h3></CardTitle>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {integ.branchName ?? `فرع #${integ.branchId}`}{integ.displayName ? ` — ${integ.displayName}` : ""}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={st.cls}>{st.label}</Badge>
            {integ.lastVerifiedAt && (
              <span className="text-xs text-muted-foreground">
                آخر تحقّق: <span dir="ltr">{fmtDateTime(integ.lastVerifiedAt)}</span>
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4">
        {integ.lastError && integ.status === "FAILED" && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs flex items-start gap-2">
            <AlertCircle aria-hidden className="size-4 text-destructive flex-shrink-0 mt-0.5" />
            <div className="text-destructive break-words">{integ.lastError}</div>
          </div>
        )}

        {/* الحقول الـsecret — مطوية لتقليل الازدحام البصري */}
        <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="inline-flex min-h-9 cursor-pointer select-none items-center gap-1.5 text-sm font-medium text-primary">
            <ChevronDown aria-hidden className={`size-4 transition-transform ${open ? "rotate-0" : "-rotate-90"}`} />
            إدارة الاتصال
          </summary>
          <div className="space-y-3 mt-3 pt-3 border-t">
            <div className="rounded-md border bg-muted/30 p-2.5 space-y-1.5">
              <div className="text-xs text-muted-foreground">عنوان webhook المسجّل لدى المزوّد</div>
              <div className="flex gap-2 items-center">
                <code className="flex-1 truncate rounded border bg-background px-2 py-1 text-xs" dir="ltr">{integ.webhookUrl}</code>
                <Button size="sm" variant="outline" onClick={copyUrl}>
                  <Copy aria-hidden className="size-3.5 me-1" /> نسخ
                </Button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2 items-start">
              <div className="space-y-1">
                <label className="text-xs font-medium">اسم العرض (اختياري)</label>
                <input
                  type="text"
                  value={draft.displayName}
                  onChange={(e) => {
                    setDraft({ ...draft, displayName: e.target.value });
                    setPublicDirty((current) => ({ ...current, displayName: true }));
                  }}
                  placeholder={`${ch.label} — ${integ.branchName ?? ""}`}
                  className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              {integ.channel === "WHATSAPP" && (
                <div className="space-y-1">
                  <label className="text-xs font-medium">Phone Number ID</label>
                  <div className="text-[11px] text-muted-foreground">من WhatsApp Manager → Phone numbers → API setup</div>
                  <input
                    type="text"
                    value={draft.phoneNumberId}
                    onChange={(e) => {
                      setDraft({ ...draft, phoneNumberId: e.target.value });
                      setPublicDirty((current) => ({ ...current, phoneNumberId: true }));
                    }}
                    placeholder="مثلاً: 123456789012345"
                    dir="ltr"
                    className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              )}
              {integ.channel === "WHATSAPP" && (
                <div className="space-y-1">
                  <label className="text-xs font-medium">WABA ID (حساب واتساب الأعمال)</label>
                  <div className="text-[11px] text-muted-foreground">من WhatsApp Manager → Overview — مطلوب لمزامنة القوالب من مركز واتساب.</div>
                  <input
                    type="text"
                    value={draft.wabaId}
                    onChange={(e) => {
                      setDraft({ ...draft, wabaId: e.target.value });
                      setPublicDirty((current) => ({ ...current, wabaId: true }));
                    }}
                    placeholder="مثلاً: 987654321098765"
                    dir="ltr"
                    className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              )}
              <SecretField
                label="Verify Token"
                hint="كلمة سرّية تختارها أنت — الصقها في Meta عند تسجيل webhook."
                masked={integ.verifyTokenMasked}
                value={draft.verifyToken}
                onChange={(v) => setDraft({ ...draft, verifyToken: v })}
              />
              <SecretField
                label="App Secret"
                hint={integ.channel === "STORE" ? "Webhook secret من منصّة المتجر." : "App Secret من Meta → App Dashboard → Settings → Basic."}
                masked={integ.appSecretMasked}
                value={draft.appSecret}
                onChange={(v) => setDraft({ ...draft, appSecret: v })}
              />
              {integ.channel !== "STORE" && (
                <SecretField
                  label="Access Token (System User)"
                  hint="من Meta → Business Settings → System Users → Generate New Token (مع صلاحية whatsapp_business_messaging)."
                  masked={integ.accessTokenMasked}
                  value={draft.accessToken}
                  onChange={(v) => setDraft({ ...draft, accessToken: v })}
                />
              )}
            </div>

            <div className="flex gap-2 flex-wrap pt-2">
              <Button onClick={save} disabled={upsert.isPending || !hasDraftChanges}>
                {upsert.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : null}
                حفظ
              </Button>
              <Button
                variant="outline"
                onClick={() => verify.mutate({ integrationId: integ.id })}
                disabled={verify.isPending || integ.status === "DISABLED"}
              >
                {verify.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4 me-1" />}
                تحقّق من الاتصال
              </Button>
              {integ.status === "DISABLED" ? (
                <Button variant="outline" onClick={() => enable.mutate({ integrationId: integ.id })} disabled={enable.isPending}>
                  تفعيل
                </Button>
              ) : (
                <Button variant="outline" onClick={() => disable.mutate({ integrationId: integ.id })} disabled={disable.isPending}>
                  تعطيل
                </Button>
              )}
              <Button
                variant="ghost"
                className="text-destructive hover:bg-destructive/10"
                onClick={async () => {
                  if (!(await confirm({
                    variant: "danger",
                    title: "حذف التكامل",
                    description: `حذف تكامل ${ch.label} لفرع ${integ.branchName ?? integ.branchId} نهائياً — كل secrets تفقد. اكتب «حذف» للتأكيد.`,
                    confirmText: "حذف",
                    cancelText: "تراجع",
                    requireText: "حذف",
                  }))) return;
                  del.mutate({ integrationId: integ.id });
                }}
                disabled={del.isPending}
              >
                <Trash2 aria-hidden className="size-4 me-1" /> حذف
              </Button>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function NewIntegrationDialog({ onCreated, onClose, branches }: {
  onCreated: () => void;
  onClose: () => void;
  branches: { id: number; name: string }[];
}) {
  const [branchId, setBranchId] = useState<number>(branches[0]?.id ?? 0);
  const [channel, setChannel] = useState<IntegrationConnectionChannel>("WHATSAPP");
  const upsert = trpc.integrations.upsert.useMutation({
    onSuccess: () => { onCreated(); onClose(); },
    onError: (e) => notify.err(e),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>إضافة قناة اتصال</DialogTitle>
          <DialogDescription>اختر الفرع والقناة، ثم أكمل الاعتمادات واختبر الإعداد بعد الإضافة.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 items-start">
            <div>
              <label className="text-xs text-muted-foreground">الفرع</label>
              <AppSelect
                value={String(branchId || "")}
                onValueChange={(value) => setBranchId(Number(value))}
                className="mt-1"
                aria-label="الفرع"
              >
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </AppSelect>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">القناة</label>
              <AppSelect
                value={channel}
                onValueChange={(value) => setChannel(value as IntegrationConnectionChannel)}
                className="mt-1"
                aria-label="القناة"
              >
                <option value="WHATSAPP">{CHANNEL_META.WHATSAPP.label}</option>
                <option value="INSTAGRAM">{CHANNEL_META.INSTAGRAM.label}</option>
                <option value="STORE">{CHANNEL_META.STORE.label}</option>
              </AppSelect>
            </div>
          </div>
          <div className="text-xs text-muted-foreground rounded-md bg-muted/30 border p-2.5">
            بعد الإنشاء افتح «إدارة الاتصال» لإدخال الاعتمادات وإجراء التحقق. قناة المتجر الحالية تستقبل webhook موقّعاً فقط ولا تزامن المنتجات أو المخزون.
          </div>
        </div>
        <DialogFooter className="sm:justify-stretch">
          <Button variant="outline" onClick={onClose} className="flex-1">إلغاء</Button>
          <Button
            onClick={() => upsert.mutate({ branchId, channel })}
            disabled={upsert.isPending || !branchId}
            className="flex-1"
          >
            إضافة القناة
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * بطاقة «استوديو صور المنتجات» (remove.bg) — مسار Pro لقصّ خلفية الصور احترافياً. المفتاح مشفّر
 * (نفس INTEGRATIONS_ENCRYPTION_KEY). عند التعطيل/نفاد الرصيد يعمل المسار المجاني الآمن تلقائياً.
 * أمانة صارمة: remove.bg قصّ لا توليد (بكسلات المنتج تبقى).
 */
function ImageStudioIntegrationCard() {
  const settings = trpc.imageStudio.settings.useQuery();
  const utils = trpc.useUtils();
  const [keyDraft, setKeyDraft] = useState("");
  const update = trpc.imageStudio.updateSettings.useMutation({
    onSuccess: () => { notify.ok("تم الحفظ"); utils.imageStudio.settings.invalidate(); utils.imageStudio.proConfig.invalidate(); setKeyDraft(""); },
    onError: (e) => notify.err(e),
  });
  const verify = trpc.imageStudio.verifyConnection.useMutation({
    onSuccess: (r) => { (r.ok ? notify.ok : notify.warn)(r.ok ? "المفتاح صالح" : "فشل الفحص", r.message); utils.imageStudio.settings.invalidate(); },
    onError: (e) => notify.err(e),
  });
  if (settings.isError) {
    return <ErrorState message="تعذّر تحميل إعدادات remove.bg." onRetry={() => void settings.refetch()} />;
  }
  if (settings.isLoading || !settings.data) return <LoadingState />;
  const s = settings.data;

  return (
    <Card className="border-violet-500/30 bg-violet-500/[0.03]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-10 rounded-lg grid place-items-center flex-shrink-0 border bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/30">
              <Scissors aria-hidden className="size-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">استوديو صور المنتجات — remove.bg</CardTitle>
              <div className="text-xs text-muted-foreground mt-0.5">قصّ خلفية احترافيّ لصور المنتجات (Pro اختياريّ مدفوع)</div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={s?.proEnabled ? "badge-status-active" : "badge-status-cancelled"}>
              {s?.proEnabled ? "Pro مفعّل" : "Pro معطّل"}
            </Badge>
            {s?.lastVerifiedAt && (
              <span className="text-[10px] text-muted-foreground" dir="ltr">آخر فحص {fmtDateTime(s.lastVerifiedAt)}</span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground space-y-1">
          <p>قصّ احترافيّ للخلفية عبر remove.bg — <b>قصّ لا توليد</b> ⇒ بكسلات منتجك تبقى كما هي. مجانيّ حتى ~٥٠ صورة/شهر (دقّة معاينة منخفضة)، ثمّ مدفوع بالرصيد.</p>
          <p>المفتاح من: remove.bg ← Dashboard ← <span dir="ltr">API Keys</span>. عند التعطيل أو نفاد الرصيد يعمل المسار المجانيّ الآمن (FLATTEN) تلقائياً.</p>
        </div>

        {s?.lastError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs flex items-start gap-2">
            <AlertCircle aria-hidden className="size-4 text-destructive flex-shrink-0 mt-0.5" />
            <div className="text-destructive break-words">{s.lastError}</div>
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <SecretField
              label="مفتاح remove.bg API"
              hint="الصق مفتاحاً جديداً ليشفّر ويحفظ. اتركه فارغاً لإبقاء الحاليّ."
              masked={s?.removebgKeyMasked ?? null}
              value={keyDraft}
              onChange={setKeyDraft}
              placeholder="الصق مفتاح remove.bg"
            />
          </div>
          <Button onClick={() => update.mutate({ removebgKey: keyDraft.trim() })} disabled={update.isPending || !keyDraft.trim()}>
            {update.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : null}
            حفظ المفتاح
          </Button>
        </div>

        <div className="flex gap-2 flex-wrap pt-1">
          <Button
            variant="outline"
            onClick={() => verify.mutate()}
            disabled={verify.isPending || !s?.hasKey}
          >
            {verify.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4 me-1" />}
            فحص الاتصال والرصيد
          </Button>
          {s?.proEnabled ? (
            <Button variant="outline" onClick={() => update.mutate({ proEnabled: false })} disabled={update.isPending}>
              تعطيل Pro
            </Button>
          ) : (
            <Button variant="outline" onClick={() => update.mutate({ proEnabled: true })} disabled={update.isPending || !s?.hasKey} title={!s?.hasKey ? "أدخل المفتاح أوّلاً" : undefined}>
              تفعيل Pro
            </Button>
          )}
          {s?.hasKey && (
            <Button
              variant="ghost"
              className="text-destructive hover:bg-destructive/10"
              onClick={async () => {
                if (!(await confirm({
                  variant: "danger",
                  title: "حذف مفتاح remove.bg",
                  description: "سيحذف المفتاح ويعطّل مسار Pro. سيعمل المسار المجانيّ الآمن. متابعة؟",
                  confirmText: "حذف",
                  cancelText: "تراجع",
                }))) return;
                update.mutate({ removebgKey: null });
              }}
              disabled={update.isPending}
            >
              <Trash2 aria-hidden className="size-4 me-1" /> حذف المفتاح
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * بطاقة «استوديو الذكاء الاصطناعي» — إعادة تصميم صورة المنتج كاستوديو موحّد من برومت جاهز (Gemini/أي
 * مزوّد). المفتاح مشفّر (نفس INTEGRATIONS_ENCRYPTION_KEY). ⚠️ توليديّ (يعيد رسم البكسلات): يخضع
 * لمراجعة/اعتماد بشريّ في نموذج المنتج قبل استبدال الأصل، والأصل يبقى دائماً. معطّل افتراضياً.
 */
function AiImageStudioIntegrationCard() {
  const aiSettings = trpc.imageStudio.aiSettings.useQuery();
  const utils = trpc.useUtils();
  const [keyDraft, setKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);

  const update = trpc.imageStudio.updateAiSettings.useMutation({
    onSuccess: () => {
      notify.ok("تم الحفظ");
      utils.imageStudio.aiSettings.invalidate();
      utils.imageStudio.aiConfig.invalidate();
      setKeyDraft("");
    },
    onError: (e) => notify.err(e),
  });
  const verify = trpc.imageStudio.verifyAiConnection.useMutation({
    onSuccess: (r) => { (r.ok ? notify.ok : notify.warn)(r.ok ? "المفتاح صالح" : "فشل الفحص", r.message); utils.imageStudio.aiSettings.invalidate(); },
    onError: (e) => notify.err(e),
  });
  if (aiSettings.isError) {
    return <ErrorState message="تعذّر تحميل إعدادات خدمة الصور التوليدية." onRetry={() => void aiSettings.refetch()} />;
  }
  if (aiSettings.isLoading || !aiSettings.data) return <LoadingState />;
  const s = aiSettings.data;
  const modelValue = modelDraft ?? s?.aiModel ?? "";
  const promptValue = promptDraft ?? s?.aiStudioPrompt ?? "";

  return (
    <Card className="border-fuchsia-500/30 bg-fuchsia-500/[0.03]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-10 rounded-lg grid place-items-center flex-shrink-0 border bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-500/30">
              <Wand2 aria-hidden className="size-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">استوديو الذكاء الاصطناعي — {s?.aiProvider ?? "Gemini"}</CardTitle>
              <div className="text-xs text-muted-foreground mt-0.5">إعادة تصميم صور المنتجات كاستوديو موحّد من برومت جاهز (اختياريّ مدفوع)</div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={s?.aiEnabled ? "badge-status-active" : "badge-status-cancelled"}>
              {s?.aiEnabled ? "مفعّل" : "معطّل"}
            </Badge>
            {s?.aiLastVerifiedAt && (
              <span className="text-[10px] text-muted-foreground" dir="ltr">آخر فحص {fmtDateTime(s.aiLastVerifiedAt)}</span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground space-y-1">
          <p>يعيد تصميم صورة المنتج كتصوير استوديو موحّد (خلفية بيضاء + إضاءة + ظلّ) — <b>كأنّ كل الصور من استوديو واحد</b>. برومت جاهز محصّن يأمر بحفظ المنتج وكتابته.</p>
          <p className="flex items-start gap-1.5 text-[var(--sem-warn)] dark:text-[var(--sem-warn)]">
            <AlertTriangle aria-hidden className="size-3.5 shrink-0 mt-0.5" />
            <span>توليديّ (يعيد رسم الصورة، بخلاف remove.bg القاصّ) ⇒ قد يغيّر تفاصيل دقيقة/كتابة. لذلك النتيجة تعرض للمراجعة والاعتماد قبل استبدال الأصل، <b>والأصل يبقى دائماً</b>.</span>
          </p>
          <p>مفتاح Gemini من: <span dir="ltr">Google AI Studio ← Get API key</span>. النموذج الافتراضيّ <span dir="ltr">{s?.aiModelEffective ?? "gemini-2.5-flash-image"}</span>.</p>
        </div>

        {s?.aiLastError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs flex items-start gap-2">
            <AlertCircle aria-hidden className="size-4 text-destructive flex-shrink-0 mt-0.5" />
            <div className="text-destructive break-words">{s.aiLastError}</div>
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <SecretField
              label="مفتاح API للذكاء الاصطناعي"
              hint="الصق مفتاحاً جديداً ليشفّر ويحفظ. اتركه فارغاً لإبقاء الحاليّ."
              masked={s?.aiKeyMasked ?? null}
              value={keyDraft}
              onChange={setKeyDraft}
              placeholder="الصق مفتاح Gemini"
            />
          </div>
          <Button onClick={() => update.mutate({ aiKey: keyDraft.trim() })} disabled={update.isPending || !keyDraft.trim()}>
            {update.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : null}
            حفظ المفتاح
          </Button>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium">النموذج (اختياري)</label>
            <div className="text-[11px] text-muted-foreground">اتركه فارغاً للافتراضيّ. غيّره فقط لنموذج أحدث من نفس المزوّد.</div>
            <input
              type="text"
              value={modelValue}
              onChange={(e) => setModelDraft(e.target.value)}
              placeholder="gemini-2.5-flash-image"
              dir="ltr"
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => update.mutate({ aiModel: modelValue.trim() || null }, { onSuccess: () => setModelDraft(null) })}
            disabled={update.isPending}
          >
            حفظ النموذج
          </Button>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs font-medium">البرومت الجاهز للاستوديو</label>
            {s?.aiStudioPromptIsDefault && <Badge variant="outline" className="text-[10px]">الافتراضيّ</Badge>}
          </div>
          <div className="text-[11px] text-muted-foreground">يصف الخلفية والإضاءة والإطار الموحّد. حارس حفظ المنتج مبنيّ في النظام ولا يلغى بهذا النصّ.</div>
          <textarea
            value={promptValue}
            onChange={(e) => setPromptDraft(e.target.value)}
            rows={5}
            dir="ltr"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => update.mutate({ aiStudioPrompt: promptValue.trim() || null }, { onSuccess: () => setPromptDraft(null) })}
              disabled={update.isPending}
            >
              حفظ البرومت
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => update.mutate({ aiStudioPrompt: null }, { onSuccess: () => setPromptDraft(null) })}
              disabled={update.isPending || s?.aiStudioPromptIsDefault}
            >
              <RotateCcw aria-hidden className="size-3.5 me-1" /> استعادة الافتراضيّ
            </Button>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap pt-1 border-t mt-1">
          <Button
            variant="outline"
            onClick={() => verify.mutate()}
            disabled={verify.isPending || !s?.hasAiKey}
          >
            {verify.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4 me-1" />}
            فحص الاتصال
          </Button>
          {s?.aiEnabled ? (
            <Button variant="outline" onClick={() => update.mutate({ aiEnabled: false })} disabled={update.isPending}>
              تعطيل
            </Button>
          ) : (
            <Button variant="outline" onClick={() => update.mutate({ aiEnabled: true })} disabled={update.isPending || !s?.hasAiKey} title={!s?.hasAiKey ? "أدخل المفتاح أوّلاً" : undefined}>
              تفعيل
            </Button>
          )}
          {s?.hasAiKey && (
            <Button
              variant="ghost"
              className="text-destructive hover:bg-destructive/10"
              onClick={async () => {
                if (!(await confirm({
                  variant: "danger",
                  title: "حذف مفتاح الذكاء الاصطناعي",
                  description: "سيحذف المفتاح ويعطّل المسار. متابعة؟",
                  confirmText: "حذف",
                  cancelText: "تراجع",
                }))) return;
                update.mutate({ aiKey: null });
              }}
              disabled={update.isPending}
            >
              <Trash2 aria-hidden className="size-4 me-1" /> حذف المفتاح
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * مركز واتساب الأعمال — الإعدادات والأتمتة (T4.3). القسم كاملاً محصور بالأدمن (نفس بوّابة
 * هذه الشاشة gate: adminOnly في AdminHub.tsx) ⇒ لا حاجة لفصل عرض/تحرير للمدير هنا — **القرار
 * الأنظف** المذكور في المواصفة: get على managerProcedure خادمياً (تستهلكه شاشات أخرى لاحقاً)،
 * وواجهياً القسم بأكمله خلف بوّابة الأدمن أصلاً.
 */
type WaHubSettingsData = RouterOutputs["integrations"]["waHubSettings"]["get"];
type TriageMode = WaHubSettingsData["triageMode"];

interface AutomationDraft {
  triageMode: TriageMode;
  autoTaskEnabled: boolean;
  days: number[];
  hoursFrom: string;
  hoursTo: string;
  afterHoursReply: string;
  welcomeReply: string;
  autoReplyAfterHours: boolean;
  autoReplyWelcome: boolean;
  flowArReminder: boolean;
  flowOrderReady: boolean;
  flowPurchaseThanks: boolean;
  flowConsignmentWithdraw: boolean;
  flowReservationNearExpiry: boolean;
  csatOnResolve: boolean;
  throttlePerMinute: string;
  campaignApprovalThreshold: string;
  optOutKeywords: string;
}

const DAY_LABELS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** يطابق `parseBusinessHours` الخادمية (flowNotify.ts) — قراءة عرض فقط، لا تحقّق صارم هنا
 *  (الخادم مصدر الحقيقة النهائي؛ قيمة غير صالحة تعرض كـ«بلا ساعات دوام مضبوطة»). */
function parseBusinessHoursDraft(raw: unknown): { days: number[]; from: string; to: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const days = Array.isArray(o.days)
    ? (o.days.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6) as number[])
    : null;
  const from = typeof o.from === "string" ? o.from : null;
  const to = typeof o.to === "string" ? o.to : null;
  if (!days || !days.length || !from || !to) return null;
  return { days, from, to };
}

function draftFromServer(d: WaHubSettingsData): AutomationDraft {
  const hours = parseBusinessHoursDraft(d.businessHoursJson);
  return {
    triageMode: d.triageMode,
    autoTaskEnabled: d.autoTaskEnabled,
    days: hours?.days ?? [],
    hoursFrom: hours?.from ?? "09:00",
    hoursTo: hours?.to ?? "17:00",
    afterHoursReply: d.afterHoursReply ?? "",
    welcomeReply: d.welcomeReply ?? "",
    autoReplyAfterHours: d.autoReplyAfterHours,
    autoReplyWelcome: d.autoReplyWelcome,
    flowArReminder: d.flowArReminder,
    flowOrderReady: d.flowOrderReady,
    flowPurchaseThanks: d.flowPurchaseThanks,
    flowConsignmentWithdraw: d.flowConsignmentWithdraw,
    flowReservationNearExpiry: d.flowReservationNearExpiry,
    csatOnResolve: d.csatOnResolve,
    throttlePerMinute: String(d.throttlePerMinute),
    campaignApprovalThreshold: String(d.campaignApprovalThreshold),
    optOutKeywords: d.optOutKeywords ?? "",
  };
}

/** إيقاف الطوارئ — بارز أعلى القسم، يعمل فوراً (بلا انتظار زرّ حفظ الأتمتة) + تأكيد عند
 *  التفعيل (خطير: يوقف كل إرسال آلي — تذكيرات/إشعارات/ردود). الإرسال اليدوي من الوارد لا يتأثّر. */
function KillSwitchCard() {
  const utils = trpc.useUtils();
  const q = trpc.integrations.waHubSettings.get.useQuery();
  const update = trpc.integrations.waHubSettings.update.useMutation({
    onSuccess: () => { utils.integrations.waHubSettings.invalidate(); },
    onError: (e) => notify.err(e),
  });

  if (q.isError) {
    return <ErrorState message="تعذّر تحميل حالة إيقاف الطوارئ." onRetry={() => void q.refetch()} />;
  }
  if (q.isLoading || !q.data) return <LoadingState />;
  const killSwitch = q.data.killSwitch;

  const handleToggle = async (next: boolean) => {
    if (next) {
      if (!(await confirm({
        variant: "danger",
        title: "إيقاف كل الإرسال الآلي فوراً",
        description: "سيتوقّف كل إرسال تلقائي (تذكيرات/إشعارات/ردود آلية) عبر مركز واتساب فوراً حتى إعادة التفعيل. الإرسال اليدوي من الوارد يبقى يعمل.",
        confirmText: "إيقاف الآن",
        cancelText: "تراجع",
      }))) return;
    }
    update.mutate({ killSwitch: next }, { onSuccess: () => notify.ok(next ? "أوقف الإرسال الآلي" : "أعيد تفعيل الإرسال الآلي") });
  };

  return (
    <Card className={killSwitch ? "border-destructive/40 bg-destructive/5" : "border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)]/60"}>
      <CardContent className="p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className={`size-10 rounded-lg grid place-items-center flex-shrink-0 border ${killSwitch ? "bg-destructive/10 text-destructive border-destructive/30" : "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)]/30"}`}>
            <Power aria-hidden className="size-5" />
          </div>
          <div>
            <div className="font-bold text-sm">إيقاف الطوارئ (Kill Switch)</div>
            <div className="text-xs text-muted-foreground">يوقف كل إرسال آلي فوراً — الإرسال اليدوي من الوارد يبقى يعمل.</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={killSwitch ? "badge-stock-out" : "badge-status-active"}>
            {killSwitch ? "الإرسال الآلي موقف" : "الإرسال الآلي فعّال"}
          </Badge>
          <Switch
            checked={killSwitch}
            onCheckedChange={handleToggle}
            disabled={q.isLoading || update.isPending}
            aria-label="إيقاف كل الإرسال الآلي"
          />
        </div>
      </CardContent>
    </Card>
  );
}

const FLOW_KEYS: { key: "flowArReminder" | "flowOrderReady" | "flowPurchaseThanks" | "flowConsignmentWithdraw" | "flowReservationNearExpiry" | "csatOnResolve"; label: string }[] = [
  { key: "flowArReminder", label: "تذكير ذمم آجلة (AR/AP)" },
  { key: "flowOrderReady", label: "إشعار جاهزية الطلب" },
  { key: "flowPurchaseThanks", label: "شكر الشراء" },
  { key: "flowConsignmentWithdraw", label: "إشعار سحب بضاعة أمانة" },
  { key: "flowReservationNearExpiry", label: "تنبيه قرب انتهاء الحجز" },
  { key: "csatOnResolve", label: "استبيان رضا (CSAT) عند إغلاق المحادثة" },
];

/** نموذج إعدادات الأتمتة (وضع الفرز/ساعات الدوام/الردود الآلية/مفاتيح التدفّقات/الحدود) —
 *  حفظ شامل بزرّ واحد (undefined للحقول غير المهيّأة بعد = لا تغيّر خادمياً، لكن هنا
 *  الدرافت دائماً مهيّأ كاملاً من آخر قراءة خادمية فنرسل كل الحقول). */
function AutomationSettingsCard() {
  const utils = trpc.useUtils();
  const q = trpc.integrations.waHubSettings.get.useQuery();
  const [draft, setDraftState] = useState<AutomationDraft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const setDraft = (next: Parameters<typeof setDraftState>[0]) => {
    setDraftDirty(true);
    setDraftState(next);
  };

  useEffect(() => {
    if (q.data && !draftDirty) setDraftState(draftFromServer(q.data));
  }, [q.data, draftDirty]);

  const update = trpc.integrations.waHubSettings.update.useMutation({
    onSuccess: (row) => {
      notify.ok("حفظت إعدادات الأتمتة");
      utils.integrations.waHubSettings.invalidate();
      setDraftDirty(false);
      setDraftState(draftFromServer(row));
    },
    onError: (e) => notify.err(e),
  });

  if (q.isError) {
    return <ErrorState message="تعذّر تحميل إعدادات الأتمتة." onRetry={() => void q.refetch()} />;
  }
  if (q.isLoading || !draft) return <LoadingState />;

  function toggleDay(d: number) {
    setDraft((cur) => (cur ? { ...cur, days: cur.days.includes(d) ? cur.days.filter((x) => x !== d) : [...cur.days, d].sort((a, b) => a - b) } : cur));
  }

  function save() {
    if (!draft) return;
    const throttle = Math.round(Number(draft.throttlePerMinute));
    const threshold = Math.round(Number(draft.campaignApprovalThreshold));
    if (!Number.isFinite(throttle) || throttle < 1 || throttle > 1000) {
      notify.err("حدّ الإرسال بالدقيقة يجب أن يكون رقماً بين ١ و١٠٠٠");
      return;
    }
    if (!Number.isFinite(threshold) || threshold < 0) {
      notify.err("سقف اعتماد الحملة يجب أن يكون رقماً صحيحاً ≥ صفر");
      return;
    }
    update.mutate({
      triageMode: draft.triageMode,
      autoTaskEnabled: draft.autoTaskEnabled,
      businessHoursJson: draft.days.length > 0 ? { days: draft.days, from: draft.hoursFrom, to: draft.hoursTo } : null,
      afterHoursReply: draft.afterHoursReply.trim() || null,
      welcomeReply: draft.welcomeReply.trim() || null,
      throttlePerMinute: throttle,
      campaignApprovalThreshold: threshold,
      optOutKeywords: draft.optOutKeywords.trim() || null,
      autoReplyAfterHours: draft.autoReplyAfterHours,
      autoReplyWelcome: draft.autoReplyWelcome,
      flowArReminder: draft.flowArReminder,
      flowOrderReady: draft.flowOrderReady,
      flowPurchaseThanks: draft.flowPurchaseThanks,
      flowConsignmentWithdraw: draft.flowConsignmentWithdraw,
      flowReservationNearExpiry: draft.flowReservationNearExpiry,
      csatOnResolve: draft.csatOnResolve,
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Settings2 aria-hidden className="size-4.5 text-primary" /> إعدادات الأتمتة
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium">وضع الفرز</label>
            <select
              value={draft.triageMode}
              onChange={(e) => setDraft({ ...draft, triageMode: e.target.value as TriageMode })}
              className="w-full h-9 border rounded-md px-2 text-sm bg-background"
            >
              <option value="AUTO_ALL">تلقائي للكلّ</option>
              <option value="KEYWORD_ONLY">حسب الكلمات المفتاحية فقط</option>
              <option value="MANUAL">يدوي بالكامل</option>
            </select>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 h-9 self-end">
            <label className="text-xs font-medium">إنشاء مهام تلقائياً</label>
            <Switch checked={draft.autoTaskEnabled} onCheckedChange={(v) => setDraft({ ...draft, autoTaskEnabled: v })} aria-label="إنشاء مهام تلقائياً" />
          </div>
        </div>

        <div className="space-y-2 border-t pt-4">
          <label className="text-xs font-medium inline-flex items-center gap-1.5">
            <Clock aria-hidden className="size-3.5" /> ساعات الدوام
          </label>
          <div className="flex flex-wrap gap-1.5">
            {DAY_LABELS.map((label, i) => (
              <button
                key={i}
                type="button"
                onClick={() => toggleDay(i)}
                aria-pressed={draft.days.includes(i)}
                className={`text-xs px-2.5 py-1 rounded-md border font-medium ${
                  draft.days.includes(i) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input type="time" value={draft.hoursFrom} onChange={(e) => setDraft({ ...draft, hoursFrom: e.target.value })} dir="ltr" className="h-9 border rounded-md px-2 text-sm bg-background" />
            <span className="text-xs text-muted-foreground">إلى</span>
            <input type="time" value={draft.hoursTo} onChange={(e) => setDraft({ ...draft, hoursTo: e.target.value })} dir="ltr" className="h-9 border rounded-md px-2 text-sm bg-background" />
          </div>
          <p className="text-[11px] text-muted-foreground">اترك الأيام كلها بلا اختيار لإلغاء ساعات الدوام (كل الأوقات ضمن الدوام). توقيت بغداد (UTC+3).</p>
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium">ردّ خارج الدوام</label>
            <Switch checked={draft.autoReplyAfterHours} onCheckedChange={(v) => setDraft({ ...draft, autoReplyAfterHours: v })} aria-label="تفعيل ردّ خارج الدوام" />
          </div>
          <textarea
            value={draft.afterHoursReply}
            onChange={(e) => setDraft({ ...draft, afterHoursReply: e.target.value })}
            rows={2}
            maxLength={2000}
            placeholder="مثال: شكراً لتواصلكم، نحن خارج أوقات الدوام حالياً وسنعاود الردّ في أقرب وقت."
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium">ردّ الترحيب (أوّل رسالة واردة)</label>
            <Switch checked={draft.autoReplyWelcome} onCheckedChange={(v) => setDraft({ ...draft, autoReplyWelcome: v })} aria-label="تفعيل ردّ الترحيب" />
          </div>
          <textarea
            value={draft.welcomeReply}
            onChange={(e) => setDraft({ ...draft, welcomeReply: e.target.value })}
            rows={2}
            maxLength={2000}
            placeholder="مثال: أهلاً بك في المكتبة العربية للطباعة والقرطاسية! كيف يمكننا خدمتك؟"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="space-y-2 border-t pt-4">
          <label className="text-xs font-medium">مفاتيح التدفّقات الآلية بقالب معتمد (كلّها معطّلة افتراضياً)</label>
          <div className="grid gap-2 sm:grid-cols-2">
            {FLOW_KEYS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between rounded-md border px-3 h-9">
                <span className="text-xs">{label}</span>
                <Switch checked={draft[key]} onCheckedChange={(v) => setDraft({ ...draft, [key]: v })} aria-label={label} />
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 border-t pt-4">
          <div className="space-y-1">
            <label className="text-xs font-medium">حدّ الإرسال بالدقيقة (throttle)</label>
            <input
              type="number"
              min={1}
              max={1000}
              value={draft.throttlePerMinute}
              onChange={(e) => setDraft({ ...draft, throttlePerMinute: e.target.value })}
              dir="ltr"
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">سقف اعتماد الحملة (يدوياً تحته)</label>
            <input
              type="number"
              min={0}
              value={draft.campaignApprovalThreshold}
              onChange={(e) => setDraft({ ...draft, campaignApprovalThreshold: e.target.value })}
              dir="ltr"
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <label className="text-xs font-medium">كلمات إلغاء الاشتراك (opt-out)</label>
            <input
              type="text"
              value={draft.optOutKeywords}
              onChange={(e) => setDraft({ ...draft, optOutKeywords: e.target.value })}
              placeholder="مثال: إيقاف، الغاء، stop"
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
            />
          </div>
        </div>

        <div className="pt-1">
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : <Save aria-hidden className="size-4 me-1" />}
            حفظ إعدادات الأتمتة
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const TEMPLATE_STATUS_META: Record<string, { label: string; cls: string }> = {
  APPROVED: { label: "معتمد", cls: "badge-status-active" },
  PENDING: { label: "قيد المراجعة", cls: "badge-status-pending" },
  REJECTED: { label: "مرفوض", cls: "badge-stock-out" },
  PAUSED: { label: "معلّق", cls: "badge-status-cancelled" },
  DISABLED: { label: "معطّل", cls: "badge-status-cancelled" },
};

/** مزامنة قوالب Meta + جدول القوالب المخزّنة (waTemplates — عامّة، ليست بحسب الفرع؛
 *  الفرع هنا يحدّد فقط أيّ تكامل واتساب ACTIVE يستعمل كمصدر للمزامنة). */
function TemplateSyncSection({ branches }: { branches: { id: number; name: string }[] }) {
  const utils = trpc.useUtils();
  const [branchId, setBranchId] = useState<number>(branches[0]?.id ?? 0);
  useEffect(() => {
    if (!branchId && branches[0]) setBranchId(branches[0].id);
  }, [branches, branchId]);

  const templatesQ = trpc.integrations.templates.list.useQuery();
  const sync = trpc.integrations.syncTemplates.useMutation({
    onSuccess: (r) => {
      notify.ok("تمّت المزامنة", `${r.synced} قالباً (${r.approved} معتمد).`);
      utils.integrations.templates.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <LayoutTemplate aria-hidden className="size-4.5 text-primary" /> قوالب Meta
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs font-medium">الفرع (لتحديد تكامل واتساب المصدر)</label>
            <select
              value={branchId || ""}
              onChange={(e) => setBranchId(Number(e.target.value))}
              className="h-9 border rounded-md px-2 text-sm bg-background"
            >
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <Button variant="outline" onClick={() => sync.mutate({ branchId })} disabled={sync.isPending || !branchId}>
            {sync.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : <RefreshCw aria-hidden className="size-4 me-1" />}
            مزامنة القوالب من Meta
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">يتطلّب تكامل واتساب ACTIVE على الفرع المختار + WABA ID مضبوطاً في بطاقة تكامله أعلاه.</p>

        {templatesQ.isLoading ? (
          <LoadingState />
        ) : templatesQ.isError ? (
          <ErrorState message="تعذّر تحميل قوالب Meta." onRetry={() => void templatesQ.refetch()} />
        ) : (templatesQ.data?.length ?? 0) === 0 ? (
          <div className="text-xs text-muted-foreground border border-dashed rounded-lg p-4 text-center">
            لا قوالب مزامنة بعد. اضغط «مزامنة القوالب من Meta» بعد ضبط WABA ID.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="text-right p-2 font-medium">الاسم</th>
                  <th className="text-center p-2 font-medium">اللغة</th>
                  <th className="text-center p-2 font-medium">الفئة</th>
                  <th className="text-center p-2 font-medium">الحالة</th>
                  <th className="text-center p-2 font-medium">المتغيّرات</th>
                  <th className="text-center p-2 font-medium">آخر مزامنة</th>
                </tr>
              </thead>
              <tbody>
                {templatesQ.data?.map((t) => {
                  const st = TEMPLATE_STATUS_META[t.templateStatus] ?? TEMPLATE_STATUS_META.PENDING;
                  return (
                    <tr key={t.id} className="border-t">
                      <td className="p-2 font-medium">{t.name}</td>
                      <td className="p-2 text-center" dir="ltr">{t.language}</td>
                      <td className="p-2 text-center text-xs text-muted-foreground">{t.category}</td>
                      <td className="p-2 text-center"><Badge variant="outline" className={st.cls}>{st.label}</Badge></td>
                      <td className="p-2 text-center tabular-nums">{t.variableCount}</td>
                      <td className="p-2 text-center text-xs text-muted-foreground" dir="ltr">{t.syncedAt ? fmtDateTime(t.syncedAt) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** القسم الكامل — يركّب تحت PageHeader في الشاشة الرئيسية. */
function WaHubAutomationSection({ branches }: { branches: { id: number; name: string }[] }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <MessageSquare aria-hidden className="size-5 text-[var(--sem-pos)]" />
        <h2 className="text-base font-bold">مركز واتساب الأعمال — الإعدادات والأتمتة</h2>
      </div>
      <KillSwitchCard />
      <AutomationSettingsCard />
      <TemplateSyncSection branches={branches} />
    </div>
  );
}

export default function IntegrationsSettings() {
  const cryptoReady = trpc.integrations.cryptoReady.useQuery();
  const list = trpc.integrations.list.useQuery(undefined, { enabled: cryptoReady.data?.ready });
  const branchesQ = trpc.branches.list.useQuery();
  const [showNew, setShowNew] = useState(false);
  const [section, setSection] = useState<CenterSection>("connections");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<IntegrationStatusFilter>("ALL");
  const [channelFilter, setChannelFilter] = useState<IntegrationChannelFilter>("ALL");
  const [branchFilter, setBranchFilter] = useState<number | null>(null);

  const branches = useMemo(
    () => (branchesQ.data ?? []).map((b) => ({ id: Number(b.id), name: b.name })),
    [branchesQ.data],
  );
  const integrations = list.data ?? [];
  const summary = useMemo(() => summarizeIntegrations(integrations), [integrations]);
  const filteredIntegrations = useMemo(
    () => filterIntegrations(integrations, {
      query,
      status: statusFilter,
      channel: channelFilter,
      branchId: branchFilter,
    }),
    [integrations, query, statusFilter, channelFilter, branchFilter],
  );
  const hasFilters = query.trim() !== "" || statusFilter !== "ALL" || channelFilter !== "ALL" || branchFilter != null;

  const clearFilters = () => {
    setQuery("");
    setStatusFilter("ALL");
    setChannelFilter("ALL");
    setBranchFilter(null);
  };

  // المفتاح الرئيسي غير مضبوط ⇒ توجيه واضح بدل صفحة فارغة.
  if (cryptoReady.data && !cryptoReady.data.ready) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <Card className="border-[var(--sem-warn)]/30 bg-[var(--sem-warn-bg)]">
          <CardHeader>
            <CardTitle className="text-base inline-flex items-center gap-2">
              <KeyRound aria-hidden className="size-5 text-[var(--sem-warn)]" />
              مفتاح التشفير غير مضبوط
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              لإدارة tokens التكاملات بأمان داخل النظام، يلزم توليد مفتاح تشفير 32-byte مرة واحدة:
            </p>
            <pre dir="ltr" className="bg-muted border rounded-md p-3 text-xs overflow-x-auto"><code>{`# على VPS:
openssl rand -hex 32

# أضف لـ .env:
INTEGRATIONS_ENCRYPTION_KEY=<النتيجة>

# أعد تشغيل النظام:
pnpm prod:deploy
`}</code></pre>
            <div className="text-xs text-muted-foreground inline-flex items-start gap-1.5">
              <AlertCircle aria-hidden className="size-3.5 flex-shrink-0 mt-0.5 text-[var(--sem-warn)]" />
              <span>لا تغيّر المفتاح بعد ضبطه — يكسر كل secrets المخزّنة. خذ نسخة احتياطية أوّلاً.</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (cryptoReady.isLoading || branchesQ.isLoading || (cryptoReady.data?.ready && list.isLoading)) {
    return <LoadingState message="جارٍ تحميل مركز التكاملات…" />;
  }

  if (cryptoReady.isError || list.isError || branchesQ.isError) {
    return (
      <ErrorState
        message="تعذّر تحميل مركز التكاملات. لم تُعرض البيانات كأنها قائمة فارغة."
        onRetry={() => {
          void cryptoReady.refetch();
          if (cryptoReady.data?.ready) void list.refetch();
          void branchesQ.refetch();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="مركز التكاملات"
        description="إدارة الاتصالات الخارجية وحالتها حسب الفرع. الاعتمادات مشفّرة ولا تظهر في سجلات التدقيق."
        icon={<Cable aria-hidden className="size-6 text-primary" />}
        actions={
          <Button onClick={() => setShowNew(true)} disabled={branches.length === 0}>
            <Plus aria-hidden className="size-4 me-1" /> إضافة قناة
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <CenterMetric label="إجمالي الاتصالات" value={summary.total} icon={Cable} iconClassName="text-primary" />
        <CenterMetric label="فعّال" value={summary.active} icon={CheckCircle2} iconClassName="text-[var(--sem-pos)]" />
        <CenterMetric label="يحتاج تدخلاً" value={summary.attention} icon={AlertTriangle} iconClassName="text-[var(--sem-warn)]" />
        <CenterMetric label="معطّل إدارياً" value={summary.disabled} icon={Power} iconClassName="text-muted-foreground" />
      </div>

      <Tabs value={section} onValueChange={(value) => setSection(value as CenterSection)} dir="rtl">
        <div className="overflow-x-auto pb-1">
          <TabsList className="min-w-max">
            <TabsTrigger value="connections"><Cable aria-hidden />الاتصالات</TabsTrigger>
            <TabsTrigger value="whatsapp"><MessageSquare aria-hidden />واتساب والأتمتة</TabsTrigger>
            <TabsTrigger value="content"><Scissors aria-hidden />خدمات المحتوى</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="connections" forceMount className="mt-2 space-y-4 data-[state=inactive]:hidden">
          {summary.attention > 0 && !list.isLoading && (
            <div role="status" className="flex items-start gap-2 rounded-lg border badge-status-pending p-3 text-sm">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              <div>
                <span className="font-bold">{summary.attention} اتصال يحتاج متابعة.</span>{" "}
                افتح بطاقة الاتصال للاطلاع على الخطأ أو إكمال التحقق.
              </div>
            </div>
          )}

          <Card className="gap-0 py-0 shadow-none">
            <CardContent className="p-4">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_180px_180px_180px_auto]">
                <div className="relative">
                  <Search aria-hidden className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="ابحث بالاسم أو الفرع"
                    className="pe-9"
                    aria-label="البحث في الاتصالات"
                  />
                </div>
                <AppSelect value={statusFilter} onValueChange={(value) => setStatusFilter(value as IntegrationStatusFilter)} aria-label="حالة الاتصال">
                  <option value="ALL">كل الحالات</option>
                  <option value="ACTIVE">فعّال</option>
                  <option value="ATTENTION">يحتاج تدخلاً</option>
                  <option value="DISABLED">معطّل</option>
                </AppSelect>
                <AppSelect value={channelFilter} onValueChange={(value) => setChannelFilter(value as IntegrationChannelFilter)} aria-label="نوع القناة">
                  <option value="ALL">كل القنوات</option>
                  <option value="WHATSAPP">واتساب</option>
                  <option value="INSTAGRAM">انستغرام</option>
                  <option value="STORE">Webhook متجر</option>
                </AppSelect>
                <AppSelect
                  value={branchFilter == null ? "ALL" : String(branchFilter)}
                  onValueChange={(value) => setBranchFilter(value === "ALL" ? null : Number(value))}
                  aria-label="الفرع"
                >
                  <option value="ALL">كل الفروع</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </AppSelect>
                <Button variant="outline" onClick={clearFilters} disabled={!hasFilters}>{FILTER_LABELS.reset}</Button>
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                عرض {filteredIntegrations.length} من {summary.total} اتصال
              </div>
            </CardContent>
          </Card>

          {cryptoReady.isLoading || list.isLoading ? (
            <LoadingState />
          ) : integrations.length === 0 ? (
            <Card className="shadow-none">
              <CardContent className="space-y-3 py-12 text-center">
                <div className="mx-auto grid size-14 place-items-center rounded-full border bg-muted/30">
                  <Cable aria-hidden className="size-6 text-muted-foreground" />
                </div>
                <div className="font-medium">لا توجد قنوات اتصال مهيأة</div>
                <div className="text-sm text-muted-foreground">أضف واتساب أو انستغرام أو webhook متجر مخصص، ثم اختبر الاتصال قبل الاعتماد عليه.</div>
                <Button onClick={() => setShowNew(true)} disabled={branches.length === 0}>
                  <Plus aria-hidden className="size-4 me-1" /> إضافة قناة
                </Button>
              </CardContent>
            </Card>
          ) : filteredIntegrations.length === 0 ? (
            <Card className="shadow-none">
              <CardContent className="space-y-3 py-10 text-center">
                <Search aria-hidden className="mx-auto size-6 text-muted-foreground" />
                <div className="font-medium">لا توجد نتائج مطابقة</div>
                <Button variant="outline" onClick={clearFilters}>{FILTER_LABELS.reset}</Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {filteredIntegrations.map((integ, index) => (
                <IntegrationCard
                  key={integ.id}
                  integ={integ}
                  wide={filteredIntegrations.length % 2 === 1 && index === filteredIntegrations.length - 1}
                  onChanged={() => list.refetch()}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="whatsapp" forceMount className="mt-2 data-[state=inactive]:hidden">
          <WaHubAutomationSection branches={branches} />
        </TabsContent>

        <TabsContent value="content" forceMount className="mt-2 space-y-4 data-[state=inactive]:hidden">
          <div className="flex items-center gap-2">
            <Scissors aria-hidden className="size-5 text-primary" />
            <div>
              <h2 className="text-base font-bold">خدمات محتوى المنتجات</h2>
              <p className="text-xs text-muted-foreground">إعداد مزوّدي معالجة الصور والتوليد بعيداً عن اتصالات القنوات التشغيلية.</p>
            </div>
          </div>
          <ImageStudioIntegrationCard />
          <AiImageStudioIntegrationCard />
        </TabsContent>
      </Tabs>

      {showNew && (
        <NewIntegrationDialog
          branches={branches}
          onCreated={() => list.refetch()}
          onClose={() => setShowNew(false)}
        />
      )}
    </div>
  );
}
