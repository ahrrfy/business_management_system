/* الشاشة: أجهزة الحضور والمزامنة الحقيقية — الموارد البشرية (client/src/pages/HrDevices.tsx)
 * كل ما يُعرض هنا مُشتق من اتصالات حقيقية: «متصل» = مصافحة/نبض فعلي خلال دقائق (lastSeenAt)،
 * «على خادمك» = الجهاز صافح جسرنا فعلاً (lastHandshakeAt)، والعدادات مما أبلغه الجهاز (devInfo).
 * جهاز مجهول يوجَّه لخادمنا يظهر تلقائياً «بانتظار الاعتماد» — بوابة القبول بيد المدير.
 * الأقسام: حالة الجسر + الهجرة | جدول الأجهزة (+أوامر/ربط) | البصمات الخام (طابور المراجعة).
 * trpc.hrDevices.* — القراءة hr/READ والأزرار الكاتبة hr/FULL. */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { RowActions } from "@/components/list/RowActions";
import { ListToolbar } from "@/components/list/ListToolbar";
import { FilterField } from "@/components/list/FilterField";
import { ErrorState, LoadingState, TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { HR_FINGERPRINT_TARGET } from "@shared/hr";
import {
  BadgeCheck,
  Clock3,
  Cloud,
  DownloadCloud,
  Link2,
  ListChecks,
  Pencil,
  Plus,
  Radio,
  ScanFace,
  Search,
  Server,
  ShieldQuestion,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const PAID_PROVIDER = { provider: "IraqSoft — مزوّد خارجي", host: "api-iraqsoft.com", port: 7788 };

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const emptyForm = { name: "", serialNumber: "", protocol: "AIFACE_WS", model: "", location: "", branchId: "", deviceCode: "", ip: "" };

/** توقيت مقروء ببغداد — أو «—». */
function fmtTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("ar-IQ", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Baghdad" });
}

const PROTOCOL_LABELS: Record<string, string> = {
  AIFACE_WS: "بصمة وجه (AiFace/AI518)",
  ZKTECO_PUSH: "ZKTeco وأشباهها",
};

export default function HrDevices() {
  const utils = trpc.useUtils();
  // تحديث دوري: أثناء توجيه جهاز على الحائط تتحول حالته هنا «متصل» خلال ثوانٍ بلا إنعاش يدوي.
  const list = trpc.hrDevices.list.useQuery(undefined, { refetchInterval: 15_000 });
  const bridge = trpc.hrDevices.bridgeStatus.useQuery(undefined, { refetchInterval: 15_000 });
  const opts = trpc.employees.formOptions.useQuery();

  const [openAdd, setOpenAdd] = useState(false);
  /** null = إضافة جهاز جديد · رقم = تعديل جهازٍ قائم (نفس النموذج، فلا ازدواج شاشات). */
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [mapDeviceId, setMapDeviceId] = useState<number | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const [punchOffset, setPunchOffset] = useState(0);
  // فلاتر طابور البصمات — جهاز/موظف/مدى تاريخ (فوق deviceId/unmatchedOnly الموجودَين أصلاً).
  const [punchDeviceId, setPunchDeviceId] = useState("");
  const [punchEmployeeId, setPunchEmployeeId] = useState("");
  const [punchDateFrom, setPunchDateFrom] = useState("");
  const [punchDateTo, setPunchDateTo] = useState("");
  const punchFiltersActive = !!(punchDeviceId || punchEmployeeId || punchDateFrom || punchDateTo);
  function resetPunchFilters() {
    setPunchDeviceId(""); setPunchEmployeeId(""); setPunchDateFrom(""); setPunchDateTo("");
  }

  const punches = trpc.hrDevices.punchesList.useQuery(
    {
      unmatchedOnly,
      deviceId: punchDeviceId ? Number(punchDeviceId) : undefined,
      employeeId: punchEmployeeId ? Number(punchEmployeeId) : undefined,
      dateFrom: punchDateFrom || undefined,
      dateTo: punchDateTo || undefined,
      limit: 25,
      offset: punchOffset,
    },
    { refetchInterval: 30_000 }
  );
  // أي تغيير فلترٍ يعيد الترقيم إلى الصفحة الأولى.
  useEffect(() => setPunchOffset(0), [unmatchedOnly, punchDeviceId, punchEmployeeId, punchDateFrom, punchDateTo]);

  const deviceUsers = trpc.hrDevices.deviceUsers.useQuery(
    { deviceId: mapDeviceId ?? 0 },
    { enabled: mapDeviceId != null }
  );
  const [deviceUserQuery, setDeviceUserQuery] = useState("");
  const visibleDeviceUsers = useMemo(() => {
    const q = deviceUserQuery.trim().toLocaleLowerCase("ar");
    const rows = deviceUsers.data ?? [];
    return q ? rows.filter((u) => [u.name, String(u.enrollId)].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : rows;
  }, [deviceUsers.data, deviceUserQuery]);

  // طابور المصادر المعلّقة: يُحدَّث كل دقيقة كي يظهر العنوان الجديد بلا انتظار إعادة تحميل —
  // الانقطاع الذي دام ٨ ساعات سببه أنّ الرفض كان يُدفن في ملفّ سجلٍّ لا يراه أحد.
  const originsQuery = trpc.hrDevices.pendingOrigins.useQuery(undefined, { refetchInterval: 60_000 });
  const pendingOrigins = originsQuery.data ?? [];

  const refresh = async () => {
    await Promise.all([
      utils.hrDevices.list.invalidate(),
      utils.hrDevices.punchesList.invalidate(),
      utils.hrDevices.deviceUsers.invalidate(),
      utils.hrDevices.pendingOrigins.invalidate(),
    ]);
  };

  const trustOrigin = trpc.hrDevices.trustOrigin.useMutation({
    onSuccess: async (r) => {
      notify.ok(`اعتُمد العنوان ${r.ip} — سيتصل الجهاز خلال ثوانٍ`);
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const dismissOrigin = trpc.hrDevices.dismissOrigin.useMutation({
    onSuccess: async () => {
      notify.ok("صُرفت المحاولة");
      await refresh();
    },
    onError: (e) => notify.err(e),
  });

  const create = trpc.hrDevices.create.useMutation({
    onSuccess: async () => {
      notify.ok("تمت إضافة الجهاز — وجّهه لخادمك وسيتصل تلقائياً");
      setOpenAdd(false);
      setForm({ ...emptyForm });
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  // كان الخادم يملك `update` بلا أيّ شاشة تستدعيها ⇒ تعديل عنوان الجهاز مستحيلٌ من النظام،
  // وهو ما جعل عطل ١١/٨/٢٦ (تغيّر عنوان المتجر) يتطلّب SSH وتعديلاً يدوياً على الإنتاج.
  const update = trpc.hrDevices.update.useMutation({
    onSuccess: async () => {
      notify.ok("حُدِّثت بيانات الجهاز — تسري فوراً بلا إعادة تشغيل");
      setOpenAdd(false);
      setEditId(null);
      setForm({ ...emptyForm });
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const approve = trpc.hrDevices.approveDevice.useMutation({
    onSuccess: async () => {
      notify.ok("اعتُمد الجهاز — ستُقبل بصماته من الآن");
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const del = trpc.hrDevices.deleteDevice.useMutation({
    onSuccess: async (r) => {
      notify.ok(`حُذف صفّ «${r.name}»`);
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const command = trpc.hrDevices.enqueueCommand.useMutation({
    onSuccess: () => notify.ok("أُرسل الأمر — يُنفَّذ لحظة اتصال الجهاز"),
    onError: (e) => notify.err(e),
  });
  const mapUser = trpc.hrDevices.mapUser.useMutation({
    onSuccess: async (r) => {
      notify.ok(r.backfilled > 0 ? `رُبط الموظف وأُلحق بـ${r.backfilled} بصمة سابقة` : "رُبط الموظف");
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const processFolds = trpc.hrDevices.processFolds.useMutation({
    onSuccess: async (r) => {
      notify.ok(`عولجت البصمات: ${r.days} يوم حضور${r.parked ? ` — ${r.parked} مركونة` : ""}`);
      await refresh();
    },
    onError: (e) => notify.err(e),
  });

  const devices = list.data ?? [];
  const [query, setQuery] = useState("");
  const visibleDevices = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return q ? devices.filter((d) => [d.name, d.serialNumber, d.ip, d.branchName, d.location, d.model, d.status].some((v) => String(v ?? "").toLocaleLowerCase("ar").includes(q))) : devices;
  }, [devices, query]);
  const total = devices.length;
  const connectedEver = devices.filter((d) => d.lastHandshakeAt).length;
  const pct = total > 0 ? Math.round((connectedEver / total) * 100) : 0;
  const bridgeOn = bridge.data?.enabled ?? false;
  const bridgePort = bridge.data?.port ?? HR_FINGERPRINT_TARGET.port;
  const onlineNow = bridge.data?.onlineDeviceIds?.length ?? 0;
  // الوجهة التي تُكتب في الجهاز = النطاق الفرعي المملوك (لا مضيف لوحة الويب) — نطاق ثابت
  // يقبل تغيّر عنوان الخادم بتحديث DNS واحد بدل لمس كل جهاز.
  const myHost = HR_FINGERPRINT_TARGET.host;

  const employeeOptions = useMemo(() => opts.data?.managers ?? [], [opts.data]);

  const submit = () => {
    if (!form.name.trim()) {
      notify.warn("اسم الجهاز مطلوب");
      return;
    }
    const payload = {
      name: form.name.trim(),
      serialNumber: form.serialNumber.trim() || undefined,
      protocol: form.protocol as "AIFACE_WS" | "ZKTECO_PUSH",
      model: form.model.trim() || undefined,
      location: form.location.trim() || undefined,
      branchId: form.branchId ? Number(form.branchId) : undefined,
      deviceCode: form.deviceCode.trim() || undefined,
      ip: form.ip.trim() || undefined,
    };
    if (editId != null) update.mutate({ id: editId, ...payload });
    else create.mutate(payload);
  };

  /** يفتح نفس نموذج الإضافة بحالة تعديل مملوءة من صفّ الجهاز. */
  const startEdit = (d: {
    id: number;
    name: string;
    serialNumber: string | null;
    protocol: string | null;
    model: string | null;
    location: string | null;
    branchId: number | null;
    deviceCode: string | null;
    ip: string | null;
  }) => {
    setForm({
      name: d.name ?? "",
      serialNumber: d.serialNumber ?? "",
      protocol: d.protocol ?? "AIFACE_WS",
      model: d.model ?? "",
      location: d.location ?? "",
      branchId: d.branchId != null ? String(d.branchId) : "",
      deviceCode: d.deviceCode ?? "",
      ip: d.ip ?? "",
    });
    setEditId(d.id);
    setOpenAdd(true);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="أجهزة الحضور والمزامنة"
        description="اربط أجهزة بصمة الوجه مباشرةً بخادمك: البصمات تصل لحظياً وتتحول سجل حضور تلقائياً — بلا اشتراك شهري."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" disabled={processFolds.isPending} onClick={() => processFolds.mutate()}>
              <ListChecks className="size-4" /> معالجة البصمات الآن
            </Button>
            <Button onClick={() => setOpenAdd(true)}>
              <Plus className="size-4" /> جهاز جديد
            </Button>
          </div>
        }
      />

      {/* بطاقة الجسر + الهجرة */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start gap-3 flex-wrap">
            <span className="size-10 rounded-lg grid place-items-center shrink-0 bg-primary/10 text-primary">
              <Cloud className="size-5" />
            </span>
            <div className="flex-1 min-w-[240px]">
              <h3 className="font-bold text-[15px]">التخلص من اشتراك البصمة الخارجي المدفوع</h3>
              <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
                جهازك يدفع الآن بصماته لمزوّد خارجي مدفوع. وجّهه لخادمك (من قائمة Server في الجهاز) فيصافح
                الجسر ويظهر هنا متصلاً، وتنساب البصمات لسجل الحضور مباشرة — ثم ألغِ الاشتراك.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setGuideOpen(true)}>
              <Server className="size-4" /> تعليمات توجيه الجهاز
            </Button>
          </div>

          <div className="grid md:grid-cols-[1fr_auto_1fr] gap-3 items-stretch">
            <div className="rounded-lg border p-3.5" style={{ borderColor: "color-mix(in oklch, var(--sem-warn) 42%, transparent)", background: "var(--sem-warn-bg)" }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-[var(--sem-warn)]">المزوّد الحالي (مدفوع)</span>
                <span className="badge-stock-low inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium">
                  يُلغى
                </span>
              </div>
              <div className="text-[13px] font-bold mb-1">{PAID_PROVIDER.provider}</div>
              <div className="text-[11px] text-[var(--sem-warn)] space-y-1" dir="ltr">
                <div className="flex items-center gap-1.5">
                  <Radio className="size-3" /> {PAID_PROVIDER.host}:{PAID_PROVIDER.port}
                </div>
              </div>
            </div>

            <div className="grid place-items-center px-1">
              <div className="size-10 rounded-full grid place-items-center bg-primary text-primary-foreground">
                <Server className="size-5" />
              </div>
            </div>

            <div
              className="rounded-lg border-2 p-3.5"
              style={
                bridgeOn
                  ? { borderColor: "var(--status-active)", background: "color-mix(in oklch, var(--status-active) 7%, transparent)" }
                  : { borderColor: "color-mix(in oklch, var(--sem-neg) 42%, transparent)", background: "var(--sem-neg-bg)" }
              }
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold" style={{ color: bridgeOn ? "var(--status-active)" : "var(--sem-neg)" }}>
                  جسر الاستقبال على خادمك
                </span>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${bridgeOn ? "badge-status-active" : "badge-stock-out"}`}>
                  {bridgeOn ? "يعمل" : "غير مفعَّل"}
                </span>
              </div>
              {bridgeOn ? (
                <>
                  <div className="text-[13px] font-bold mb-1">متصل الآن: {onlineNow} جهاز</div>
                  <div className="text-[11px] text-muted-foreground space-y-1" dir="ltr">
                    <div className="flex items-center gap-1.5">
                      <Radio className="size-3" /> {myHost}:{bridgePort}
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  اضبط HR_DEVICE_PORT في إعدادات الخادم (والمنفذ في الجدار الناري) ليستقبل الجسر الأجهزة.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-medium">أجهزة صافحت خادمك فعلاً</span>
                <span className="tabular-nums text-muted-foreground" dir="ltr">
                  {connectedEver} / {total}
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-[var(--status-active)] transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>

          {total > 0 && connectedEver === total && bridgeOn && (
            <div className="rounded-md p-2.5 text-[12px] flex items-center gap-2" style={{ background: "color-mix(in oklch, var(--status-active) 10%, transparent)", color: "var(--status-active)" }}>
              <BadgeCheck className="size-4 shrink-0" /> كل الأجهزة تتكلم مع خادمك مباشرة. لم يعد الاشتراك الخارجي
              مطلوباً — يمكنك إلغاؤه بأمان.
            </div>
          )}
        </CardContent>
      </Card>

      {/* مصادر تنتظر قراراً — «العنوان يُتعلَّم لا يُكتَب».
          مزوّد الإنترنت يغيّر عنوان المتجر دورياً فيُصَدّ الجهاز؛ الاعتماد تلقائيّ متى عزّزته
          جلسةُ موظّفٍ مُصادَقة، وهذه البطاقة هي المسار المرئيّ حين تغيب القرينة. لا تظهر إطلاقاً
          في الحالة الطبيعية. */}
      {pendingOrigins.length > 0 && (
        <Card>
          <CardContent
            className="p-4 space-y-3"
            style={{ borderInlineStartWidth: 3, borderInlineStartColor: "var(--sem-warn)" }}
          >
            <div className="flex items-start gap-2">
              <ShieldQuestion aria-hidden className="size-4 mt-0.5 shrink-0" style={{ color: "var(--sem-warn)" }} />
              <div>
                <div className="text-sm font-semibold">جهاز يحاول الاتصال من عنوان جديد</div>
                <p className="text-[12px] text-muted-foreground leading-relaxed">
                  تغيّر عنوان الإنترنت لدى المتجر عادةً سببُ ذلك. اعتمد العنوان إن كان جهازك — يسري فوراً
                  وتنساب البصمات المخزَّنة. لا تعتمد عنواناً لا تعرفه.
                </p>
              </div>
            </div>
            <div className="space-y-2">
              {pendingOrigins.map((o) => (
                <div key={o.id} className="rounded-md border p-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">
                      {o.deviceName ?? "جهاز غير معروف"}{" "}
                      <span className="text-muted-foreground font-normal" dir="ltr">
                        {o.serialNumber}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      من العنوان <span dir="ltr" className="font-mono">{o.ip}</span> · {o.attemptCount} محاولة · آخرها{" "}
                      {fmtTime(o.lastSeenAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      disabled={trustOrigin.isPending || o.deviceId == null}
                      onClick={() => trustOrigin.mutate({ id: o.id })}
                    >
                      اعتماد العنوان
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={dismissOrigin.isPending}
                      onClick={() => dismissOrigin.mutate({ id: o.id })}
                    >
                      ليس جهازي
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* جدول الأجهزة */}
      <Card>
        <CardHeader>
          <ListToolbar
            title="أجهزة الحضور"
            count={visibleDevices.length}
            loading={list.isLoading}
            search={{ value: query, onChange: setQuery, placeholder: "الجهاز، التسلسل، الفرع، الموقع أو الطراز…" }}
            onResetFilters={() => setQuery("")}
            onRefresh={() => void refresh()}
            refreshing={list.isFetching || bridge.isFetching}
            onPrint={() => window.print()}
            exportSpec={{
              filename: "أجهزة-الحضور",
              rows: visibleDevices,
              formats: ["xlsx", "csv"],
              columns: [
                { key: "name", header: "الجهاز" }, { key: "serialNumber", header: "الرقم التسلسلي" },
                { key: "branchName", header: "الفرع" }, { key: "location", header: "الموقع" },
                { key: "model", header: "الطراز" }, { key: "status", header: "الحالة" },
                { key: "lastSeenAt", header: "آخر إشارة" }, { key: "recordsCount", header: "السجلات" },
              ],
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">الجهاز</th>
                  <th className="p-2">الفرع / الموقع</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2 text-center">آخر إشارة</th>
                  <th className="p-2 text-center">بصمات مستلَمة</th>
                  <th className="p-2 text-center">يُبلّغ الجهاز</th>
                  <th className="p-2 text-center">على خادمك؟</th>
                  <th className="p-2 text-left">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {visibleDevices.map((d) => {
                  const online = d.status === "online";
                  return (
                    <tr key={d.id} className="border-t hover:bg-accent/50 transition">
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`size-9 rounded-lg grid place-items-center shrink-0 ${online ? "badge-status-active" : "badge-stock-out"}`}
                          >
                            <ScanFace className="size-5" />
                          </span>
                          <div>
                            <div className="font-medium">{d.name}</div>
                            <div className="text-[11px] text-muted-foreground" dir="ltr">
                              {d.serialNumber ?? d.model ?? "—"}
                              {d.firmware ? ` · ${d.firmware}` : ""}
                            </div>
                            {d.ip ? <div className="text-[10px] text-muted-foreground" dir="ltr">IP {d.ip}</div> : null}
                          </div>
                        </div>
                      </td>
                      <td className="p-2 text-xs">
                        {d.branchName ?? "—"}
                        {d.location ? <div className="text-muted-foreground">{d.location}</div> : null}
                      </td>
                      <td className="p-2 text-center">
                        {d.enabled ? (
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${online ? "badge-status-active" : "badge-stock-out"}`}
                          >
                            <span className="size-1.5 rounded-full" style={{ background: online ? "var(--status-active)" : "var(--stock-out)" }} />
                            {online ? "متصل" : "منقطع"}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium badge-stock-low">
                            بانتظار الاعتماد
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-center text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Clock3 className="size-3" /> {fmtTime(d.lastSeenAt)}
                        </span>
                      </td>
                      <td className="p-2 text-center text-xs tabular-nums" dir="ltr">
                        {/* العدّ الحقيقيّ من قاعدتنا — يتحرّك أثناء الرفع، بخلاف عدّادَي الجهاز الثابتين. */}
                        <div className="font-medium">{(d.receivedPunches ?? 0).toLocaleString("en-US")}</div>
                        {(d.pendingPunches ?? 0) > 0 && (
                          <div className="text-[10px] text-[var(--sem-warn)]" dir="rtl">
                            {(d.pendingPunches ?? 0).toLocaleString("en-US")} بلا موظف
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-center text-[11px] tabular-nums text-muted-foreground" dir="ltr">
                        {d.usersCount ?? 0} / {d.recordsCount ?? 0}
                      </td>
                      <td className="p-2 text-center">
                        {d.lastHandshakeAt ? (
                          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium badge-status-active">
                            <BadgeCheck className="size-3" /> صافح خادمك
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium badge-stock-low">
                            لم يتصل بعد
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-left">
                        <RowActions
                          mode="menu"
                          align="start"
                          actions={[
                            { key: "approve", kind: "approve", label: "اعتماد", icon: BadgeCheck, hidden: d.enabled, gate: { module: "hr", level: "FULL" }, disabled: approve.isPending, disabledReason: "جارٍ اعتماد الجهاز", onSelect: () => approve.mutate({ id: d.id }) },
                            { key: "edit", kind: "edit", label: "تعديل الجهاز (الاسم/الفرع/العنوان)", icon: Pencil, gate: { module: "hr", level: "FULL" }, onSelect: () => startEdit(d) },
                            { key: "map", kind: "edit", label: "ربط المستخدمين بالموظفين", icon: Link2, hidden: !d.enabled, gate: { module: "hr", level: "FULL" }, onSelect: () => setMapDeviceId(d.id) },
                            { key: "logs", kind: "export", label: "سحب السجل", icon: DownloadCloud, hidden: !d.enabled, gate: { module: "hr", level: "FULL" }, disabled: command.isPending, disabledReason: "الجهاز ينفّذ أمراً آخر", onSelect: () => command.mutate({ deviceId: d.id, cmd: "getalllog" }) },
                            { key: "users", kind: "export", label: "سحب المستخدمين", icon: Users, hidden: !d.enabled, gate: { module: "hr", level: "FULL" }, disabled: command.isPending, disabledReason: "الجهاز ينفّذ أمراً آخر", onSelect: () => command.mutate({ deviceId: d.id, cmd: "getuserlist" }) },
                            { key: "time", kind: "edit", label: "مزامنة الوقت", icon: Clock3, hidden: !d.enabled, gate: { module: "hr", level: "FULL" }, disabled: command.isPending, disabledReason: "الجهاز ينفّذ أمراً آخر", onSelect: () => command.mutate({ deviceId: d.id, cmd: "settime" }) },
                            { key: "delete", kind: "delete", label: "حذف الصفّ", icon: Trash2, hidden: d.enabled, gate: { module: "hr", level: "FULL" }, disabled: del.isPending, disabledReason: "جارٍ الحذف", onSelect: () => void (async () => {
                              if (!(await confirm({ variant: "danger", title: "حذف صفّ الجهاز", description: `حذف «${d.name}» (${d.serialNumber ?? "بلا سريال"}). متاح لأنّه غير معتمَد وبلا بصمات — صفوفٌ كهذه تنشأ تلقائياً من فحوص الاتصال.`, confirmText: "حذف" }))) return;
                              del.mutate({ id: d.id });
                            })() },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
                {list.isError && (
                  <tr>
                    <td colSpan={8} className="p-0">
                      <ErrorState message="تعذّر تحميل الأجهزة." onRetry={() => list.refetch()} />
                    </td>
                  </tr>
                )}
                {!list.isLoading && !list.isError && visibleDevices.length === 0 && (
                  <TableEmptyRow
                    colSpan={8}
                    message="لا أجهزة بعد. أضف جهازاً برقمه التسلسلي، أو وجّهه لخادمك وسيظهر هنا بانتظار الاعتماد."
                  />
                )}
                {list.isLoading && (
                  <tr>
                    <td colSpan={8} className="p-0">
                      <LoadingState />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* البصمات الخام */}
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">البصمات الواردة</CardTitle>
            <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-primary"
                checked={unmatchedOnly}
                onChange={(e) => setUnmatchedOnly(e.target.checked)}
              />
              غير المربوطة بموظف فقط
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <FilterField label="الجهاز">
              <select className={selectCls} value={punchDeviceId} onChange={(e) => setPunchDeviceId(e.target.value)} aria-label="الجهاز">
                <option value="">كل الأجهزة</option>
                {devices.map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
              </select>
            </FilterField>
            <FilterField label="الموظف">
              <select className={selectCls} value={punchEmployeeId} onChange={(e) => setPunchEmployeeId(e.target.value)} aria-label="الموظف">
                <option value="">كل الموظفين</option>
                {employeeOptions.map((emp) => <option key={emp.id} value={String(emp.id)}>{emp.name}</option>)}
              </select>
            </FilterField>
            <FilterField label="من تاريخ">
              <Input type="date" dir="ltr" value={punchDateFrom} onChange={(e) => setPunchDateFrom(e.target.value)} className="h-9 w-36" aria-label="من تاريخ" />
            </FilterField>
            <FilterField label="إلى تاريخ">
              <Input type="date" dir="ltr" value={punchDateTo} onChange={(e) => setPunchDateTo(e.target.value)} className="h-9 w-36" aria-label="إلى تاريخ" />
            </FilterField>
            {punchFiltersActive && (
              <Button variant="ghost" size="sm" onClick={resetPunchFilters} className="text-muted-foreground">
                <X aria-hidden className="size-4" /> مسح الفلاتر
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">الوقت</th>
                  <th className="p-2">الجهاز</th>
                  <th className="p-2 text-center">رقم المستخدم</th>
                  <th className="p-2">الموظف</th>
                  <th className="p-2 text-center">الوسيلة</th>
                  <th className="p-2 text-center">المعالجة</th>
                </tr>
              </thead>
              <tbody>
                {(punches.data?.rows ?? []).map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="p-2 text-xs tabular-nums" dir="ltr">
                      {String(p.punchAt)}
                    </td>
                    <td className="p-2 text-xs">{p.deviceName ?? p.serialNumber}</td>
                    <td className="p-2 text-center text-xs tabular-nums">{p.enrollId}</td>
                    <td className="p-2 text-xs">
                      {p.employeeName ?? (
                        <span className="text-[var(--sem-warn)]">غير مربوط — اربطه من زر «الربط»</span>
                      )}
                    </td>
                    <td className="p-2 text-center text-xs">{p.mode ?? "—"}</td>
                    <td className="p-2 text-center text-xs">
                      {p.processedAt ? (
                        p.processNote ? (
                          <span className="text-[var(--sem-neg)]" title={p.processNote}>
                            مركونة
                          </span>
                        ) : (
                          <span className="text-[var(--sem-pos)]">في الحضور</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">بالانتظار</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!punches.isLoading && (punches.data?.rows.length ?? 0) === 0 && (
                  <TableEmptyRow colSpan={6} message="لا بصمات واردة بعد — ستظهر هنا لحظة وصولها من الأجهزة." />
                )}
                {punches.isLoading && (
                  <tr>
                    <td colSpan={6} className="p-0">
                      <LoadingState />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollTableShell>
          <div className="flex items-center justify-between p-2 border-t">
            <Button
              size="sm"
              variant="outline"
              disabled={punchOffset === 0}
              onClick={() => setPunchOffset((o) => Math.max(0, o - 25))}
            >
              الأحدث
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!punches.data?.hasMore}
              onClick={() => setPunchOffset((o) => o + 25)}
            >
              الأقدم
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* حوار ربط مستخدمي الجهاز بالموظفين */}
      <Dialog
        open={mapDeviceId != null}
        onOpenChange={(o) => { if (!o) { setMapDeviceId(null); setDeviceUserQuery(""); } }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>ربط مستخدمي الجهاز بالموظفين</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground -mt-1">
            كل رقم في الجهاز يقابله موظف في النظام — بعد الربط تُحتسب بصماته حضوراً تلقائياً (حتى السابقة منها).
            إن كانت القائمة فارغة اسحب المستخدمين من الجهاز بزر «المستخدمون».
          </p>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={deviceUserQuery}
              onChange={(e) => setDeviceUserQuery(e.target.value)}
              placeholder="بحث بالرقم أو الاسم في الجهاز…"
              aria-label="بحث في مستخدمي الجهاز"
              className="h-8 w-full pr-8"
            />
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="p-2 text-center">الرقم</th>
                  <th className="p-2">الاسم في الجهاز</th>
                  <th className="p-2 text-center">قوالب محفوظة؟</th>
                  <th className="p-2">الموظف المربوط</th>
                </tr>
              </thead>
              <tbody>
                {visibleDeviceUsers.map((u) => (
                  <tr key={u.id} className="border-t">
                    <td className="p-2 text-center tabular-nums">{u.enrollId}</td>
                    <td className="p-2 text-xs">{u.name ?? "—"}</td>
                    <td className="p-2 text-center text-xs">{u.hasBackup ? "نعم" : "—"}</td>
                    <td className="p-2">
                      <select
                        className={selectCls}
                        value={u.employeeId ? String(u.employeeId) : ""}
                        onChange={(e) =>
                          mapDeviceId != null &&
                          mapUser.mutate({
                            deviceId: mapDeviceId,
                            enrollId: u.enrollId,
                            employeeId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      >
                        <option value="">— غير مربوط —</option>
                        {employeeOptions.map((emp) => (
                          <option key={emp.id} value={String(emp.id)}>
                            {emp.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
                {!deviceUsers.isLoading && visibleDeviceUsers.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-4 text-center text-xs text-muted-foreground">
                      {(deviceUsers.data?.length ?? 0) === 0
                        ? "لا مستخدمون مسحوبون بعد — أرسل أمر «المستخدمون» من جدول الأجهزة ثم افتح هذا الحوار."
                        : "لا نتائج مطابقة للبحث."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMapDeviceId(null)}>
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار تعليمات توجيه الجهاز */}
      <Dialog open={guideOpen} onOpenChange={setGuideOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>توجيه الجهاز إلى خادمك</DialogTitle>
          </DialogHeader>
          <ol className="text-[13px] leading-relaxed space-y-2 list-decimal pr-5">
            <li>
              من شاشة الجهاز: <b>Menu ← Comm set / Server</b>.
            </li>
            <li>
              اضبط: <span dir="ltr" className="font-mono text-xs">Server Req = Yes</span>
            </li>
            <li>
              فعّل النطاق: <span dir="ltr" className="font-mono text-xs">Use domainNm = Yes</span>
            </li>
            <li>
              ثم اكتب: <span dir="ltr" className="font-mono text-xs">DomainNm = {myHost}</span>
            </li>
            <li>
              والمنفذ: <span dir="ltr" className="font-mono text-xs">SerPortNo = {bridgePort}</span>
            </li>
            <li>احفظ وأعد تشغيل الجهاز — سيظهر خلال دقيقة في الجدول أعلاه (متصل / بانتظار الاعتماد).</li>
            <li>أجهزة ZKTeco: نفس الفكرة من قائمة Cloud Server Setting (ADMS) بنفس النطاق والمنفذ.</li>
          </ol>
          <p className="text-[11px] text-muted-foreground">
            بديلٌ للنطاق: <span dir="ltr" className="font-mono text-xs">Use domainNm = No</span> ثم
            <span dir="ltr" className="font-mono text-xs"> Server IP = </span> عنوان الخادم الرقمي —
            لكن النطاق أفضل (تغيّر عنوان الخادم يُحلّ بتحديث DNS واحد بلا لمس الأجهزة).
          </p>
          <p className="text-[11px] text-muted-foreground">
            ملاحظة: توجيه الجهاز لخادمك يفصله عن المزوّد المدفوع فوراً — سجلاته محفوظة في ذاكرته ويعيد دفعها
            لخادمك تلقائياً، ويمكن سحب التاريخ كاملاً بزر «سحب السجل».
          </p>
          <DialogFooter>
            <Button onClick={() => setGuideOpen(false)}>فهمت</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* نافذة إضافة جهاز */}
      <Dialog
        open={openAdd}
        onOpenChange={(o) => {
          setOpenAdd(o);
          if (!o) {
            setForm({ ...emptyForm });
            setEditId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId != null ? "تعديل جهاز حضور" : "إضافة جهاز حضور"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="d-name">اسم الجهاز</Label>
              <Input
                id="d-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="جهاز البصمة — المدخل الرئيسي"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-sn">الرقم التسلسلي (SN)</Label>
              <Input
                id="d-sn"
                dir="ltr"
                value={form.serialNumber}
                onChange={(e) => setForm((f) => ({ ...f, serialNumber: e.target.value }))}
                placeholder="ZXRB06004623"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-proto">نوع الجهاز</Label>
              <select
                id="d-proto"
                className={selectCls}
                value={form.protocol}
                onChange={(e) => setForm((f) => ({ ...f, protocol: e.target.value }))}
              >
                {Object.entries(PROTOCOL_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="d-ip">عنوان IP الدقيق الخاص بالجهاز</Label>
              <Input
                id="d-ip"
                dir="ltr"
                value={form.ip}
                onChange={(e) => setForm((f) => ({ ...f, ip: e.target.value }))}
                placeholder="مثال: عنوان الجهاز داخل شبكة الحضور"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-model">الطراز</Label>
              <Input
                id="d-model"
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="AI518 وجه + بطاقة"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-location">الموقع</Label>
              <Input
                id="d-location"
                value={form.location}
                onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                placeholder="بوابة الفرع الرئيسي"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-branch">الفرع</Label>
              <select
                id="d-branch"
                className={selectCls}
                value={form.branchId}
                onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}
              >
                <option value="">— بلا فرع —</option>
                {(opts.data?.branches ?? []).map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-code">معرّف الجهاز (Device ID)</Label>
              <Input
                id="d-code"
                dir="ltr"
                value={form.deviceCode}
                onChange={(e) => setForm((f) => ({ ...f, deviceCode: e.target.value }))}
                placeholder="1"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            عند التسجيل المسبق يلزم ربط الرقم التسلسلي بعنوان جهاز فريد. الشبكات المشتركة أو NAT تحتاج
            مفتاح جهاز خاصاً في إعداد الخادم. لا تُقبل بصمات الجهاز المكتشف قبل الاعتماد.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenAdd(false)}>
              إلغاء
            </Button>
            <Button disabled={create.isPending || update.isPending} onClick={submit}>
              {create.isPending || update.isPending ? "جارٍ…" : editId != null ? "حفظ" : "إضافة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
