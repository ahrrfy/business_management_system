/**
 * متابعة جلسة الجرد الحية — /stocktakes/:id
 * مرجع التصميم: jrd-sessions.jsx (قسم SessionMonitor) — hi-fi بمكونات النظام.
 * البيانات: trpc.stocktakes.monitor (refetchInterval 5000) + trpc.stocktakes.log (مدير+).
 *
 * ملاحظة للقائد/W1 (عقد الاستهلاك): هذه الشاشة تقرأ من مخرج monitor:
 *   session: { id, code, name, branchName, status, scopeType, scopeLabel?, blind, waNotify, createdAt, createdByName }
 *   assignments: [{ id, name, method, zone, status, total, counted, lastActivityAt }]
 *   recentCounts: [{ variantId, variantLabel, qty, kind, byName, at }]   ← variantId لازم لزرّ «إعادة عدّ»
 *   pendingRecounts: [{ variantId, variantLabel, reason, requestedByName }]
 *   conflicts: [{ variantId, variantLabel, qty1, by1, qty2, by2 }]
 */
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { confirm } from "@/lib/confirm";
import { openWhatsApp } from "@/lib/whatsapp";
import { fmtInt } from "@/lib/money";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import {
  Lock,
  AlertTriangle,
  RefreshCw,
  Link as LinkIcon,
  User,
  Mail,
  Key,
  Printer,
} from "lucide-react";

/* ───────── ثوابت العرض ───────── */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  COUNTING: { label: "قيد العدّ", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  REVIEW: { label: "قيد المراجعة", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  APPROVED: { label: "معتمدة ومُسوّاة", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  CANCELLED: { label: "ملغاة", cls: "bg-rose-50 text-rose-700 border-rose-200" },
};
const SCOPE_LABEL: Record<string, string> = {
  FULL: "جرد شامل للفرع",
  MOVING: "المنتجات المتحركة",
  CATEGORY: "حسب الفئة",
  MANUAL: "منتجات مختارة",
};
const KIND_META: Record<string, { label: string; cls: string }> = {
  FIRST: { label: "عدّ أول", cls: "bg-muted text-muted-foreground border-border" },
  RECOUNT: { label: "إعادة عدّ", cls: "bg-violet-50 text-violet-700 border-violet-200" },
  VERIFY: { label: "عدّ تحقّقي", cls: "bg-blue-50 text-blue-700 border-blue-200" },
};
const LOG_LABEL: Record<string, string> = {
  "stocktake.create": "إنشاء الجلسة وتحديد النطاق",
  "stocktake.count": "إدخال عدّ",
  "stocktake.requestRecount": "طلب إعادة عدّ",
  "stocktake.resolveConflict": "الفصل في تعارض عدَّين",
  "stocktake.decide": "قرار فرق (تسوية/إبقاء)",
  "stocktake.firstSign": "توقيع أول على الفروقات عالية القيمة",
  "stocktake.approve": "اعتماد الجلسة وتنفيذ التسوية",
  "stocktake.forceReview": "إغلاق العدّ يدوياً والانتقال للمراجعة",
  "stocktake.cancel": "إلغاء الجلسة",
  "stocktake.regeneratePin": "توليد PIN جديد لعامل",
  "stocktake.finish": "تسليم عدّ عامل",
};

/* ───────── أدوات تنسيق (أرقام لاتينية دائماً) ───────── */
const nf = (n: number | null | undefined) => fmtInt(n ?? 0);
const dt = (v: string | number | Date | null | undefined) =>
  v ? new Date(v).toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "medium", timeStyle: "short" }) : "—";
/** وقت نسبي مقروء: «قبل ٥ دقائق» — بأرقام لاتينية. */
function rel(v: string | number | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "قبل لحظات";
  if (mins < 60) return `قبل ${nf(mins)} دقيقة`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `قبل ${nf(hrs)} ساعة`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "أمس";
  if (days < 30) return `قبل ${nf(days)} يوماً`;
  return d.toLocaleDateString("ar-IQ-u-nu-latn", { dateStyle: "medium" });
}
async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status, cls: "bg-muted text-muted-foreground border-border" };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${m.cls}`}>
      {m.label}
    </span>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "blue" | "amber" | "emerald" | "rose" }) {
  const tones: Record<string, string> = {
    blue: "text-blue-700",
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
  };
  return (
    <Card className="p-4 gap-1">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${tone ? tones[tone] : ""}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

export default function StocktakeMonitor() {
  const params = useParams();
  const sessionId = Number(params.id);
  const idOk = Number.isFinite(sessionId) && sessionId > 0;
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const isAdmin = role === "admin";
  const isManager = isAdmin || role === "manager";
  const canView = isManager || role === "warehouse";

  // بحث في العدّات — يمرَّر q للخادم ليجد أي منتج معدود (لا آخر ٢٠ فقط)، مع debounce بسيط.
  const [countSearch, setCountSearch] = useState("");
  const [countQ, setCountQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setCountQ(countSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [countSearch]);

  // متابعة حية — تحديث كل ٥ ثوانٍ (العقد §٦).
  const monitor = trpc.stocktakes.monitor.useQuery(
    { sessionId, q: countQ || undefined },
    { enabled: idOk && canView, refetchInterval: 5000 },
  );
  // سجلّ الأحداث (تدقيق) — للمدير+ فقط.
  const log = trpc.stocktakes.log.useQuery(
    { sessionId },
    { enabled: idOk && isManager, refetchInterval: 10000 },
  );

  /* ───── حالة الحوارات ───── */
  const [recountFor, setRecountFor] = useState<{ variantId: number; label: string } | null>(null);
  const [recountReason, setRecountReason] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [newPin, setNewPin] = useState<{ name: string; pin: string } | null>(null);

  /* ───── الطفرات ───── */
  const requestRecount = trpc.stocktakes.requestRecount.useMutation({
    onSuccess: async () => {
      setRecountFor(null);
      setRecountReason("");
      notify.ok("أُرسل طلب إعادة العدّ", "سيظهر كمهمة أعلى شاشة العامل دون كشف الرصيد الدفتري.");
      await utils.stocktakes.monitor.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const forceReview = trpc.stocktakes.forceReview.useMutation({
    onSuccess: async () => {
      notify.ok("أُغلق العدّ وانتقلت الجلسة للمراجعة");
      await Promise.all([utils.stocktakes.monitor.invalidate(), utils.stocktakes.list.invalidate()]);
      navigate(`/stocktakes/${sessionId}/review`);
    },
    onError: (e) => notify.err(e),
  });
  const cancelSession = trpc.stocktakes.cancel.useMutation({
    onSuccess: async () => {
      setCancelOpen(false);
      notify.ok("أُلغيت الجلسة");
      await utils.stocktakes.list.invalidate();
      navigate("/stocktakes");
    },
    onError: (e) => notify.err(e),
  });
  const regenPin = trpc.stocktakes.regeneratePin.useMutation({
    onSuccess: async (r, vars) => {
      const a = monitor.data?.assignments.find((x: { id: number }) => x.id === vars.assignmentId);
      setNewPin({ name: a?.name ?? "العامل", pin: r.pin });
      await utils.stocktakes.monitor.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  /* ───── حواجز عرض مبكرة (بعد كل الـhooks) ───── */
  if (!idOk) return <div className="p-10 text-center text-muted-foreground">معرّف الجلسة غير صالح.</div>;
  if (me.isLoading || (canView && monitor.isLoading))
    return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (me.data && !canView)
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10 text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-full bg-muted text-muted-foreground">
          <Lock aria-hidden className="size-8" />
        </div>
        <p className="font-bold">متابعة الجرد صلاحية أمين مخزن فأعلى</p>
        <p className="text-sm text-muted-foreground">دورك الحالي لا يخوّلك الاطلاع على جلسات الجرد.</p>
        <Link href="/"><Button variant="outline">العودة للوحة التحكم</Button></Link>
      </div>
    );
  if (monitor.error)
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10 text-center">
        <p className="font-bold text-rose-700">تعذّر تحميل الجلسة</p>
        <p className="text-sm text-muted-foreground">{monitor.error.message}</p>
        <Link href="/stocktakes"><Button variant="outline">→ جلسات الجرد</Button></Link>
      </div>
    );
  if (!monitor.data) return <div className="p-10 text-center text-muted-foreground">الجلسة غير موجودة.</div>;

  const { session: s, assignments, recentCounts, pendingRecounts, conflicts } = monitor.data;
  const total = assignments.reduce((acc: number, a: { total: number }) => acc + a.total, 0);
  const counted = assignments.reduce((acc: number, a: { counted: number }) => acc + a.counted, 0);
  const pct = total > 0 ? Math.round((counted / total) * 100) : 0;
  const submittedCount = assignments.filter((a: { status: string }) => a.status === "SUBMITTED").length;
  const isCounting = s.status === "COUNTING";
  const scopeLabel = (s as unknown as { scopeLabel?: string }).scopeLabel ?? SCOPE_LABEL[s.scopeType] ?? s.scopeType;

  /* ───── أفعال ───── */
  async function onForceReview() {
    const ok = await confirm({
      variant: "warning",
      title: "إنهاء العدّ والانتقال للمراجعة",
      description: (
        <>
          سيُغلق العدّ الآن وتُعتبر كل التكليفات مُسلَّمة، وتنتقل الجلسة لقيد المراجعة.
          {counted < total && (
            <>
              {" "}
              التقدم الحالي <b>{nf(counted)} من {nf(total)}</b> — المنتجات غير المعدودة ستبقى بأرصدتها
              الدفترية (مراجعة جزئية).
            </>
          )}
        </>
      ),
      confirmText: "إنهاء العدّ",
    });
    if (!ok) return;
    forceReview.mutate({ sessionId });
  }

  async function onRegenPin(a: { id: number; name: string }) {
    const ok = await confirm({
      variant: "warning",
      title: "توليد PIN جديد",
      description: (
        <>
          سيُبطل رمز PIN الحالي للعامل <b>{a.name}</b> فوراً ويُستبدل برمز جديد يظهر <b>مرة واحدة</b> فقط.
        </>
      ),
      confirmText: "توليد",
    });
    if (!ok) return;
    regenPin.mutate({ assignmentId: a.id });
  }

  function remind(a: { name: string; zone: string | null; counted: number; total: number }) {
    const link = `${window.location.origin}/count/${s.code}`;
    openWhatsApp(
      null,
      [
        "تذكير بعدّ الجرد",
        `الجلسة: ${s.name} (${s.code})`,
        a.zone ? `المنطقة: ${a.zone}` : "",
        `تقدمك: ${nf(a.counted)} من ${nf(a.total)} منتجاً`,
        `رابط شاشة العدّ: ${link}`,
        "يرجى إكمال العدّ ثم تسليمه. شكراً.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async function copyCountLink() {
    const link = `${window.location.origin}/count/${s.code}`;
    const ok = await copyText(link);
    if (ok) notify.ok("نُسخ رابط بوابة العدّ", link);
    else notify.warn("تعذّر النسخ — انسخه يدوياً", link);
  }

  function submitRecount() {
    if (!recountFor) return;
    const reason = recountReason.trim();
    if (reason.length < 3) {
      notify.warn("سبب الطلب إلزامي (٣ أحرف على الأقل) — يُسجَّل في سجلّ التدقيق.");
      return;
    }
    requestRecount.mutate({ sessionId, variantId: recountFor.variantId, reason });
  }

  return (
    <div className="space-y-4">
      {/* مسار الرجوع */}
      <div className="flex items-center gap-2 text-sm">
        <Link href="/stocktakes" className="font-semibold text-primary hover:underline">
          → جلسات الجرد
        </Link>
        <span className="text-border">/</span>
        <span className="text-muted-foreground">{s.name}</span>
      </div>

      {/* الترويسة */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{s.name}</h1>
            <StatusBadge status={s.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="font-mono" dir="ltr">{s.code}</span> · {s.branchName} · {scopeLabel}
            {s.blind && (
              <span className="mr-2 inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-xs font-semibold text-violet-700">
                جرد أعمى
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (s.status === "COUNTING" || s.status === "REVIEW") && (
            <Button variant="destructive" size="sm" onClick={() => setCancelOpen(true)}>
              إلغاء الجلسة
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void copyCountLink()}>
            نسخ رابط العدّ
          </Button>
          <Link href={`/stocktakes/${sessionId}/sheets`}>
            <Button variant="outline" size="sm">
              <Printer aria-hidden className="size-4" /> قوائم عدّ ورقية
            </Button>
          </Link>
          {s.status === "APPROVED" && (
            <Link href={`/stocktakes/${sessionId}/report`}>
              <Button size="sm">المحضر والتقرير</Button>
            </Link>
          )}
          {(s.status === "REVIEW" || s.status === "APPROVED") && (
            <Link href={`/stocktakes/${sessionId}/review`}>
              <Button size="sm" variant={s.status === "REVIEW" ? "default" : "outline"}>
                {s.status === "REVIEW" ? "مراجعة واعتماد" : "شاشة المراجعة"}
              </Button>
            </Link>
          )}
          {isCounting && (
            <Button
              size="sm"
              variant={submittedCount === assignments.length ? "default" : "outline"}
              disabled={!isManager || forceReview.isPending}
              title={
                isManager
                  ? counted < total
                    ? "العدّ لم يكتمل — سينتقل كمراجعة جزئية"
                    : ""
                  : "إنهاء العدّ صلاحية مشرف فأعلى"
              }
              onClick={() => void onForceReview()}
            >
              {forceReview.isPending ? "جارٍ الإغلاق…" : "إنهاء العدّ والانتقال للمراجعة"}
            </Button>
          )}
        </div>
      </div>

      {s.status === "CANCELLED" && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-800">
          أُلغيت هذه الجلسة — لا عدّ ولا تسوية عليها.
        </div>
      )}

      {/* تعارضات وإعادات عدّ معلّقة */}
      {conflicts.length > 0 && (
        <div className="space-y-1 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-800">
          <p className="inline-flex items-center gap-1.5 font-bold">
            <AlertTriangle aria-hidden className="size-4" /> تعارض عدَّين على {nf(conflicts.length)} منتج — يحجب الاعتماد حتى يُفصل فيه:
          </p>
          {conflicts.map((c: { variantId: number; variantLabel: string; qty1: number; by1: string; qty2: number; by2: string }) => (
            <p key={c.variantId} className="text-xs">
              {c.variantLabel}: {c.by1} عدّ <b dir="ltr">{nf(c.qty1)}</b> — {c.by2} عدّ <b dir="ltr">{nf(c.qty2)}</b>
            </p>
          ))}
          {isManager && (
            <Link href={`/stocktakes/${sessionId}/review`} className="text-xs font-bold underline">
              الفصل في شاشة المراجعة ←
            </Link>
          )}
        </div>
      )}
      {pendingRecounts.length > 0 && (
        <div className="space-y-1 rounded-lg border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm text-violet-800">
          <p className="inline-flex items-center gap-1.5 font-bold">
            <RefreshCw aria-hidden className="size-4" /> {nf(pendingRecounts.length)} طلب إعادة عدّ بانتظار العامل:
          </p>
          {pendingRecounts.map((r: { variantId: number; variantLabel: string; reason: string; requestedByName: string }) => (
            <p key={r.variantId} className="text-xs">
              {r.variantLabel} — السبب: {r.reason} (طلبها {r.requestedByName})
            </p>
          ))}
        </div>
      )}

      {/* مؤشرات */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="تقدم العدّ" value={`${nf(counted)} / ${nf(total)}`} sub="منتج معدود" tone="blue" />
        <Stat label="نسبة الإنجاز" value={`${nf(pct)}٪`} />
        <Stat
          label="عمّال الجرد"
          value={nf(assignments.length)}
          sub={submittedCount > 0 ? `${nf(submittedCount)} سلّموا العدّ` : "الكل يعمل الآن"}
        />
        <Stat label="سياسة الحركة أثناء الجرد" value="البيع مستمر" sub="الحركات اللاحقة تُصحَّح آلياً في المراجعة" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* العمّال */}
        <Card className="gap-0 py-0">
          <CardHeader className="border-b px-4 py-4">
            <CardTitle className="text-base">عمّال الجرد وروابط العدّ</CardTitle>
            <p className="text-xs text-muted-foreground">كل عامل يرى منتجات منطقته فقط، دون الرصيد الدفتري.</p>
          </CardHeader>
          <div className="divide-y">
            {assignments.map(
              (a: {
                id: number;
                name: string;
                method: string;
                zone: string | null;
                status: string;
                total: number;
                counted: number;
                lastActivityAt: string | Date | null;
              }) => (
                <div key={a.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                    {a.name.trim().slice(0, 2)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 font-bold">
                      {a.name}
                      {a.status === "SUBMITTED" ? (
                        <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                          سلّم العدّ
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                          يعدّ الآن
                        </span>
                      )}
                      {a.method === "PIN" ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                          <LinkIcon aria-hidden className="size-3" /> رابط خارجي PIN
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                          <User aria-hidden className="size-3" /> حساب داخل النظام
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.zone ? <>المنطقة: {a.zone} · </> : null}آخر نشاط {rel(a.lastActivityAt)}
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <Progress
                        value={a.total > 0 ? Math.round((a.counted / a.total) * 100) : 0}
                        className={`w-36 ${a.status === "SUBMITTED" ? "[&>[data-slot=progress-indicator]]:bg-emerald-500" : ""}`}
                      />
                      <span className="text-xs tabular-nums text-muted-foreground" dir="ltr">
                        {nf(a.counted)}/{nf(a.total)}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    {isCounting && a.status !== "SUBMITTED" && (
                      <div className="flex flex-wrap justify-end gap-1">
                        {s.waNotify && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-emerald-700"
                            title="فتح واتساب برسالة تذكير جاهزة"
                            onClick={() => remind(a)}
                          >
                            <Mail aria-hidden className="size-4" /> تذكير واتساب
                          </Button>
                        )}
                        {a.method === "PIN" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={regenPin.isPending}
                            title="يُبطل الرمز الحالي ويولّد رمزاً جديداً يظهر مرة واحدة"
                            onClick={() => void onRegenPin(a)}
                          >
                            <Key aria-hidden className="size-4" /> PIN جديد
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        </Card>

        {/* آخر العدّات + السجلّ */}
        <div className="space-y-4">
          <Card className="gap-0 py-0">
            <CardHeader className="border-b px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">آخر الكميات المُدخلة</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {countQ
                      ? "نتائج البحث في كل العدّات — اطلب إعادة عدّ لأي منتج."
                      : `بثّ حيّ (آخر ${nf(20)}) — اسم العامل ووقت الإدخال، دون كشف الفروقات قبل المراجعة.`}
                  </p>
                </div>
                <input
                  value={countSearch}
                  onChange={(e) => setCountSearch(e.target.value)}
                  placeholder="بحث في العدّات: اسم / SKU…"
                  className="h-8 w-48 rounded-md border bg-card px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>
            </CardHeader>
            <div className="max-h-[420px] divide-y overflow-auto">
              {recentCounts.map(
                (
                  c: {
                    variantId: number;
                    variantLabel: string;
                    qty: number;
                    kind: string;
                    byName: string;
                    at: string | Date;
                    baseUnit?: string | null;
                  },
                  i: number,
                ) => {
                  const k = KIND_META[c.kind] ?? KIND_META.FIRST;
                  return (
                    <div key={`${c.variantId}-${i}`} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{c.variantLabel}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.byName} · {rel(c.at)}
                          {c.kind !== "FIRST" && (
                            <span className={`mr-1.5 inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-semibold ${k.cls}`}>
                              {k.label}
                            </span>
                          )}
                        </p>
                      </div>
                      <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs tabular-nums" dir="ltr">
                        {nf(c.qty)}
                        {c.baseUnit ? <span className="ml-1 font-sans text-muted-foreground">{c.baseUnit}</span> : null}
                      </span>
                      {isCounting && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-violet-700"
                          title="طلب إعادة عدّ لهذا المنتج (سبب إلزامي)"
                          onClick={() => {
                            setRecountReason("");
                            setRecountFor({ variantId: c.variantId, label: c.variantLabel });
                          }}
                        >
                          <RefreshCw aria-hidden className="size-4" />
                        </Button>
                      )}
                    </div>
                  );
                },
              )}
              {recentCounts.length === 0 && (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {countQ ? "لا عدّات مطابقة للبحث." : "لم تُدخل كميات بعد."}
                </p>
              )}
            </div>
          </Card>

          {isManager && (
            <Card className="gap-0 py-0">
              <CardHeader className="border-b px-4 py-4">
                <CardTitle className="text-base">سجلّ الجلسة (تدقيق)</CardTitle>
                <p className="text-xs text-muted-foreground">من فعل ماذا ومتى — يُكتب آلياً ولا يُعدَّل.</p>
              </CardHeader>
              <div className="max-h-[320px] divide-y overflow-auto">
                {(log.data ?? []).map(
                  (l: { at: string | Date; byName: string; action: string; detail?: string | null }, i: number) => (
                    <div key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/50"></span>
                      <div>
                        <p>
                          {LOG_LABEL[l.action] ?? l.action}
                          {l.detail && <span className="text-muted-foreground"> — {l.detail}</span>}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {l.byName} · {dt(l.at)}
                        </p>
                      </div>
                    </div>
                  ),
                )}
                {log.data && log.data.length === 0 && (
                  <p className="p-6 text-center text-sm text-muted-foreground">لا أحداث مسجّلة بعد.</p>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* حوار طلب إعادة العدّ — سبب إلزامي */}
      <Dialog open={recountFor != null} onOpenChange={(o) => { if (!o) setRecountFor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>طلب إعادة عدّ ثانية</DialogTitle>
            <DialogDescription>
              سيظهر المنتج <b className="text-foreground">{recountFor?.label}</b> كمهمة إعادة عدّ في شاشة
              العامل، دون كشف الرصيد الدفتري أو سبب الفرق له.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>سبب الطلب (إلزامي — يُسجَّل في سجلّ التدقيق)</Label>
            <Textarea
              rows={2}
              value={recountReason}
              onChange={(e) => setRecountReason(e.target.value)}
              placeholder="مثال: فرق عالي القيمة — تأكيد العدّ"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRecountFor(null)}>إلغاء</Button>
            <Button onClick={submitRecount} disabled={requestRecount.isPending}>
              {requestRecount.isPending ? "جارٍ الإرسال…" : "إرسال الطلب للعامل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار إلغاء الجلسة — admin فقط */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>إلغاء جلسة الجرد</DialogTitle>
            <DialogDescription>
              ستُلغى الجلسة <b className="text-foreground" dir="ltr">{s.code}</b> نهائياً — تبقى العدّات
              المسجّلة موثّقة للاطلاع، ولا تُنفَّذ أي تسوية على المخزون.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>سبب الإلغاء (اختياري — يُسجَّل في سجلّ التدقيق)</Label>
            <Textarea rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>رجوع</Button>
            <Button
              variant="destructive"
              disabled={cancelSession.isPending}
              onClick={() => cancelSession.mutate({ sessionId, reason: cancelReason.trim() || undefined })}
            >
              {cancelSession.isPending ? "جارٍ الإلغاء…" : "تأكيد إلغاء الجلسة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار عرض الـPIN الجديد — يظهر مرة واحدة */}
      <Dialog open={newPin != null} onOpenChange={(o) => { if (!o) setNewPin(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>رمز PIN الجديد</DialogTitle>
            <DialogDescription>
              للعامل <b className="text-foreground">{newPin?.name}</b> — يظهر هذه المرة فقط، انسخه وسلّمه له
              عبر قناة آمنة.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-lg border border-dashed bg-muted py-4 text-center font-mono text-3xl font-bold tracking-[0.5em]" dir="ltr">
            {newPin?.pin}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={async () => {
                if (!newPin) return;
                const link = `${window.location.origin}/count/${s.code}`;
                const ok = await copyText(`رابط العدّ: ${link}\nPIN: ${newPin.pin}`);
                notify[ok ? "ok" : "warn"](ok ? "نُسخ الرابط مع الرمز" : "تعذّر النسخ — انسخه يدوياً");
              }}
            >
              نسخ الرابط + الرمز
            </Button>
            <Button onClick={() => setNewPin(null)}>تم</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
