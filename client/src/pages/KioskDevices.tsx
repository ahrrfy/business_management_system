/**
 * شاشة إدارة **أجهزة الكشك الخارجية** (قارئ الأسعار) — للمدير فقط.
 *
 * إنشاء جهاز ⇒ يُعرض الرمز الخام **مرّة واحدة** + زر تنزيل المُشغّل (.cmd) + الرابط.
 * الرمز لا يُسترجَع بعدها (مخزَّن مُجزّأً)؛ لاستبداله: «تدوير الرمز». الإلغاء فوري على الخادم.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { downloadInstallerCmd, kioskUrl } from "@/lib/kioskLauncher";
import { confirm, confirmDelete } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { fmtDateTime, toDate, type DateInput } from "@/lib/date";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { internalUrl } from "@/lib/siteHosts";
import { Download, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ListToolbar, RowActions, FilterField } from "@/components/list";
import { useUrlFilters } from "@/hooks/useUrlFilters";

/** فرزٌ زمنيّ على الطابع الخامّ: نصّ العرض «21/06/2026» يُفرَز باليوم لا بالتاريخ. */
const cmpTime = (a: DateInput, b: DateInput) => {
  const ta = toDate(a)?.getTime() ?? -Infinity;
  const tb = toDate(b)?.getTime() ?? -Infinity;
  return ta === tb ? 0 : ta < tb ? -1 : 1;
};

type Reveal = { deviceId: number; label: string; branchName: string | null; rawToken: string };
/** صفُّ جهاز كشك — مشتقٌّ من عقد `kiosk.devices.list`. */
type KioskDeviceRow = RouterOutputs["kiosk"]["devices"]["list"][number];

// أصل الخادم المحقون في مُشغّل الكشك: **دومين الشركة** حتماً (سياسة الدومينَين) — لا المضيف
// الذي صادف أن المدير يتصفّحه، فالجهاز يعمل بلا إشراف ولا يصحّ أن يمرّ بتحويل بين الدومينَين.
const origin = internalUrl();

function copy(text: string, msg: string) {
  navigator.clipboard?.writeText(text).then(() => notify.ok(msg)).catch(() => notify.err("تعذّر النسخ"));
}

export default function KioskDevices() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const branches = branchesQ.data ?? [];
  const devicesQ = trpc.kiosk.devices.list.useQuery();
  const devices = devicesQ.data ?? [];
  const [f, setF, resetF] = useUrlFilters({ q: "", status: "", branch: "" });
  const visibleDevices = useMemo(() => {
    const q = f.q.trim().toLocaleLowerCase("ar");
    return devices.filter((d) => {
      if (q && ![d.label, d.branchName, d.tokenPrefix].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) return false;
      if (f.status === "active" && !d.isActive) return false;
      if (f.status === "inactive" && d.isActive) return false;
      if (f.branch && String(d.branchId) !== f.branch) return false;
      return true;
    });
  }, [devices, f.q, f.status, f.branch]);
  const activeFilterCount = (f.status ? 1 : 0) + (f.branch ? 1 : 0);

  const [branchId, setBranchId] = useState<number | "">("");

  const [label, setLabel] = useState("");
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const create = trpc.kiosk.devices.create.useMutation({
    onSuccess: (data) => {
      const bName = branches.find((b) => b.id === branchId)?.name ?? null;
      setReveal({ deviceId: data.id, label: label.trim(), branchName: bName, rawToken: data.rawToken });
      setLabel("");
      notify.ok("أُنشئ الجهاز — احفظ الرمز الآن (يظهر مرّة واحدة)");
      void utils.kiosk.devices.list.invalidate();
    },
    onError: (e) => notify.err(e.message),
  });

  const rotate = trpc.kiosk.devices.rotate.useMutation({
    onSuccess: (data, vars) => {
      const dev = devices.find((d) => d.id === vars.id);
      setReveal({ deviceId: vars.id, label: dev?.label ?? "", branchName: dev?.branchName ?? null, rawToken: data.rawToken });
      notify.ok("دُوِّر الرمز — الرمز القديم أُبطِل");
      void utils.kiosk.devices.list.invalidate();
    },
    onError: (e) => notify.err(e.message),
  });

  const setActive = trpc.kiosk.devices.setActive.useMutation({
    onSuccess: () => { void utils.kiosk.devices.list.invalidate(); },
    onError: (e) => notify.err(e.message),
  });

  const remove = trpc.kiosk.devices.remove.useMutation({
    onSuccess: () => { notify.ok("حُذف الجهاز"); void utils.kiosk.devices.list.invalidate(); },
    onError: (e) => notify.err(e.message),
  });

  // أعمدة الأجهزة — داخل المكوّن (وقبل الخروج المبكّر للصلاحية) لأنّ الإجراءات تستدعي الطفرات.
  const deviceColumns = useMemo<ColumnDef<KioskDeviceRow, unknown>[]>(() => [
    { id: "label", header: "الجهاز", accessorFn: (d) => d.label, meta: { width: "wide" }, cell: ({ row }) => <span className="font-medium">{row.original.label}</span> },
    { id: "branchName", header: "الفرع", accessorFn: (d) => d.branchName ?? "—", cell: ({ row }) => row.original.branchName ?? "—" },
    { id: "tokenPrefix", header: "الرمز", accessorFn: (d) => `${d.tokenPrefix}…`, meta: { kind: "code" }, cell: ({ row }) => <span className="text-xs">{row.original.tokenPrefix}…</span> },
    {
      id: "isActive",
      header: "الحالة",
      accessorFn: (d) => (d.isActive ? "مفعّل" : "مُلغى"),
      meta: { kind: "status" },
      cell: ({ row }) =>
        row.original.isActive ? (
          <span className="inline-flex items-center gap-1 text-[var(--status-active)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--status-active)]" />مفعّل</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-destructive"><span className="h-1.5 w-1.5 rounded-full bg-destructive" />مُلغى</span>
        ),
    },
    // «آخر ظهور» يُفرَز لاصطياد الأجهزة الميتة ⇒ الفرز على الطابع الخامّ لا على نصّ العرض.
    { id: "lastSeenAt", header: "آخر ظهور", accessorFn: (d) => fmtDateTime(d.lastSeenAt), meta: { kind: "datetime" }, sortingFn: (a, b) => cmpTime(a.original.lastSeenAt, b.original.lastSeenAt), cell: ({ row }) => <span className="text-xs text-muted-foreground">{fmtDateTime(row.original.lastSeenAt)}</span> },
    {
      id: "actions",
      header: "إجراءات",
      enableSorting: false,
      meta: { kind: "actions" },
      cell: ({ row }) => {
        const d = row.original;
        return (
          <RowActions
            mode="menu"
            actions={[
              {
                key: "rotate",
                kind: "approve",
                label: "تدوير الرمز",
                disabled: rotate.isPending,
                disabledReason: "توجد عملية تدوير قيد التنفيذ",
                onSelect: () => void (async () => {
                  if (!(await confirm({ variant: "warning", title: "تدوير رمز الجهاز", description: `تدوير الرمز يُبطل الرمز القديم لجهاز «${d.label}». متابعة؟`, confirmText: "تدوير الرمز" }))) return;
                  rotate.mutate({ id: d.id });
                })(),
                gate: { adminOnly: true },
              },
              {
                key: "toggle",
                kind: "approve",
                label: d.isActive ? "إلغاء" : "تفعيل",
                variant: d.isActive ? "destructive" : "default",
                disabled: setActive.isPending,
                disabledReason: "توجد عملية تحديث قيد التنفيذ",
                onSelect: () => setActive.mutate({ id: d.id, active: !d.isActive }),
                gate: { adminOnly: true },
              },
              {
                key: "delete",
                kind: "delete",
                label: "حذف",
                variant: "destructive",
                disabled: remove.isPending,
                disabledReason: "توجد عملية حذف قيد التنفيذ",
                onSelect: () => void (async () => {
                  if (!(await confirmDelete({ description: `حذف الجهاز «${d.label}» نهائياً يلغي رمزه فوراً ويعطّل الشاشة.` }))) return;
                  remove.mutate({ id: d.id });
                })(),
                gate: { adminOnly: true },
              },
            ]}
          />
        );
      },
    },
  ], [rotate, setActive, remove]);

  if (me.data && me.data.role !== "admin") {
    return <div className="p-10 text-center text-muted-foreground">هذه الشاشة للمدير فقط.</div>;
  }

  function submitCreate() {
    if (!branchId || typeof branchId !== "number") return notify.err("اختر الفرع");
    if (!label.trim()) return notify.err("أدخل اسم الجهاز");
    create.mutate({ branchId, label: label.trim() });
  }

  // طباعة A4 بهوية المستند بدل window.print() (كان يطبع الصفحة كاملةً ببطاقة المُشغّل ونموذج
  // الإضافة وأشرطة الأدوات). ممنوعٌ قطعاً غير **بادئة الرمز** كما تعرضها الشاشة — الرمز الخام لا يدخل
  // المستند إطلاقاً (`visibleDevices` لا يحمله أصلاً؛ هو في حالة `reveal` المستقلّة).
  function printDevices() {
    const branchName = branches.find((b) => String(b.id) === f.branch)?.name;
    printReportDoc({
      title: "أجهزة قارئ الأسعار",
      headerExtra: [
        { label: "عدد الأجهزة", value: visibleDevices.length.toLocaleString("ar-IQ-u-nu-latn") },
        { label: "الفرع", value: branchName ?? "كل الفروع" },
        { label: "الحالة", value: f.status === "active" ? "مفعّل" : f.status === "inactive" ? "مُلغى" : "الكل" },
      ],
      columns: [
        { key: "label", label: "الجهاز" },
        { key: "branchName", label: "الفرع" },
        { key: "tokenPrefix", label: "الرمز" },
        { key: "isActive", label: "الحالة", align: "center" },
        { key: "lastSeenAt", label: "آخر ظهور" },
      ],
      rows: visibleDevices.map((d) => ({
        label: d.label,
        branchName: d.branchName ?? "—",
        tokenPrefix: `${d.tokenPrefix}…`,
        isActive: d.isActive ? "مفعّل" : "مُلغى",
        lastSeenAt: fmtDateTime(d.lastSeenAt),
      })),
      emptyText: "لا أجهزة مطابقة للفلاتر.",
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="شاشات قارئ الأسعار (الأجهزة الخارجية)"
        description={
          <>
            أجهزة مستقلّة تعرض الأسعار للزبون عبر المتصفّح بوضع كشك. كل جهاز يُصادَق برمز
            <b> للقراءة فقط</b> مربوط بفرع — لا يرى التكلفة ولا المخزون، وقابل للإلغاء فوراً.
          </>
        }
      />

      {/* المُشغّل الكوني — يُنزَّل مرّة، يُنسَخ على كل جهاز، يُلصَق فيه الرمز */}
      <Card className="border-primary/40 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">مُشغّل الكشك (ملف واحد لكل الأجهزة)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="list-decimal pr-5 space-y-1.5 text-sm text-muted-foreground marker:text-foreground/70">
            <li>نزّل الملف مرّةً واحدة أدناه ← انسخه على كل جهاز شاشة.</li>
            <li>شغّله على الجهاز ← الصق <b>رمز الجهاز</b> (من أدناه) ← Enter.</li>
            <li>يفعّل الجهاز فوراً، يفتح ملء الشاشة، ويُثبّت نفسه للإقلاع التلقائي (تأخير 120 ثانية بعد كل تشغيل للوندوز).</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button className="inline-flex items-center gap-1.5" onClick={() => downloadInstallerCmd({ origin })}>
              <Download aria-hidden className="size-4" />تنزيل مُشغّل الكشك (.cmd)
            </Button>
            <span className="text-xs text-muted-foreground self-center">
              الخادم مضمَّن في الملف — لا حاجة لأي إعداد يدوي على جهاز الشاشة.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* الرمز المكشوف مرّة واحدة — يبقى `print:hidden` **حزاماً ثانياً**: زرّ «طباعة» أدناه صار
          يبني مستند A4 من صفوف الجدول (بادئة الرمز فقط) لا من الصفحة، لكنّ طباعة المتصفّح
          المباشرة (Ctrl+P) تبقى ممكنةً دائماً — ولا يصحّ أن يخرج الرمز السرّي الخام على الورق أبداً. */}
      {reveal && (
        <Card className="border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)]/60 print:hidden">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base text-[var(--sem-pos)]">
              رمز الجهاز «{reveal.label}» — يظهر مرّة واحدة فقط
            </CardTitle>
            <button className="text-muted-foreground hover:text-foreground" onClick={() => setReveal(null)} aria-label="إغلاق"><X aria-hidden className="size-5" /></button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md bg-[var(--sem-warn-bg)] border border-[var(--sem-warn)]/40 p-3 text-xs text-[var(--sem-warn)]">
              انسخ الرمز الآن — لن يظهر ثانيةً. الصقه في مُشغّل الكشك على الجهاز عند طلب «الرمز».
              إن فقدته: «تدوير الرمز» يُصدر رمزاً جديداً ويُبطل القديم فوراً.
            </div>

            <div className="grid gap-3 lg:grid-cols-2 items-start">
              <div className="space-y-1">
                <Label className="text-xs">رمز الجهاز (الصقه في المُشغّل)</Label>
                <div className="flex gap-2">
                  <Input readOnly dir="ltr" value={reveal.rawToken} className="font-mono text-xs" />
                  <Button variant="outline" size="sm" onClick={() => copy(reveal.rawToken, "نُسخ الرمز")}>نسخ</Button>
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">رابط الكشك المباشر (بديل يدوي — يحوي الرمز)</Label>
                <div className="flex gap-2">
                  <Input readOnly dir="ltr" value={kioskUrl(origin, reveal.rawToken)} className="font-mono text-xs" />
                  <Button variant="outline" size="sm" onClick={() => copy(kioskUrl(origin, reveal.rawToken), "نُسخ الرابط")}>نسخ</Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* إنشاء جهاز */}
      <Card>
        <CardHeader><CardTitle className="text-base">إضافة جهاز جديد</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">الفرع</Label>
            <AppSelect
              value={String(branchId)}
              onValueChange={(next) => setBranchId(next ? Number(next) : "")}
              className="h-9 border-input px-3 text-sm min-w-[180px]"
            >
              <option value="">— اختر الفرع —</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </AppSelect>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">اسم الجهاز</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="شاشة المدخل" className="min-w-[200px]" />
          </div>
          <Button onClick={submitCreate} disabled={create.isPending}>
            {create.isPending ? "…" : "إنشاء + رمز"}
          </Button>
        </CardContent>
      </Card>

      {/* قائمة الأجهزة */}
      <Card>
        <CardHeader>
          <ListToolbar
            title="الأجهزة المسجّلة"
            count={visibleDevices.length}
            loading={devicesQ.isLoading}
            search={{ value: f.q, onChange: (v) => setF({ q: v }), placeholder: "اسم الجهاز، الفرع أو بادئة الرمز…" }}
            filters={
              <>
                <FilterField label="الحالة">
                  <AppSelect value={f.status} onValueChange={(v) => setF({ status: v })} placeholder="الكل" className="w-32" size="sm">
                    <option value="">الكل</option>
                    <option value="active">مفعّل</option>
                    <option value="inactive">مُلغى</option>
                  </AppSelect>
                </FilterField>
                <FilterField label="الفرع">
                  <AppSelect value={f.branch} onValueChange={(v) => setF({ branch: v })} placeholder="كل الفروع" className="w-40" size="sm">
                    <option value="">كل الفروع</option>
                    {branches.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
                  </AppSelect>
                </FilterField>
              </>
            }
            activeFilterCount={activeFilterCount}
            onResetFilters={resetF}
            onRefresh={() => void devicesQ.refetch()}
            refreshing={devicesQ.isFetching}
            onPrint={printDevices}
            exportSpec={{
              filename: "أجهزة-قارئ-الأسعار",
              rows: visibleDevices,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "label", header: "الجهاز" }, { key: "branchName", header: "الفرع" },
                { key: "tokenPrefix", header: "بادئة الرمز" },
                { key: "isActive", header: "الحالة", map: (d) => d.isActive ? "مفعّل" : "ملغى" },
                { key: "lastSeenAt", header: "آخر ظهور", map: (d) => d.lastSeenAt ? fmtDateTime(d.lastSeenAt) : "لم يظهر بعد" },
              ],
            }}
          />
        </CardHeader>
        <CardContent>
          {/* البحث والفلاتر في `ListToolbar` أعلاه (تغذّي visibleDevices) ⇒ لا حقلَ بحثٍ ثانٍ هنا. */}
          <DataTable<KioskDeviceRow>
            columns={deviceColumns}
            data={visibleDevices}
            searchable={false}
            externalFiltersActive={activeFilterCount > 0 || f.q.trim() !== ""}
            loading={devicesQ.isLoading}
            errorState={{ isError: devicesQ.isError, message: devicesQ.error?.message, onRetry: () => void devicesQ.refetch() }}
            emptyState="لا أجهزة بعد — أضف جهازاً أعلاه."
            emptyFilteredState="لا أجهزة مطابقة للفلاتر."
          />
        </CardContent>
      </Card>
    </div>
  );
}
