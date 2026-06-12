/**
 * Stocktakes — قائمة جلسات الجرد والتسوية (/stocktakes).
 *
 * شريحة «الجرد والتسوية» (W3) — مرجع التصميم: jrd-sessions.jsx من حزمة التسليم.
 * تعرض: مؤشرات الدورة، شريط الخطوات، جدول الجلسات مع فلاتر الحالة/الفرع،
 * بطاقة الجرد الدوري المقترح (ABC)، مؤشر دقة المخزون IRA (مدير+)،
 * بطاقة انحرافات التدقيق المالي (مدير النظام)، وجدول الصلاحيات الإداري.
 *
 * الصلاحيات (تجميل واجهة فقط — الخادم يحجب فعلياً):
 *   - إنشاء جلسة: admin/manager/warehouse (warehouseProcedure).
 *   - المراجعة/التقرير/IRA: admin/manager (managerProcedure).
 *   - فحص التوافق المالي reconcile: admin فقط (adminProcedure) — لغيره إحالة نصية.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ListToolbar } from "@/components/list";
import { fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";

/* ───────────────────────── ثوابت العرض ───────────────────────── */

type StStatus = "COUNTING" | "REVIEW" | "APPROVED" | "CANCELLED";
type StScope = "FULL" | "MOVING" | "CATEGORY" | "MANUAL";

const STATUS_BADGE: Record<StStatus, { label: string; cls: string }> = {
  COUNTING: { label: "قيد العدّ", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  REVIEW: { label: "قيد المراجعة", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  APPROVED: { label: "معتمدة ومُسوّاة", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  CANCELLED: { label: "ملغاة", cls: "bg-rose-50 text-rose-700 border-rose-200" },
};

const SCOPE_TYPE_LABEL: Record<StScope, string> = {
  FULL: "جرد شامل للفرع",
  MOVING: "الأصناف المتحركة",
  CATEGORY: "حسب الفئة",
  MANUAL: "أصناف مختارة",
};

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/* أرقام لاتينية دائماً (123456789). */
const nf = (n: number | null | undefined) => Number(n ?? 0).toLocaleString("ar-IQ-u-nu-latn");

const toDate = (v: string | Date | null | undefined): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(v);
const dOnly = (v: string | Date | null | undefined): string => {
  const d = toDate(v);
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("ar-IQ-u-nu-latn", { dateStyle: "medium" }) : "—";
};
const dt = (v: string | Date | null | undefined): string => {
  const d = toDate(v);
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString("ar-IQ-u-nu-latn", { dateStyle: "medium", timeStyle: "short" })
    : "—";
};

/* ─────────────── أشكال مخرجات العقد (stocktake-contract §٣) ─────────────── */

interface SessionRow {
  id: number;
  code: string;
  name: string;
  branchId: number;
  branchName: string;
  scopeType: StScope;
  scopeLabel: string;
  status: StStatus;
  itemCount: number;
  countedCount: number;
  createdAt: string | Date;
  createdByName: string;
  submittedAt: string | Date | null;
  approvedAt: string | Date | null;
}

interface CycleRow {
  variantId: number;
  productName: string;
  variantName: string | null;
  sku: string;
  abc: "A" | "B" | "C";
  freqDays: number;
  freqLabel: string;
  lastCountedAt: string | Date | null;
  daysOver: number | null;
  /** القيمة السنوية — يعيدها الخادم للمدير+ فقط. */
  annualValue?: string;
}

interface IraData {
  branches: Array<{ branchId: number; name: string; months: Array<{ ym: string; ira: number }> }>;
  workers: Array<{ name: string; accuracy: number; counts: number }>;
}

/** يطبّع مخرجاً قد يكون مصفوفة أو {rows} — تسامح حدودي أثناء التكامل المتوازي. */
function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object" && Array.isArray((v as { rows?: unknown }).rows)) {
    return (v as { rows: T[] }).rows;
  }
  return [];
}

/**
 * يبني رابط «/stocktakes/new» مع تمرير قائمة الأصناف المختارة.
 * لقوائم كبيرة (>200) يُخزَّن المصفوف في sessionStorage بمفتاح فريد ويُمرَّر prefillKey
 * بدل سلسلة معرّفات عملاقة في الـURL (تتجاوز حدود طول العنوان على آلاف الأصناف).
 */
function buildNewSessionUrl(ids: number[], name: string): string {
  const nameParam = `&name=${encodeURIComponent(name)}`;
  if (ids.length > 200) {
    try {
      const key = `stk_prefill_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      sessionStorage.setItem(key, JSON.stringify(ids));
      return `/stocktakes/new?prefillKey=${encodeURIComponent(key)}${nameParam}`;
    } catch {
      /* تعذّر التخزين — نسقط إلى تمرير القائمة في الـURL */
    }
  }
  return `/stocktakes/new?variants=${ids.join(",")}${nameParam}`;
}

function StatusBadge({ status }: { status: StStatus }) {
  const s = STATUS_BADGE[status] ?? STATUS_BADGE.COUNTING;
  return (
    <span className={`inline-block whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${s.cls}`}>
      {s.label}
    </span>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "blue" | "amber" }) {
  const toneCls = tone === "blue" ? "text-blue-700" : tone === "amber" ? "text-amber-700" : "";
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`mt-1 text-xl font-bold tabular-nums ${toneCls}`}>{value}</p>
        {sub ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

/* ───────────────────────── الصفحة ───────────────────────── */

export default function Stocktakes() {
  const [, navigate] = useLocation();
  const [status, setStatus] = useState<"" | StStatus>("");
  const [branchId, setBranchId] = useState<number>(0);
  const [page, setPage] = useState(0);
  const limit = 50;

  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  /** warehouseProcedure = admin + manager + warehouse. */
  const canCreate = role === "admin" || role === "manager" || role === "warehouse";
  const isManagerPlus = role === "admin" || role === "manager";
  const isAdmin = role === "admin";

  const branches = trpc.branches.list.useQuery();
  const statsQ = trpc.stocktakes.stats.useQuery(undefined, { enabled: canCreate });
  const listQ = trpc.stocktakes.list.useQuery(
    {
      status: status || undefined,
      branchId: branchId || undefined,
      limit,
      offset: page * limit,
    },
    { enabled: canCreate }
  );
  const cycleQ = trpc.stocktakes.cycleSuggestions.useQuery(
    { branchId: branchId || undefined },
    { enabled: canCreate }
  );
  const iraQ = trpc.stocktakes.ira.useQuery(undefined, { enabled: isManagerPlus });
  // فحص التوافق المالي — adminProcedure؛ لغير المدير لا نستدعيه (نعرض الإحالة فقط).
  const reconQ = trpc.reports.reconcile.useQuery(undefined, { enabled: isAdmin });

  const rows = useMemo(() => asArray<SessionRow>(listQ.data), [listQ.data]);
  const stats = (statsQ.data ?? {}) as { counting?: number; review?: number };
  const due = useMemo(() => {
    const list = asArray<CycleRow>(cycleQ.data);
    // الأقدم تأخيراً أولاً؛ «لم يُجرد بعد» (null) في المقدمة — نفس ترتيب النموذج المرجعي.
    return [...list].sort((a, b) => (b.daysOver ?? 9999) - (a.daysOver ?? 9999));
  }, [cycleQ.data]);

  const lastApproved = useMemo(() => {
    let best: SessionRow | null = null;
    for (const r of rows) {
      if (r.status !== "APPROVED" || !r.approvedAt) continue;
      if (!best || (toDate(r.approvedAt)?.getTime() ?? 0) > (toDate(best.approvedAt)?.getTime() ?? 0)) best = r;
    }
    return best;
  }, [rows]);

  /* غير مخوَّل (كاشير/مستخدم عام): الخادم يرفض أصلاً — نعرض توجيهاً واضحاً بدل أخطاء. */
  if (me.data && !canCreate) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">الجرد والتسوية</h1>
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            وحدة الجرد والتسوية متاحة لأدوار المخزن والإدارة فقط.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* الترويسة */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">الجرد والتسوية</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            جلسات جرد مُوثّقة بخطوات واضحة: تحديد النطاق ← عدّ أعمى ← مراجعة وتدقيق ← اعتماد التسوية ← تقرير نهائي.
          </p>
        </div>
        {canCreate && (
          <Button asChild size="lg">
            <Link href="/stocktakes/new">+ جلسة جرد جديدة</Link>
          </Button>
        )}
      </div>

      {/* شريط خطوات الدورة */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            {[
              "1 إنشاء الجلسة وتحديد النطاق",
              "2 العدّ الميداني (أعمى)",
              "3 المراجعة والتدقيق",
              "4 الاعتماد والتسوية",
              "5 التقرير النهائي",
            ].map((s, i) => (
              <span key={s} className="flex items-center gap-2">
                {i > 0 && <span className="text-border">←</span>}
                <span className="rounded-full border border-border bg-muted px-3 py-1.5">{s}</span>
              </span>
            ))}
            <span className="mr-auto font-normal text-muted-foreground">
              الفروقات ضمن الحدّ تُعتمد مباشرة، وما يتجاوزه يستوجب قرار مشرف أو إعادة عدّ.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* المؤشرات */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="جلسات قيد العدّ الآن" value={statsQ.isLoading ? "…" : nf(stats.counting)} tone="blue" />
        <Stat label="بانتظار المراجعة والاعتماد" value={statsQ.isLoading ? "…" : nf(stats.review)} tone="amber" />
        <Stat
          label="آخر جرد معتمد"
          value={lastApproved ? dOnly(lastApproved.approvedAt) : "—"}
          sub={lastApproved ? lastApproved.name : ""}
        />
        <Stat
          label="أصناف مستحقة للجرد الدوري"
          value={cycleQ.isLoading ? "…" : nf(due.length)}
          sub="حسب تصنيف ABC ودوريّاته"
        />
      </div>

      {/* جدول الجلسات */}
      <Card>
        <CardHeader>
          <ListToolbar
            title="جلسات الجرد"
            count={rows.length}
            loading={listQ.isLoading}
            filters={
              <>
                <select
                  className={selectCls}
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value as "" | StStatus);
                    setPage(0);
                  }}
                  aria-label="الحالة"
                >
                  <option value="">كل الحالات</option>
                  <option value="COUNTING">قيد العدّ</option>
                  <option value="REVIEW">قيد المراجعة</option>
                  <option value="APPROVED">معتمدة ومُسوّاة</option>
                  <option value="CANCELLED">ملغاة</option>
                </select>
                <select
                  className={selectCls}
                  value={branchId}
                  onChange={(e) => {
                    setBranchId(Number(e.target.value));
                    setPage(0);
                  }}
                  aria-label="الفرع"
                >
                  <option value={0}>كل الفروع</option>
                  {(branches.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </>
            }
            exportSpec={{
              filename: "جلسات الجرد",
              rows,
              columns: [
                { key: "code", header: "الرقم" },
                { key: "name", header: "الجلسة" },
                { key: "branchName", header: "الفرع" },
                { key: "scopeType", header: "النطاق", map: (r) => SCOPE_TYPE_LABEL[r.scopeType] ?? r.scopeType },
                { key: "scopeLabel", header: "تفصيل النطاق" },
                { key: "status", header: "الحالة", map: (r) => STATUS_BADGE[r.status]?.label ?? r.status },
                { key: "itemCount", header: "أصناف النطاق" },
                { key: "countedCount", header: "المعدود" },
                { key: "createdByName", header: "أنشأها" },
                { key: "createdAt", header: "تاريخ الإنشاء", map: (r) => dOnly(r.createdAt) },
                { key: "submittedAt", header: "تسليم العدّ", map: (r) => dOnly(r.submittedAt) },
                { key: "approvedAt", header: "الاعتماد", map: (r) => dOnly(r.approvedAt) },
              ],
            }}
          />
          <p className="text-xs text-muted-foreground">
            كل جلسة تُسوّى بقيد واحد مرجعي قابل للتدقيق في حركات المخزون.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-right text-xs text-muted-foreground">
                  <th className="p-2.5 font-semibold">الرقم</th>
                  <th className="p-2.5 font-semibold">الجلسة</th>
                  <th className="p-2.5 font-semibold">النطاق</th>
                  <th className="p-2.5 font-semibold">تقدم العدّ</th>
                  <th className="p-2.5 text-center font-semibold">الحالة</th>
                  <th className="p-2.5 font-semibold">التواريخ</th>
                  <th className="p-2.5 text-center font-semibold">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const total = Math.max(s.itemCount, 1);
                  const pct = Math.round((s.countedCount / total) * 100);
                  const action =
                    s.status === "COUNTING"
                      ? { label: "متابعة العدّ", href: `/stocktakes/${s.id}`, primary: false }
                      : s.status === "REVIEW"
                        ? isManagerPlus
                          ? { label: "مراجعة واعتماد", href: `/stocktakes/${s.id}/review`, primary: true }
                          : { label: "متابعة", href: `/stocktakes/${s.id}`, primary: false }
                        : s.status === "APPROVED"
                          ? isManagerPlus
                            ? { label: "التقرير", href: `/stocktakes/${s.id}/report`, primary: false }
                            : { label: "عرض", href: `/stocktakes/${s.id}`, primary: false }
                          : { label: "عرض", href: `/stocktakes/${s.id}`, primary: false };
                  return (
                    <tr key={s.id} className="border-t hover:bg-muted/40">
                      <td className="p-2.5 font-mono text-xs tabular-nums" dir="ltr">
                        {s.code}
                      </td>
                      <td className="p-2.5">
                        <p className="font-bold">{s.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {s.branchName} · أنشأها {s.createdByName}
                        </p>
                      </td>
                      <td className="p-2.5">
                        <span className="inline-block rounded-md border bg-muted px-2 py-0.5 text-xs font-semibold">
                          {SCOPE_TYPE_LABEL[s.scopeType] ?? s.scopeType}
                        </span>
                        <p className="mt-1 text-xs text-muted-foreground">{s.scopeLabel}</p>
                      </td>
                      <td className="min-w-[130px] p-2.5">
                        <div className="flex items-center gap-2">
                          <Progress value={pct} className="w-20" />
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {nf(s.countedCount)}/{nf(s.itemCount)}
                          </span>
                        </div>
                      </td>
                      <td className="p-2.5 text-center">
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="p-2.5 text-xs text-muted-foreground">
                        <p>إنشاء: {dOnly(s.createdAt)}</p>
                        {s.submittedAt ? <p>تسليم: {dOnly(s.submittedAt)}</p> : null}
                        {s.approvedAt ? <p>اعتماد: {dOnly(s.approvedAt)}</p> : null}
                      </td>
                      <td className="p-2.5 text-center">
                        <Button asChild size="sm" variant={action.primary ? "default" : "outline"}>
                          <Link href={action.href}>{action.label}</Link>
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {!listQ.isLoading && rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-muted-foreground">
                      لا جلسات جرد مطابقة. أنشئ جلسة جديدة أو غيّر الفلاتر.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ترقيم الصفحات (لا إجمالي من الخادم — التالي يُعطَّل عند صفحة ناقصة) */}
      {(page > 0 || rows.length === limit) && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            ← السابق
          </Button>
          <div className="text-muted-foreground">صفحة {nf(page + 1)}</div>
          <Button variant="outline" size="sm" disabled={rows.length < limit} onClick={() => setPage((p) => p + 1)}>
            التالي →
          </Button>
        </div>
      )}

      {/* الجرد الدوري + الدقة + ربط التدقيق المالي */}
      <div className="grid gap-4 xl:grid-cols-2">
        <CyclePlanCard
          due={due}
          loading={cycleQ.isLoading}
          canCreate={canCreate}
          isManagerPlus={isManagerPlus}
          onCreate={() => {
            const ids = due.map((d) => d.variantId);
            const name = `جرد دوري مجدول — ${new Date().toLocaleDateString("ar-IQ-u-nu-latn", { dateStyle: "medium" })}`;
            navigate(buildNewSessionUrl(ids, name));
          }}
        />
        <div className="space-y-4">
          {isManagerPlus && <IraCard data={(iraQ.data ?? null) as IraData | null} loading={iraQ.isLoading} />}
          {isManagerPlus && (
            <ReconDriftCard
              isAdmin={isAdmin}
              loading={reconQ.isLoading}
              inventory={isAdmin ? ((reconQ.data?.inventory ?? []) as Array<{ id: number; actual: string; drift: string }>) : []}
              runAt={isAdmin ? (reconQ.data?.runAt ?? null) : null}
              onCreate={(ids) => {
                navigate(buildNewSessionUrl(ids, "جرد تحقّق — انحرافات التدقيق المالي"));
              }}
            />
          )}
        </div>
      </div>

      {/* الصلاحيات والتحكمات الإدارية */}
      <Card>
        <CardHeader>
          <p className="text-base font-semibold">الصلاحيات والتحكمات الإدارية</p>
          <p className="text-xs text-muted-foreground">
            ما يستطيع كل دور فعله في دورة الجرد — مطبَّقة في الخادم وتنعكس على الواجهة.
          </p>
        </CardHeader>
        <CardContent className="p-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-right text-xs text-muted-foreground">
                  <th className="p-2 font-semibold">الإجراء</th>
                  <th className="p-2 text-center font-semibold">مدير النظام</th>
                  <th className="p-2 text-center font-semibold">مدير فرع</th>
                  <th className="p-2 text-center font-semibold">أمين مخزن</th>
                  <th className="p-2 text-center font-semibold">عامل جرد (رابط خارجي)</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["إنشاء جلسة وتوليد روابط العدّ", 1, 1, 1, 0],
                    ["العدّ وإدخال الكميات", 1, 1, 1, 1],
                    ["رؤية الرصيد الدفتري أثناء العدّ", 1, 1, 0, 0],
                    ["طلب إعادة عدّ ثانٍ", 1, 1, 1, 0],
                    ["تعديل حدود الاعتماد المباشر", 1, 1, 0, 0],
                    ["رؤية قيمة الفروقات بالتكلفة", 1, 1, 0, 0],
                    ["اعتماد التسوية النهائية", 1, 1, 0, 0],
                    ["إلغاء جلسة جارية", 1, 0, 0, 0],
                  ] as Array<[string, number, number, number, number]>
                ).map(([label, a, m, w, c]) => (
                  <tr key={label} className="border-t">
                    <td className="p-2">{label}</td>
                    {[a, m, w, c].map((v, i) => (
                      <td key={i} className="p-2 text-center">
                        {v ? (
                          <span className="font-bold text-emerald-600">✓</span>
                        ) : (
                          <span className="text-border">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ─────────── خطة الجرد الدوري (Cycle Counting — ABC) ─────────── */

function CyclePlanCard({
  due,
  loading,
  canCreate,
  isManagerPlus,
  onCreate,
}: {
  due: CycleRow[];
  loading: boolean;
  canCreate: boolean;
  isManagerPlus: boolean;
  onCreate: () => void;
}) {
  const shown = due.slice(0, 6);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-base font-semibold">الجرد الدوري المقترح (تصنيف ABC)</p>
            <p className="text-xs text-muted-foreground">
              فئة A (عالي القيمة/الحركة) شهرياً · B فصلياً · C نصف سنوياً — ربع ساعة أسبوعياً بدل جرد سنوي مرهق.
            </p>
          </div>
          <Button size="sm" disabled={!canCreate || due.length === 0} onClick={onCreate}>
            إنشاء جلسة للمستحق ({nf(due.length)})
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y">
          {shown.map((r) => (
            <div key={r.variantId} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span
                className={`grid size-7 shrink-0 place-items-center rounded-md text-xs font-bold ${
                  r.abc === "A"
                    ? "bg-rose-100 text-rose-700"
                    : r.abc === "B"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {r.abc}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  {r.productName}{" "}
                  {r.variantName ? <span className="font-normal text-muted-foreground">{r.variantName}</span> : null}
                  <span className="mr-1 font-mono text-[11px] font-normal text-muted-foreground" dir="ltr">
                    {r.sku}
                  </span>
                </p>
                <p className="text-[11px] text-muted-foreground">
                  دوريّته: {r.freqLabel} · آخر جرد: {r.lastCountedAt ? dOnly(r.lastCountedAt) : "لم يُجرد بعد"}
                  {isManagerPlus && r.annualValue ? <> · قيمة سنوية: {fmt(r.annualValue)} د.ع</> : null}
                </p>
              </div>
              <span
                className={`inline-block whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                  r.daysOver == null || r.daysOver > 60
                    ? "bg-rose-50 text-rose-700 border-rose-200"
                    : "bg-amber-50 text-amber-800 border-amber-200"
                }`}
              >
                {r.daysOver == null ? "لم يُجرد" : `متأخر ${nf(r.daysOver)} يوماً`}
              </span>
            </div>
          ))}
          {loading && <p className="p-6 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>}
          {!loading && due.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">✓ لا أصناف مستحقة — الخطة الدورية مكتملة.</p>
          )}
          {due.length > shown.length && (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              …و{nf(due.length - shown.length)} أصناف أخرى مستحقة — تُضمّ كلها للجلسة.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────── مؤشر دقة المخزون IRA (مدير+) ─────────── */

function IraCard({ data, loading }: { data: IraData | null; loading: boolean }) {
  const branches = data?.branches ?? [];
  const workers = data?.workers ?? [];
  return (
    <Card>
      <CardHeader>
        <p className="text-base font-semibold">دقة سجلات المخزون (IRA)</p>
        <p className="text-xs text-muted-foreground">
          نسبة الأصناف المطابقة تماماً في الجرد — تُحدّث مع كل جلسة معتمدة.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {loading && <p className="py-4 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>}
        {!loading && branches.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">
            تُحتسب الدقة بعد اعتماد أول جلسة جرد.
          </p>
        )}
        {branches.map((b) => {
          const months = b.months ?? [];
          const cur = months.length ? months[months.length - 1].ira : null;
          return (
            <div key={b.branchId}>
              <div className="mb-1 flex items-baseline justify-between text-sm">
                <span className="font-semibold">{b.name}</span>
                <span
                  className={`font-bold tabular-nums ${
                    cur != null && cur >= 95 ? "text-emerald-700" : "text-amber-700"
                  }`}
                >
                  {cur == null ? "—" : `${cur.toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 1 })}٪`}
                </span>
              </div>
              <div className="flex h-9 items-end gap-1">
                {months.map((m, i) => (
                  <div
                    key={m.ym}
                    className={`flex-1 rounded-sm ${i === months.length - 1 ? "bg-primary" : "bg-primary/20"}`}
                    title={`${m.ym}: ${m.ira.toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 1 })}٪`}
                    style={{ height: `${Math.max(8, (m.ira - 80) * 5)}%` }}
                  />
                ))}
                {months.length === 0 && <p className="text-xs text-muted-foreground">لا جلسات معتمدة لهذا الفرع بعد.</p>}
              </div>
            </div>
          );
        })}
        {workers.length > 0 && (
          <div className="border-t pt-3">
            <p className="mb-2 text-xs font-semibold text-muted-foreground">دقة عمّال الجرد (من الجلسات المعتمدة)</p>
            <div className="space-y-1.5">
              {workers.map((w) => (
                <div key={w.name} className="flex items-center gap-2 text-sm">
                  <span className="w-36 truncate" title={`${nf(w.counts)} عدّة معتمدة`}>
                    {w.name}
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${Math.max(0, Math.min(100, w.accuracy))}%` }}
                    />
                  </div>
                  <span className="w-14 text-left text-xs font-bold tabular-nums">
                    {w.accuracy.toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: 1 })}٪
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─────────── انحرافات تدقيق التوافق المالي ─────────── */

function ReconDriftCard({
  isAdmin,
  loading,
  inventory,
  runAt,
  onCreate,
}: {
  isAdmin: boolean;
  loading: boolean;
  inventory: Array<{ id: number; actual: string; drift: string }>;
  runAt: string | Date | null;
  onCreate: (ids: number[]) => void;
}) {
  const ids = Array.from(new Set(inventory.map((r) => r.id)));
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-base font-semibold">انحرافات من تدقيق التوافق المالي</p>
            <p className="text-xs text-muted-foreground">
              أصناف رصدها فحص التوافق المالي — حوّلها لجلسة جرد تحقّق بضغطة.
            </p>
          </div>
          {isAdmin && (
            <Button size="sm" variant="outline" disabled={ids.length === 0} onClick={() => onCreate(ids)}>
              أنشئ جلسة جرد لها
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {!isAdmin ? (
          <p className="p-6 text-sm text-muted-foreground">
            فحص التوافق المالي صلاحية مدير النظام — عند رصد انحرافات تُحال لجلسة جرد تحقّق من شاشة «تدقيق التوافق».
          </p>
        ) : loading ? (
          <p className="p-6 text-center text-sm text-muted-foreground">جارٍ الفحص…</p>
        ) : inventory.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">✓ لا انحرافات مخزون في آخر فحص.</p>
        ) : (
          <div className="divide-y">
            {inventory.slice(0, 6).map((d, i) => (
              <div key={`${d.id}-${i}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-rose-100 text-xs font-bold text-rose-700">
                  ⚠
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    متغيّر رقم <span className="font-mono tabular-nums" dir="ltr">{nf(d.id)}</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    رصيد سالب رُصد في الفحص الأخير (الرصيد الحالي: {nf(Number(d.actual))})
                  </p>
                </div>
                <Link
                  href={`/inventory-movements?q=${d.id}`}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  الحركات ↗
                </Link>
              </div>
            ))}
            {inventory.length > 6 && (
              <p className="px-4 py-2 text-xs text-muted-foreground">
                …و{nf(inventory.length - 6)} انحرافات أخرى — تُضمّ كلها للجلسة.
              </p>
            )}
            <p className="px-4 py-2 text-[11px] text-muted-foreground">
              آخر فحص: {dt(runAt)} ·{" "}
              <Link href="/reconcile" className="font-semibold text-primary hover:underline">
                فتح شاشة تدقيق التوافق ↗
              </Link>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
