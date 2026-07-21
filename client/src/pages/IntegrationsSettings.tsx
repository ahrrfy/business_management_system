import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, CheckCircle2, ChevronDown, Copy, Eye, EyeOff, KeyRound, Loader2, Plus, RefreshCw, Scissors, ShoppingBag, Trash2, User, MessageSquare } from "lucide-react";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState } from "@/components/PageState";
import { useMemo, useState } from "react";

/**
 * شاشة تَكاملات القَنوات الخارِجية — `/settings/integrations` (شَريحة #6).
 *
 * الإدارة الكاملة لـtokens WhatsApp/Instagram/Store في الواجهة بَدل SSH للسيرفر:
 *   - بَطاقة لِكل (فَرع × قَناة).
 *   - حُقول secrets مُقَنَّعة (•••abcd) مع زر «أَظهر/أَخفِ».
 *   - زر «تَحقّق» يَضرب Meta/Store API فِعلياً ⇒ status لايف + lastError مَقروء.
 *   - زر «انسَخ webhook URL» لِلَصق في Meta/Salla.
 *   - تَعطيل/تَفعيل/حَذف بَلا فَقد audit history.
 *
 * RBAC: adminProcedure فَقط (مَحمي في App.tsx بـRequireRole + في tRPC).
 * المُتَطَلَّب الوَحيد: INTEGRATIONS_ENCRYPTION_KEY في .env (يَتَحَقَّق بـcryptoReady).
 */

type Integration = RouterOutputs["integrations"]["list"][number];
type Channel = "WHATSAPP" | "INSTAGRAM" | "STORE";

const CHANNEL_META: Record<Channel, { label: string; Icon: typeof MessageSquare; cls: string }> = {
  WHATSAPP: { label: "واتساب", Icon: MessageSquare, cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" },
  INSTAGRAM: { label: "انستغرام", Icon: User, cls: "bg-pink-500/10 text-pink-700 dark:text-pink-400 border-pink-500/30" },
  STORE: { label: "المتجر", Icon: ShoppingBag, cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30" },
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "بانتظار التَحقّق", cls: "badge-status-pending" },
  ACTIVE: { label: "مُتَّصِل", cls: "badge-status-active" },
  FAILED: { label: "فَشل", cls: "badge-stock-out" },
  DISABLED: { label: "مُعَطَّل", cls: "badge-status-cancelled" },
};

/** حَقل secret: قَناع •••• افتراضي + زر إظهار + إدخال نَصّ جَديد (يَستَبدِل القَديم). */
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
        <div className="relative flex-1">
          <input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={masked ? `الحالي: ${masked}` : (placeholder ?? "اِلصَق القِيمة الجَديدة")}
            dir="ltr"
            className="w-full h-9 px-3 pe-9 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute end-1 top-1/2 -translate-y-1/2 size-7 grid place-items-center text-muted-foreground hover:text-foreground"
            title={show ? "إخفاء" : "إظهار"}
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
  verifyToken: string;
  appSecret: string;
  accessToken: string;
}

function IntegrationCard({ integ, onChanged }: { integ: Integration; onChanged: () => void }) {
  const ch = CHANNEL_META[integ.channel as Channel];
  const st = STATUS_META[integ.status] ?? STATUS_META.PENDING;
  const [draft, setDraft] = useState<DraftState>({
    displayName: integ.displayName ?? "",
    phoneNumberId: integ.phoneNumberId ?? "",
    verifyToken: "",
    appSecret: "",
    accessToken: "",
  });
  const [open, setOpen] = useState(false);

  const utils = trpc.useUtils();
  const upsert = trpc.integrations.upsert.useMutation({
    onSuccess: () => { notify.ok("تَم الحِفظ", "الـtokens مُشَفَّرة في DB. اِضغط «تَحقّق» لِاختبار الاتصال."); utils.integrations.list.invalidate(); onChanged(); },
    onError: (e) => notify.err(e),
  });
  const verify = trpc.integrations.verify.useMutation({
    onSuccess: (r) => { (r.ok ? notify.ok : notify.warn)(r.ok ? "مُتَّصِل" : "فَشل التَحقّق", r.message); utils.integrations.list.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const disable = trpc.integrations.disable.useMutation({
    onSuccess: () => { notify.ok("تَم التَعطيل"); utils.integrations.list.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const enable = trpc.integrations.enable.useMutation({
    onSuccess: () => { notify.ok("تَم التَفعيل"); utils.integrations.list.invalidate(); },
    onError: (e) => notify.err(e),
  });
  const del = trpc.integrations.delete.useMutation({
    onSuccess: () => { notify.ok("تَم الحَذف"); utils.integrations.list.invalidate(); onChanged(); },
    onError: (e) => notify.err(e),
  });

  const save = () => {
    upsert.mutate({
      branchId: integ.branchId,
      channel: integ.channel as Channel,
      displayName: draft.displayName.trim() || null,
      phoneNumberId: draft.phoneNumberId.trim() || null,
      // فَقط الحُقول التي كُتب فيها نَصّ جَديد ⇒ undefined لِبقاء القَديم.
      verifyToken: draft.verifyToken ? draft.verifyToken : undefined,
      appSecret: draft.appSecret ? draft.appSecret : undefined,
      accessToken: draft.accessToken ? draft.accessToken : undefined,
    });
    setDraft((d) => ({ ...d, verifyToken: "", appSecret: "", accessToken: "" })); // اِمسح النَصّ بَعد الحِفظ.
  };

  const copyUrl = async () => {
    await navigator.clipboard.writeText(integ.webhookUrl).catch(() => {});
    notify.ok("نُسِخ", `webhook URL: ${integ.webhookUrl}`);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`size-10 rounded-lg grid place-items-center flex-shrink-0 border ${ch.cls}`}>
              <ch.Icon aria-hidden className="size-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">{ch.label} — {integ.branchName ?? `فَرع #${integ.branchId}`}</CardTitle>
              {integ.displayName && <div className="text-xs text-muted-foreground mt-0.5">{integ.displayName}</div>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={st.cls}>{st.label}</Badge>
            {integ.lastVerifiedAt && (
              <span className="text-[10px] text-muted-foreground" dir="ltr">
                آخر تَحقّق {fmtDateTime(integ.lastVerifiedAt)}
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {integ.lastError && integ.status === "FAILED" && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs flex items-start gap-2">
            <AlertCircle aria-hidden className="size-4 text-destructive flex-shrink-0 mt-0.5" />
            <div className="text-destructive break-words">{integ.lastError}</div>
          </div>
        )}

        <div className="rounded-md border bg-muted/30 p-2.5 space-y-1.5">
          <div className="text-xs text-muted-foreground">webhook URL لِلَصق في إدارة المُزوّد:</div>
          <div className="flex gap-2 items-center">
            <code className="flex-1 text-[11px] bg-background border rounded px-2 py-1 truncate" dir="ltr">{integ.webhookUrl}</code>
            <Button size="sm" variant="outline" onClick={copyUrl}>
              <Copy aria-hidden className="size-3.5 me-1" /> نَسخ
            </Button>
          </div>
        </div>

        {/* الحُقول الـsecret — مَطوية لِتَقليل الازدحام البَصري */}
        <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="text-sm font-medium cursor-pointer select-none inline-flex items-center gap-1.5">
            <ChevronDown aria-hidden className={`size-4 transition-transform ${open ? "rotate-0" : "-rotate-90"}`} />
            تَفاصيل + tokens
          </summary>
          <div className="space-y-3 mt-3 pt-3 border-t">
            <div className="grid gap-3 md:grid-cols-2 items-start">
              <div className="space-y-1">
                <label className="text-xs font-medium">اسم العَرض (اختياري)</label>
                <input
                  type="text"
                  value={draft.displayName}
                  onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  placeholder={`${ch.label} — ${integ.branchName ?? ""}`}
                  className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              {integ.channel === "WHATSAPP" && (
                <div className="space-y-1">
                  <label className="text-xs font-medium">Phone Number ID</label>
                  <div className="text-[11px] text-muted-foreground">مِن WhatsApp Manager → Phone numbers → API setup</div>
                  <input
                    type="text"
                    value={draft.phoneNumberId}
                    onChange={(e) => setDraft({ ...draft, phoneNumberId: e.target.value })}
                    placeholder="مَثلاً: 123456789012345"
                    dir="ltr"
                    className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              )}
              <SecretField
                label="Verify Token"
                hint="كَلمة سِرّية تَختارها أَنت — اَلصقها في Meta عند تَسجيل webhook."
                masked={integ.verifyTokenMasked}
                value={draft.verifyToken}
                onChange={(v) => setDraft({ ...draft, verifyToken: v })}
              />
              <SecretField
                label="App Secret"
                hint={integ.channel === "STORE" ? "Webhook secret مِن مَنصّة المتجر." : "App Secret مِن Meta → App Dashboard → Settings → Basic."}
                masked={integ.appSecretMasked}
                value={draft.appSecret}
                onChange={(v) => setDraft({ ...draft, appSecret: v })}
              />
              {integ.channel !== "STORE" && (
                <SecretField
                  label="Access Token (System User)"
                  hint="مِن Meta → Business Settings → System Users → Generate New Token (مَع صَلاحية whatsapp_business_messaging)."
                  masked={integ.accessTokenMasked}
                  value={draft.accessToken}
                  onChange={(v) => setDraft({ ...draft, accessToken: v })}
                />
              )}
            </div>

            <div className="flex gap-2 flex-wrap pt-2">
              <Button onClick={save} disabled={upsert.isPending}>
                {upsert.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : null}
                حِفظ
              </Button>
              <Button
                variant="outline"
                onClick={() => verify.mutate({ integrationId: integ.id })}
                disabled={verify.isPending || integ.status === "DISABLED"}
              >
                {verify.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4 me-1" />}
                تَحقّق مِن الاتصال
              </Button>
              {integ.status === "DISABLED" ? (
                <Button variant="outline" onClick={() => enable.mutate({ integrationId: integ.id })} disabled={enable.isPending}>
                  تَفعيل
                </Button>
              ) : (
                <Button variant="outline" onClick={() => disable.mutate({ integrationId: integ.id })} disabled={disable.isPending}>
                  تَعطيل
                </Button>
              )}
              <Button
                variant="ghost"
                className="text-destructive hover:bg-destructive/10"
                onClick={async () => {
                  if (!(await confirm({
                    variant: "danger",
                    title: "حَذف التَكامل",
                    description: `حَذف تَكامل ${ch.label} لِفَرع ${integ.branchName ?? integ.branchId} نِهائياً — كل secrets تُفقَد. اِكتب «حَذف» لِلتَأكيد.`,
                    confirmText: "حَذف",
                    cancelText: "تَراجع",
                    requireText: "حَذف",
                  }))) return;
                  del.mutate({ integrationId: integ.id });
                }}
                disabled={del.isPending}
              >
                <Trash2 aria-hidden className="size-4 me-1" /> حَذف
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
  const [channel, setChannel] = useState<Channel>("WHATSAPP");
  const upsert = trpc.integrations.upsert.useMutation({
    onSuccess: () => { onCreated(); onClose(); },
    onError: (e) => notify.err(e),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle className="text-base">إضافة تَكامل جَديد</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 items-start">
            <div>
              <label className="text-xs text-muted-foreground">الفَرع</label>
              <select
                value={branchId}
                onChange={(e) => setBranchId(Number(e.target.value))}
                className="w-full h-9 border rounded-md px-2 text-sm bg-background mt-1"
              >
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">القَناة</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as Channel)}
                className="w-full h-9 border rounded-md px-2 text-sm bg-background mt-1"
              >
                <option value="WHATSAPP">{CHANNEL_META.WHATSAPP.label}</option>
                <option value="INSTAGRAM">{CHANNEL_META.INSTAGRAM.label}</option>
                <option value="STORE">{CHANNEL_META.STORE.label}</option>
              </select>
            </div>
          </div>
          <div className="text-xs text-muted-foreground rounded-md bg-muted/30 border p-2.5">
            بَعد الإنشاء، اِضغط البَطاقة لِلَصق الـtokens، ثم زر «تَحقّق» يَضرب Meta API فِعلياً لِلتَأكّد.
          </div>
        </CardContent>
        <div className="flex gap-2 p-4 pt-0">
          <Button variant="outline" onClick={onClose} className="flex-1">إلغاء</Button>
          <Button
            onClick={() => upsert.mutate({ branchId, channel })}
            disabled={upsert.isPending || !branchId}
            className="flex-1"
          >
            إنشاء
          </Button>
        </div>
      </Card>
    </div>
  );
}

/**
 * بطاقة «استوديو صور المنتجات» (remove.bg) — مسار Pro لقصّ خلفية الصور احترافياً. المفتاح مُشفَّر
 * (نفس INTEGRATIONS_ENCRYPTION_KEY). عند التعطيل/نفاد الرصيد يعمل المسار المجاني الآمن تلقائياً.
 * أمانة صارمة: remove.bg قصٌّ لا توليد (بكسلات المنتج تبقى).
 */
function ImageStudioIntegrationCard() {
  const settings = trpc.imageStudio.settings.useQuery();
  const utils = trpc.useUtils();
  const [keyDraft, setKeyDraft] = useState("");
  const update = trpc.imageStudio.updateSettings.useMutation({
    onSuccess: () => { notify.ok("تَم الحِفظ"); utils.imageStudio.settings.invalidate(); utils.imageStudio.proConfig.invalidate(); setKeyDraft(""); },
    onError: (e) => notify.err(e),
  });
  const verify = trpc.imageStudio.verifyConnection.useMutation({
    onSuccess: (r) => { (r.ok ? notify.ok : notify.warn)(r.ok ? "المفتاح صالح" : "فَشل الفَحص", r.message); utils.imageStudio.settings.invalidate(); },
    onError: (e) => notify.err(e),
  });
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
              {s?.proEnabled ? "Pro مُفعَّل" : "Pro مُعطَّل"}
            </Badge>
            {s?.lastVerifiedAt && (
              <span className="text-[10px] text-muted-foreground" dir="ltr">آخر فَحص {fmtDateTime(s.lastVerifiedAt)}</span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground space-y-1">
          <p>قصٌّ احترافيّ للخلفية عبر remove.bg — <b>قصٌّ لا توليد</b> ⇒ بكسلات منتجك تبقى كما هي. مجانيّ حتى ~٥٠ صورة/شهر (دقّة معاينة منخفضة)، ثمّ مدفوع بالرصيد.</p>
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
              hint="اِلصَق مفتاحاً جديداً لِيُشفَّر ويُحفَظ. اترُكه فارغاً لِإبقاء الحاليّ."
              masked={s?.removebgKeyMasked ?? null}
              value={keyDraft}
              onChange={setKeyDraft}
              placeholder="اِلصَق مفتاح remove.bg"
            />
          </div>
          <Button onClick={() => update.mutate({ removebgKey: keyDraft.trim() })} disabled={update.isPending || !keyDraft.trim()}>
            {update.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : null}
            حِفظ المفتاح
          </Button>
        </div>

        <div className="flex gap-2 flex-wrap pt-1">
          <Button
            variant="outline"
            onClick={() => verify.mutate()}
            disabled={verify.isPending || !s?.hasKey}
          >
            {verify.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4 me-1" />}
            فَحص الاتصال والرصيد
          </Button>
          {s?.proEnabled ? (
            <Button variant="outline" onClick={() => update.mutate({ proEnabled: false })} disabled={update.isPending}>
              تَعطيل Pro
            </Button>
          ) : (
            <Button variant="outline" onClick={() => update.mutate({ proEnabled: true })} disabled={update.isPending || !s?.hasKey} title={!s?.hasKey ? "أَدخِل المفتاح أوّلاً" : undefined}>
              تَفعيل Pro
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
                  description: "سيُحذَف المفتاح ويُعطَّل مسار Pro. سيعمل المسار المجانيّ الآمن. متابعة؟",
                  confirmText: "حَذف",
                  cancelText: "تَراجع",
                }))) return;
                update.mutate({ removebgKey: null });
              }}
              disabled={update.isPending}
            >
              <Trash2 aria-hidden className="size-4 me-1" /> حَذف المفتاح
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function IntegrationsSettings() {
  const cryptoReady = trpc.integrations.cryptoReady.useQuery();
  const list = trpc.integrations.list.useQuery(undefined, { enabled: cryptoReady.data?.ready });
  const branchesQ = trpc.branches.list.useQuery();
  const [showNew, setShowNew] = useState(false);

  const branches = useMemo(
    () => (branchesQ.data ?? []).map((b) => ({ id: Number(b.id), name: b.name })),
    [branchesQ.data],
  );

  // المُفتاح الرَئيسي غَير مَضبوط ⇒ تَوجيه واضح بَدل صَفحة فارِغة.
  if (cryptoReady.data && !cryptoReady.data.ready) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-base inline-flex items-center gap-2">
              <KeyRound aria-hidden className="size-5 text-amber-600" />
              مُفتاح التَشفير غَير مَضبوط
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              لإدارة tokens التَكاملات بأَمان داخل النِظام، يَلزم تَوليد مُفتاح تَشفير 32-byte مَرة واحدة:
            </p>
            <pre dir="ltr" className="bg-muted border rounded-md p-3 text-xs overflow-x-auto"><code>{`# على VPS:
openssl rand -hex 32

# أَضف لـ .env:
INTEGRATIONS_ENCRYPTION_KEY=<النَتيجة>

# أَعد تَشغيل النِظام:
pnpm prod:deploy
`}</code></pre>
            <div className="text-xs text-muted-foreground inline-flex items-start gap-1.5">
              <AlertCircle aria-hidden className="size-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
              <span>لا تُغَيّر المُفتاح بَعد ضَبطه — يَكسر كل secrets المُخَزَّنة. خُذ نُسخة احتياطية أَوَّلاً.</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="تَكاملات القَنوات"
        description="إدارة tokens WhatsApp/Instagram/المتجر — مُشَفَّرة AES-256-GCM داخل DB. لا حاجة لـSSH."
        actions={
          <Button onClick={() => setShowNew(true)} disabled={branches.length === 0}>
            <Plus aria-hidden className="size-4 me-1" /> إضافة تَكامل
          </Button>
        }
      />

      <ImageStudioIntegrationCard />

      {cryptoReady.isLoading || list.isLoading ? (
        <LoadingState />
      ) : list.data?.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 space-y-3">
            <div className="size-16 rounded-full bg-muted mx-auto grid place-items-center">
              <KeyRound aria-hidden className="size-7 text-muted-foreground" />
            </div>
            <div className="text-sm text-muted-foreground">
              لا تَكاملات بَعد. اِضغط «إضافة تَكامل» لِبَدء WhatsApp/Instagram/المتجر.
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.data?.map((integ) => (
            <IntegrationCard key={integ.id} integ={integ} onChanged={() => list.refetch()} />
          ))}
        </div>
      )}

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
