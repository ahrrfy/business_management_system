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
import { ErrorState, LoadingState, TableEmptyRow } from "@/components/PageState";
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
  Plus,
  Radio,
  ScanFace,
  Server,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";

const PAID_PROVIDER = { provider: "IraqSoft — مزوّد خارجي", host: "api-iraqsoft.com", port: 7788 };

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const emptyForm = { name: "", serialNumber: "", protocol: "AIFACE_WS", model: "", location: "", branchId: "", deviceCode: "" };

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
  const [form, setForm] = useState({ ...emptyForm });
  const [mapDeviceId, setMapDeviceId] = useState<number | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const [punchOffset, setPunchOffset] = useState(0);

  const punches = trpc.hrDevices.punchesList.useQuery(
    { unmatchedOnly, limit: 25, offset: punchOffset },
    { refetchInterval: 30_000 }
  );
  const deviceUsers = trpc.hrDevices.deviceUsers.useQuery(
    { deviceId: mapDeviceId ?? 0 },
    { enabled: mapDeviceId != null }
  );

  const refresh = async () => {
    await Promise.all([
      utils.hrDevices.list.invalidate(),
      utils.hrDevices.punchesList.invalidate(),
      utils.hrDevices.deviceUsers.invalidate(),
    ]);
  };

  const create = trpc.hrDevices.create.useMutation({
    onSuccess: async () => {
      notify.ok("تمت إضافة الجهاز — وجّهه لخادمك وسيتصل تلقائياً");
      setOpenAdd(false);
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
    create.mutate({
      name: form.name.trim(),
      serialNumber: form.serialNumber.trim() || undefined,
      protocol: form.protocol as "AIFACE_WS" | "ZKTECO_PUSH",
      model: form.model.trim() || undefined,
      location: form.location.trim() || undefined,
      branchId: form.branchId ? Number(form.branchId) : undefined,
      deviceCode: form.deviceCode.trim() || undefined,
    });
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
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">المزوّد الحالي (مدفوع)</span>
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                  يُلغى
                </span>
              </div>
              <div className="text-[13px] font-bold mb-1">{PAID_PROVIDER.provider}</div>
              <div className="text-[11px] text-amber-700/80 dark:text-amber-400/80 space-y-1" dir="ltr">
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
              className={`rounded-lg border-2 p-3.5 ${bridgeOn ? "border-emerald-500 bg-emerald-500/[0.07]" : "border-rose-300 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-800"}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`text-xs font-semibold ${bridgeOn ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                >
                  جسر الاستقبال على خادمك
                </span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${bridgeOn ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"}`}
                >
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
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>

          {total > 0 && connectedEver === total && bridgeOn && (
            <div className="rounded-md p-2.5 text-[12px] flex items-center gap-2 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
              <BadgeCheck className="size-4 shrink-0" /> كل الأجهزة تتكلم مع خادمك مباشرة. لم يعد الاشتراك الخارجي
              مطلوباً — يمكنك إلغاؤه بأمان.
            </div>
          )}
        </CardContent>
      </Card>

      {/* جدول الأجهزة */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">الأجهزة ({total})</CardTitle>
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
                  <th className="p-2 text-center">مستخدمون / سجلات</th>
                  <th className="p-2 text-center">على خادمك؟</th>
                  <th className="p-2 text-left">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => {
                  const online = d.status === "online";
                  return (
                    <tr key={d.id} className="border-t hover:bg-accent/50 transition">
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`size-9 rounded-lg grid place-items-center shrink-0 ${online ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950" : "bg-rose-50 text-rose-500 dark:bg-rose-950"}`}
                          >
                            <ScanFace className="size-5" />
                          </span>
                          <div>
                            <div className="font-medium">{d.name}</div>
                            <div className="text-[11px] text-muted-foreground" dir="ltr">
                              {d.serialNumber ?? d.model ?? "—"}
                              {d.firmware ? ` · ${d.firmware}` : ""}
                            </div>
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
                            <span className={`size-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500"}`} />
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
                        <div className="flex items-center gap-1 justify-end flex-wrap">
                          {!d.enabled && (
                            <Button
                              size="sm"
                              disabled={approve.isPending}
                              onClick={() => approve.mutate({ id: d.id })}
                            >
                              <BadgeCheck className="size-3.5" /> اعتماد
                            </Button>
                          )}
                          {d.enabled && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                title="ربط مستخدمي الجهاز بالموظفين"
                                onClick={() => setMapDeviceId(d.id)}
                              >
                                <Link2 className="size-3.5" /> الربط
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                title="سحب كل سجل الجهاز التاريخي"
                                disabled={command.isPending}
                                onClick={() => command.mutate({ deviceId: d.id, cmd: "getalllog" })}
                              >
                                <DownloadCloud className="size-3.5" /> سحب السجل
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                title="سحب قائمة المستخدمين وقوالبهم"
                                disabled={command.isPending}
                                onClick={() => command.mutate({ deviceId: d.id, cmd: "getuserlist" })}
                              >
                                <Users className="size-3.5" /> المستخدمون
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                title="مزامنة ساعة الجهاز مع الخادم"
                                disabled={command.isPending}
                                onClick={() => command.mutate({ deviceId: d.id, cmd: "settime" })}
                              >
                                <Clock3 className="size-3.5" /> الوقت
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {list.isError && (
                  <tr>
                    <td colSpan={7} className="p-0">
                      <ErrorState message="تعذّر تحميل الأجهزة." onRetry={() => list.refetch()} />
                    </td>
                  </tr>
                )}
                {!list.isLoading && !list.isError && devices.length === 0 && (
                  <TableEmptyRow
                    colSpan={7}
                    message="لا أجهزة بعد. أضف جهازاً برقمه التسلسلي، أو وجّهه لخادمك وسيظهر هنا بانتظار الاعتماد."
                  />
                )}
                {list.isLoading && (
                  <tr>
                    <td colSpan={7} className="p-0">
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
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">البصمات الواردة</CardTitle>
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-primary"
              checked={unmatchedOnly}
              onChange={(e) => {
                setUnmatchedOnly(e.target.checked);
                setPunchOffset(0);
              }}
            />
            غير المربوطة بموظف فقط
          </label>
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
                        <span className="text-amber-600 dark:text-amber-400">غير مربوط — اربطه من زر «الربط»</span>
                      )}
                    </td>
                    <td className="p-2 text-center text-xs">{p.mode ?? "—"}</td>
                    <td className="p-2 text-center text-xs">
                      {p.processedAt ? (
                        p.processNote ? (
                          <span className="text-rose-600 dark:text-rose-400" title={p.processNote}>
                            مركونة
                          </span>
                        ) : (
                          <span className="text-emerald-600 dark:text-emerald-400">في الحضور</span>
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
      <Dialog open={mapDeviceId != null} onOpenChange={(o) => !o && setMapDeviceId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>ربط مستخدمي الجهاز بالموظفين</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground -mt-1">
            كل رقم في الجهاز يقابله موظف في النظام — بعد الربط تُحتسب بصماته حضوراً تلقائياً (حتى السابقة منها).
            إن كانت القائمة فارغة اسحب المستخدمين من الجهاز بزر «المستخدمون».
          </p>
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
                {(deviceUsers.data ?? []).map((u) => (
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
                {!deviceUsers.isLoading && (deviceUsers.data?.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={4} className="p-4 text-center text-xs text-muted-foreground">
                      لا مستخدمون مسحوبون بعد — أرسل أمر «المستخدمون» من جدول الأجهزة ثم افتح هذا الحوار.
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
          if (!o) setForm({ ...emptyForm });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>إضافة جهاز حضور</DialogTitle>
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
            تسجيل الرقم التسلسلي مسبقاً يجعل الجهاز معتمداً لحظة أول اتصال. بدونه سيظهر «بانتظار الاعتماد» عند
            اتصاله وتعتمده بزر واحد.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenAdd(false)}>
              إلغاء
            </Button>
            <Button disabled={create.isPending} onClick={submit}>
              {create.isPending ? "جارٍ…" : "إضافة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
