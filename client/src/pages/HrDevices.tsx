/* الشاشة: أجهزة الحضور والمزامنة الحقيقية — الموارد البشرية (client/src/pages/HrDevices.tsx)
 * كل ما يُعرض هنا مُشتق من اتصالات حقيقية: «متصل» = مصافحة/نبض فعلي خلال دقائق (lastSeenAt)،
 * «على خادمك» = الجهاز صافح جسرنا فعلاً (lastHandshakeAt)، والعدادات مما أبلغه الجهاز (devInfo).
 * جهاز مجهول يوجَّه لخادمنا يظهر تلقائياً «بانتظار الاعتماد» — بوابة القبول بيد المدير.
 * الأقسام: حالة الجسر + الهجرة | جدول الأجهزة (+أوامر/ربط) | البصمات الخام (طابور المراجعة).
 * trpc.hrDevices.* — القراءة hr/READ والأزرار الكاتبة hr/FULL. */
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { FILTER_LABELS } from "@shared/uiContracts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/PageHeader";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { RowActions, type RowAction } from "@/components/list/RowActions";
import { FilterField } from "@/components/list/FilterField";
import { confirm } from "@/lib/confirm";
import { exportRows } from "@/lib/export";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { HR_FINGERPRINT_TARGET } from "@shared/hr";
import {
  Activity,
  BadgeCheck,
  ChevronLeft,
  Circle,
  Clock3,
  DownloadCloud,
  FileSpreadsheet,
  Fingerprint,
  Link2,
  ListChecks,
  MapPin,
  Pencil,
  Plus,
  RefreshCcw,
  ScanFace,
  Search,
  Settings2,
  ShieldQuestion,
  Trash2,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const emptyForm = {
  name: "",
  serialNumber: "",
  protocol: "AIFACE_WS",
  model: "",
  location: "",
  branchId: "",
  deviceCode: "",
  ip: "",
};

/** توقيت مقروء ببغداد — أو «—». */
function fmtTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("ar-IQ-u-nu-latn", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Baghdad",
  });
}

/** وقتٌ نسبيّ قصير للحالة الحيّة؛ التاريخ الكامل يبقى للتوقيتات الأقدم. */
function fmtRelativeTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1_000));
  if (seconds < 60) return "الآن";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "قبل دقيقة";
  if (minutes === 2) return "قبل دقيقتين";
  if (minutes < 60)
    return `قبل ${minutes.toLocaleString("ar-IQ-u-nu-latn")} دقيقة`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "قبل ساعة";
  if (hours === 2) return "قبل ساعتين";
  if (hours < 24) return `قبل ${hours.toLocaleString("ar-IQ-u-nu-latn")} ساعات`;
  return fmtTime(d);
}

const PROTOCOL_LABELS: Record<string, string> = {
  AIFACE_WS: "بصمة وجه (AiFace/AI518)",
  ZKTECO_PUSH: "ZKTeco وأشباهها",
};

export default function HrDevices() {
  const utils = trpc.useUtils();
  // تحديث دوري: أثناء توجيه جهاز على الحائط تتحول حالته هنا «متصل» خلال ثوانٍ بلا إنعاش يدوي.
  const list = trpc.hrDevices.list.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const bridge = trpc.hrDevices.bridgeStatus.useQuery(undefined, {
    refetchInterval: 15_000,
  });
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
  const punchFiltersActive = !!(
    punchDeviceId ||
    punchEmployeeId ||
    punchDateFrom ||
    punchDateTo
  );
  function resetPunchFilters() {
    setPunchDeviceId("");
    setPunchEmployeeId("");
    setPunchDateFrom("");
    setPunchDateTo("");
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
    { refetchInterval: 30_000 },
  );
  // أي تغيير فلترٍ يعيد الترقيم إلى الصفحة الأولى.
  useEffect(
    () => setPunchOffset(0),
    [unmatchedOnly, punchDeviceId, punchEmployeeId, punchDateFrom, punchDateTo],
  );

  const deviceUsers = trpc.hrDevices.deviceUsers.useQuery(
    { deviceId: mapDeviceId ?? 0 },
    { enabled: mapDeviceId != null },
  );
  const [deviceUserQuery, setDeviceUserQuery] = useState("");
  const visibleDeviceUsers = useMemo(() => {
    const q = deviceUserQuery.trim().toLocaleLowerCase("ar");
    const rows = deviceUsers.data ?? [];
    return q
      ? rows.filter((u) =>
          [u.name, String(u.enrollId)].some((v) =>
            String(v ?? "")
              .toLocaleLowerCase("ar")
              .includes(q),
          ),
        )
      : rows;
  }, [deviceUsers.data, deviceUserQuery]);

  // طابور المصادر المعلّقة: يُحدَّث كل دقيقة كي يظهر العنوان الجديد بلا انتظار إعادة تحميل —
  // الانقطاع الذي دام ٨ ساعات سببه أنّ الرفض كان يُدفن في ملفّ سجلٍّ لا يراه أحد.
  const originsQuery = trpc.hrDevices.pendingOrigins.useQuery(undefined, {
    refetchInterval: 60_000,
  });
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
      notify.ok(
        r.backfilled > 0
          ? `رُبط الموظف وأُلحق بـ${r.backfilled} بصمة سابقة`
          : "رُبط الموظف",
      );
      await refresh();
    },
    onError: (e) => notify.err(e),
  });
  const processFolds = trpc.hrDevices.processFolds.useMutation({
    onSuccess: async (r) => {
      notify.ok(
        `عولجت البصمات: ${r.days} يوم حضور${r.parked ? ` — ${r.parked} مركونة` : ""}`,
      );
      await refresh();
    },
    onError: (e) => notify.err(e),
  });

  const devices = list.data ?? [];
  const [query, setQuery] = useState("");
  const [deviceStatusFilter, setDeviceStatusFilter] = useState("all");
  const [deviceBranchFilter, setDeviceBranchFilter] = useState("all");
  const [deviceActionFilter, setDeviceActionFilter] = useState("all");
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const visibleDevices = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("ar");
    return devices.filter((d) => {
      const matchesQuery =
        !q ||
        [
          d.name,
          d.serialNumber,
          d.ip,
          d.branchName,
          d.location,
          d.model,
          d.status,
        ].some((v) =>
          String(v ?? "")
            .toLocaleLowerCase("ar")
            .includes(q),
        );
      const matchesStatus =
        deviceStatusFilter === "all" ||
        (deviceStatusFilter === "online" &&
          d.enabled &&
          d.status === "online") ||
        (deviceStatusFilter === "offline" &&
          d.enabled &&
          d.status !== "online") ||
        (deviceStatusFilter === "pending" && !d.enabled);
      const matchesBranch =
        deviceBranchFilter === "all" ||
        String(d.branchId ?? "none") === deviceBranchFilter;
      const matchesAction =
        deviceActionFilter === "all" ||
        (deviceActionFilter === "unmatched" && (d.pendingPunches ?? 0) > 0) ||
        (deviceActionFilter === "approval" && !d.enabled) ||
        (deviceActionFilter === "attention" &&
          (!d.enabled || d.status !== "online" || (d.pendingPunches ?? 0) > 0));
      return matchesQuery && matchesStatus && matchesBranch && matchesAction;
    });
  }, [
    devices,
    query,
    deviceStatusFilter,
    deviceBranchFilter,
    deviceActionFilter,
  ]);
  const total = devices.length;
  const bridgeOn = bridge.data?.enabled ?? false;
  const bridgePort = bridge.data?.port ?? HR_FINGERPRINT_TARGET.port;
  const onlineNow = bridge.data?.onlineDeviceIds?.length ?? 0;
  const needsAttention = devices.filter(
    (d) => !d.enabled || d.status !== "online" || (d.pendingPunches ?? 0) > 0,
  ).length;
  const pendingPunchesTotal = devices.reduce(
    (sum, d) => sum + (d.pendingPunches ?? 0),
    0,
  );
  const activeDeviceFilterCount =
    Number(deviceStatusFilter !== "all") +
    Number(deviceBranchFilter !== "all") +
    Number(deviceActionFilter !== "all");
  const selectedDevice = devices.find((d) => d.id === selectedDeviceId) ?? null;

  /** صفّا الجدولين — مشتقّان من مخرَج الاستعلام نفسه فلا ينجرفان عن عقد الخادم. */
  type DeviceRow = (typeof devices)[number];
  type PunchRow = NonNullable<(typeof punches)["data"]>["rows"][number];

  /*
   * أعمدة الأجهزة — داخل المكوّن لأنّها تقرأ الجهاز المختار وتُبدّله.
   * ⚠️ الأعمدةُ المخفيّة على الشاشات الصغيرة (`hidden md:table-cell`) لا مقابلَ لها في
   * `DataTable`؛ عوضُها التمريرُ الأفقيّ داخل حاوية الجدول ومنتقي الأعمدة.
   */
  const deviceColumns = useMemo<ColumnDef<DeviceRow, unknown>[]>(
    () => [
      {
        id: "device",
        header: "الجهاز",
        accessorFn: (d) => d.name,
        meta: { width: "wide" },
        cell: ({ row }) => {
          const d = row.original;
          const selected = d.id === selectedDeviceId;
          return (
            <button
              type="button"
              onClick={() => setSelectedDeviceId(d.id)}
              className="flex w-full items-center gap-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={`grid size-8 shrink-0 place-items-center rounded-lg ${selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
              >
                <ScanFace aria-hidden className="size-4.5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-semibold">{d.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground" dir="ltr">
                  {d.serialNumber ?? d.model ?? "—"}
                </span>
              </span>
            </button>
          );
        },
      },
      {
        id: "branch",
        header: "الفرع",
        accessorFn: (d) => d.branchName ?? "بلا فرع",
        cell: ({ row }) => (
          <span className="text-xs">
            <span className="block font-medium">{row.original.branchName ?? "بلا فرع"}</span>
            {row.original.location && (
              <span className="block truncate text-[11px] text-muted-foreground">{row.original.location}</span>
            )}
          </span>
        ),
      },
      {
        id: "status",
        header: "الحالة",
        accessorFn: (d) => (!d.enabled ? "بانتظار الاعتماد" : d.status === "online" ? "متصل" : "منقطع"),
        meta: { kind: "status" },
        cell: ({ row }) => {
          const d = row.original;
          const online = d.enabled && d.status === "online";
          return (
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-medium ${!d.enabled ? "text-[var(--sem-warn)]" : online ? "text-[var(--status-active)]" : "text-[var(--sem-neg)]"}`}
            >
              <Circle aria-hidden className="size-2 fill-current" />
              {!d.enabled ? "بانتظار الاعتماد" : online ? "متصل" : "منقطع"}
            </span>
          );
        },
      },
      {
        id: "lastSeen",
        header: "آخر إشارة",
        accessorFn: (d) => fmtRelativeTime(d.lastSeenAt),
        // نصٌّ نسبيّ بالعربية («قبل ٣ دقائق») لا تاريخٌ لاتينيّ ⇒ بلا عزل اتّجاه.
        meta: { align: "center", width: "date" },
        cell: ({ row }) => (
          <span className="text-[11px] text-muted-foreground">{fmtRelativeTime(row.original.lastSeenAt)}</span>
        ),
      },
      {
        id: "punches",
        header: "البصمات المستلمة",
        accessorFn: (d) => (d.receivedPunches ?? 0).toLocaleString("en-US"),
        meta: { kind: "number", align: "center" },
        cell: ({ row }) => (
          <span className="text-xs">
            <span className="font-semibold">{(row.original.receivedPunches ?? 0).toLocaleString("en-US")}</span>
            {(row.original.pendingPunches ?? 0) > 0 && (
              <span className="mt-0.5 block text-[10px] text-[var(--sem-warn)]">
                {row.original.pendingPunches} بلا موظف
              </span>
            )}
          </span>
        ),
      },
      {
        id: "open",
        header: "تفاصيل",
        meta: { kind: "actions" },
        cell: ({ row }) => (
          <button
            type="button"
            aria-label={`عرض تفاصيل ${row.original.name}`}
            onClick={() => setSelectedDeviceId(row.original.id)}
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft aria-hidden className="size-4" />
          </button>
        ),
      },
    ],
    [selectedDeviceId],
  );

  /** أعمدة طابور البصمات — كلّها مشتقّة من الصفّ وحده. */
  const punchColumns = useMemo<ColumnDef<PunchRow, unknown>[]>(
    () => [
      {
        id: "punchAt",
        header: "الوقت",
        accessorFn: (p) => String(p.punchAt),
        meta: { kind: "datetime", align: "start" },
        cell: ({ row }) => <span className="text-xs">{String(row.original.punchAt)}</span>,
      },
      {
        id: "device",
        header: "الجهاز",
        accessorFn: (p) => p.deviceName ?? p.serialNumber,
        cell: ({ row }) => <span className="text-xs">{row.original.deviceName ?? row.original.serialNumber}</span>,
      },
      {
        id: "enrollId",
        header: "رقم المستخدم",
        accessorFn: (p) => p.enrollId,
        meta: { kind: "number", align: "center" },
        cell: ({ row }) => <span className="text-xs">{row.original.enrollId}</span>,
      },
      {
        id: "employee",
        header: "الموظف",
        accessorFn: (p) => p.employeeName ?? "غير مربوط — اربطه من زر «الربط»",
        meta: { width: "wide" },
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.employeeName ?? (
              <span className="text-[var(--sem-warn)]">غير مربوط — اربطه من زر «الربط»</span>
            )}
          </span>
        ),
      },
      {
        id: "mode",
        header: "الوسيلة",
        accessorFn: (p) => p.mode ?? "—",
        meta: { align: "center" },
        cell: ({ row }) => <span className="text-xs">{row.original.mode ?? "—"}</span>,
      },
      {
        id: "processed",
        header: "المعالجة",
        accessorFn: (p) => (p.processedAt ? (p.processNote ? "مركونة" : "في الحضور") : "بالانتظار"),
        meta: { kind: "status" },
        cell: ({ row }) => {
          const p = row.original;
          return (
            <span className="text-xs">
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
            </span>
          );
        },
      },
    ],
    [],
  );
  const selectedOrigin = selectedDevice
    ? (pendingOrigins.find(
        (o) =>
          o.deviceId === selectedDevice.id ||
          (!!o.serialNumber && o.serialNumber === selectedDevice.serialNumber),
      ) ?? null)
    : null;
  // الوجهة التي تُكتب في الجهاز = النطاق الفرعي المملوك (لا مضيف لوحة الويب) — نطاق ثابت
  // يقبل تغيّر عنوان الخادم بتحديث DNS واحد بدل لمس كل جهاز.
  const myHost = HR_FINGERPRINT_TARGET.host;

  const employeeOptions = useMemo(() => opts.data?.managers ?? [], [opts.data]);

  useEffect(() => {
    if (visibleDevices.length === 0) {
      if (selectedDeviceId != null) setSelectedDeviceId(null);
      return;
    }
    if (!visibleDevices.some((d) => d.id === selectedDeviceId))
      setSelectedDeviceId(visibleDevices[0].id);
  }, [selectedDeviceId, visibleDevices]);

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

  const deleteDevice = async (d: (typeof devices)[number]) => {
    const ok = await confirm({
      variant: "danger",
      title: "حذف صفّ الجهاز",
      description: `حذف «${d.name}» (${d.serialNumber ?? "بلا سريال"}). متاح لأنّه غير معتمَد وبلا بصمات — صفوفٌ كهذه تنشأ تلقائياً من فحوص الاتصال.`,
      confirmText: "حذف",
    });
    if (ok) del.mutate({ id: d.id });
  };

  const actionsForDevice = (d: (typeof devices)[number]): RowAction[] => [
    {
      key: "approve",
      kind: "approve",
      label: "اعتماد الجهاز",
      icon: BadgeCheck,
      hidden: d.enabled,
      gate: { module: "hr", level: "FULL" },
      disabled: approve.isPending,
      disabledReason: "جارٍ اعتماد الجهاز",
      onSelect: () => approve.mutate({ id: d.id }),
    },
    {
      key: "edit",
      kind: "edit",
      label: "تعديل بيانات الجهاز",
      icon: Pencil,
      gate: { module: "hr", level: "FULL" },
      onSelect: () => startEdit(d),
    },
    {
      key: "map",
      kind: "edit",
      label: "ربط الموظفين",
      icon: Link2,
      hidden: !d.enabled,
      gate: { module: "hr", level: "FULL" },
      onSelect: () => setMapDeviceId(d.id),
    },
    {
      key: "logs",
      kind: "export",
      label: "سحب سجل البصمات",
      icon: DownloadCloud,
      hidden: !d.enabled,
      gate: { module: "hr", level: "FULL" },
      disabled: command.isPending,
      disabledReason: "الجهاز ينفّذ أمراً آخر",
      onSelect: () => command.mutate({ deviceId: d.id, cmd: "getalllog" }),
    },
    {
      key: "users",
      kind: "export",
      label: "سحب مستخدمي الجهاز",
      icon: Users,
      hidden: !d.enabled,
      gate: { module: "hr", level: "FULL" },
      disabled: command.isPending,
      disabledReason: "الجهاز ينفّذ أمراً آخر",
      onSelect: () => command.mutate({ deviceId: d.id, cmd: "getuserlist" }),
    },
    {
      key: "time",
      kind: "edit",
      label: "مزامنة ساعة الجهاز",
      icon: Clock3,
      hidden: !d.enabled,
      gate: { module: "hr", level: "FULL" },
      disabled: command.isPending,
      disabledReason: "الجهاز ينفّذ أمراً آخر",
      onSelect: () => command.mutate({ deviceId: d.id, cmd: "settime" }),
    },
    {
      key: "delete",
      kind: "delete",
      label: "حذف الجهاز",
      icon: Trash2,
      variant: "destructive",
      hidden: d.enabled,
      gate: { module: "hr", level: "FULL" },
      disabled: del.isPending,
      disabledReason: "جارٍ الحذف",
      onSelect: () => void deleteDevice(d),
    },
  ];

  const resetDeviceFilters = () => {
    setQuery("");
    setDeviceStatusFilter("all");
    setDeviceBranchFilter("all");
    setDeviceActionFilter("all");
  };

  const exportDevices = (format: "xlsx" | "csv") => {
    exportRows(visibleDevices, {
      filename: "أجهزة-الحضور",
      sheetName: "الأجهزة",
      format,
      columns: [
        { key: "name", header: "الجهاز" },
        { key: "serialNumber", header: "الرقم التسلسلي" },
        { key: "branchName", header: "الفرع" },
        { key: "location", header: "الموقع" },
        { key: "model", header: "الطراز" },
        { key: "status", header: "الحالة" },
        { key: "lastSeenAt", header: "آخر إشارة" },
        { key: "receivedPunches", header: "البصمات المستلمة" },
      ],
    });
  };

  const showDevicePunches = (deviceId: number) => {
    setPunchDeviceId(String(deviceId));
    setPunchOffset(0);
    window.setTimeout(
      () =>
        document
          .getElementById("device-punches")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  };

  const testDeviceConnection = async (deviceId: number) => {
    const result = await list.refetch();
    const fresh = result.data?.find((d) => d.id === deviceId);
    if (fresh?.status === "online")
      notify.ok("الجهاز متصل ويستقبل الخادم إشاراته الآن");
    else
      notify.warn(
        "لم تصل إشارة حديثة من الجهاز — راجع الشبكة وإعدادات الاتصال",
      );
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="أجهزة الحضور"
        description="إدارة الأجهزة ومتابعة وصول البصمات وحالات الربط."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={processFolds.isPending}
              onClick={() => processFolds.mutate()}
            >
              <ListChecks className="size-4" /> معالجة البصمات الآن
            </Button>
            <Button onClick={() => setOpenAdd(true)}>
              <Plus className="size-4" /> جهاز جديد
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y py-2.5 text-xs">
        <span
          className={`inline-flex items-center gap-2 font-semibold ${bridgeOn ? "text-[var(--status-active)]" : "text-[var(--sem-neg)]"}`}
        >
          <Circle aria-hidden className="size-2 fill-current" />
          {bridgeOn ? "خدمة الاستقبال تعمل" : "خدمة الاستقبال متوقفة"}
        </span>
        <span className="text-muted-foreground">
          <b className="text-foreground tabular-nums">{onlineNow}</b> متصل الآن
        </span>
        <span className="text-muted-foreground">
          <b className="text-[var(--sem-warn)] tabular-nums">
            {needsAttention}
          </b>{" "}
          يحتاج متابعة
        </span>
        <span className="text-muted-foreground">
          <b className="text-foreground tabular-nums">{pendingPunchesTotal}</b>{" "}
          بصمة غير مرتبطة
        </span>
        {pendingOrigins.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[var(--sem-warn)]">
            <ShieldQuestion aria-hidden className="size-3.5" />
            {pendingOrigins.length} طلب اتصال جديد
          </span>
        )}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="border-b p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex shrink-0 items-baseline gap-2">
                <CardTitle className="text-sm">الأجهزة</CardTitle>
                <span className="text-[11px] text-muted-foreground">
                  {visibleDevices.length} صف
                </span>
              </div>

              <div className="relative min-w-36 flex-1">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="ابحث عن جهاز…"
                  aria-label="البحث في الأجهزة"
                  className="h-8 ps-8 text-xs"
                />
              </div>

              <AppSelect
                aria-label="حالة الجهاز"
                className={selectCls + " h-8 !w-24 text-xs"}
                value={deviceStatusFilter}
                onValueChange={(next) => setDeviceStatusFilter(next)}
              >
                <option value="all">كل الحالات</option>
                <option value="online">متصل</option>
                <option value="offline">منقطع</option>
                <option value="pending">بانتظار الاعتماد</option>
              </AppSelect>

              <AppSelect
                aria-label="فرع الجهاز"
                className={selectCls + " h-8 !w-28 text-xs"}
                value={deviceBranchFilter}
                onValueChange={(next) => setDeviceBranchFilter(next)}
              >
                <option value="all">كل الفروع</option>
                <option value="none">بلا فرع</option>
                {(opts.data?.branches ?? []).map((branch) => (
                  <option key={branch.id} value={String(branch.id)}>
                    {branch.name}
                  </option>
                ))}
              </AppSelect>

              <AppSelect
                aria-label="الإجراء المطلوب"
                className={selectCls + " h-8 !w-32 text-xs"}
                value={deviceActionFilter}
                onValueChange={(next) => setDeviceActionFilter(next)}
              >
                <option value="all">كل الإجراءات</option>
                <option value="attention">يحتاج متابعة</option>
                <option value="unmatched">بصمات غير مرتبطة</option>
                <option value="approval">بانتظار الاعتماد</option>
              </AppSelect>

              {(activeDeviceFilterCount > 0 || query) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={FILTER_LABELS.reset}
                  title={FILTER_LABELS.reset}
                  onClick={resetDeviceFilters}
                >
                  <X aria-hidden className="size-3.5" />
                </Button>
              )}

              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="تحديث الأجهزة"
                title="تحديث"
                disabled={list.isFetching || bridge.isFetching}
                onClick={() => void refresh()}
              >
                <RefreshCcw
                  aria-hidden
                  className={`size-3.5 ${list.isFetching || bridge.isFetching ? "animate-spin" : ""}`}
                />
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="تصدير الأجهزة"
                    title="تصدير"
                  >
                    <DownloadCloud aria-hidden className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => exportDevices("xlsx")}>
                    <FileSpreadsheet aria-hidden />
                    تصدير Excel
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => exportDevices("csv")}>
                    <DownloadCloud aria-hidden />
                    تصدير CSV
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {/* مُضمَّن: العدّ والملاحظة في الشريط أسفله وترويسة البطاقة أعلاه — فلا شريطَ حالةٍ ثانٍ. */}
            <DataTable<DeviceRow>
              embedded
              columns={deviceColumns}
              data={visibleDevices}
              /* البحث والفلاتر في ترويسة البطاقة (تُغذّي visibleDevices) — بلا هذا يظهر حقلا
                 بحثٍ متجاوران، وتُعلن الشاشةُ «لا أجهزة بعد» بينما الفلترُ وحده هو الحاجب. */
              searchable={false}
              externalFiltersActive={activeDeviceFilterCount > 0 || query.trim() !== ""}
              pageSize={Infinity}
              loading={list.isLoading}
              errorState={{ isError: list.isError, message: "تعذّر تحميل الأجهزة.", onRetry: () => void list.refetch() }}
              onRowClick={(d) => setSelectedDeviceId(d.id)}
              /* `!` مقصود: `odd:bg-background` على الصفّ أعلى خصوصيّةً من صنفٍ مجرّد ⇒ بلا
                 !important يختفي تمييزُ الجهاز المختار على الصفوف الفردية (وهو المؤشّر الوحيد
                 بعد أن سقط `aria-selected` بالتحويل). */
              getRowClassName={(d) => (d.id === selectedDeviceId ? "!bg-primary/10" : undefined)}
              emptyState="لا أجهزة بعد. أضف جهازاً أو وجّهه إلى الخادم ليظهر هنا."
              emptyFilteredState="لا توجد أجهزة مطابقة للبحث والفلاتر."
            />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-[11px] text-muted-foreground">
              <span>
                عرض {visibleDevices.length} من {total} جهاز
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Activity aria-hidden className="size-3.5" /> تحديث تلقائي كل 15
                ثانية
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden xl:sticky xl:top-3">
          {selectedDevice ? (
            <>
              <CardHeader className="space-y-4 border-b">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">
                      {selectedDevice.name}
                    </CardTitle>
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <MapPin aria-hidden className="size-3.5" />
                      {selectedDevice.branchName ?? "بلا فرع"}
                      {selectedDevice.location
                        ? ` · ${selectedDevice.location}`
                        : ""}
                    </p>
                  </div>
                  <RowActions
                    mode="menu"
                    align="start"
                    label={`إجراءات ${selectedDevice.name}`}
                    actions={actionsForDevice(selectedDevice)}
                  />
                </div>

                <div className="flex items-center gap-3">
                  <span
                    className={`grid size-11 place-items-center rounded-lg ${!selectedDevice.enabled ? "badge-stock-low" : selectedDevice.status === "online" ? "badge-status-active" : "badge-stock-out"}`}
                  >
                    {selectedDevice.status === "online" &&
                    selectedDevice.enabled ? (
                      <Wifi aria-hidden className="size-5" />
                    ) : (
                      <WifiOff aria-hidden className="size-5" />
                    )}
                  </span>
                  <div>
                    <div
                      className={`text-lg font-bold ${!selectedDevice.enabled ? "text-[var(--sem-warn)]" : selectedDevice.status === "online" ? "text-[var(--status-active)]" : "text-[var(--sem-neg)]"}`}
                    >
                      {!selectedDevice.enabled
                        ? "بانتظار الاعتماد"
                        : selectedDevice.status === "online"
                          ? "متصل الآن"
                          : "غير متصل"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      آخر إشارة: {fmtRelativeTime(selectedDevice.lastSeenAt)}
                    </div>
                  </div>
                </div>

                {!selectedDevice.enabled ? (
                  <Button
                    disabled={approve.isPending}
                    onClick={() => approve.mutate({ id: selectedDevice.id })}
                  >
                    <BadgeCheck aria-hidden className="size-4" /> اعتماد الجهاز
                  </Button>
                ) : (
                  <Button onClick={() => showDevicePunches(selectedDevice.id)}>
                    <Fingerprint aria-hidden className="size-4" /> عرض البصمات
                  </Button>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selectedDevice.enabled}
                    onClick={() => void testDeviceConnection(selectedDevice.id)}
                  >
                    <Activity aria-hidden className="size-4" /> اختبار الاتصال
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selectedDevice.enabled}
                    onClick={() => setMapDeviceId(selectedDevice.id)}
                  >
                    <Users aria-hidden className="size-4" /> ربط الموظفين
                  </Button>
                </div>
              </CardHeader>

              <CardContent className="space-y-5 p-4">
                {selectedOrigin && (
                  <div className="space-y-2 rounded-lg border border-[color-mix(in_oklch,var(--sem-warn)_35%,transparent)] bg-[var(--sem-warn-bg)] p-3">
                    <div className="flex items-start gap-2">
                      <ShieldQuestion
                        aria-hidden
                        className="mt-0.5 size-4 shrink-0 text-[var(--sem-warn)]"
                      />
                      <div>
                        <div className="text-xs font-semibold">
                          محاولة اتصال من عنوان جديد
                        </div>
                        <div
                          className="mt-0.5 text-[11px] text-muted-foreground"
                          dir="ltr"
                        >
                          {selectedOrigin.ip}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={trustOrigin.isPending}
                        onClick={() =>
                          trustOrigin.mutate({
                            id: selectedOrigin.id,
                            ...(selectedOrigin.deviceId == null
                              ? { deviceId: selectedDevice.id }
                              : {}),
                          })
                        }
                      >
                        اعتماد
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={dismissOrigin.isPending}
                        onClick={() =>
                          dismissOrigin.mutate({ id: selectedOrigin.id })
                        }
                      >
                        رفض
                      </Button>
                    </div>
                  </div>
                )}

                <section>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <Activity
                      aria-hidden
                      className="size-4 text-muted-foreground"
                    />{" "}
                    التشغيل
                  </h3>
                  <dl className="space-y-2 text-xs">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">
                        البصمات المستلمة
                      </dt>
                      <dd className="font-semibold tabular-nums">
                        {(selectedDevice.receivedPunches ?? 0).toLocaleString(
                          "en-US",
                        )}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">آخر مزامنة</dt>
                      <dd>{fmtRelativeTime(selectedDevice.lastHandshakeAt)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">مستخدمو الجهاز</dt>
                      <dd className="tabular-nums">
                        {selectedDevice.usersCount ?? 0}
                      </dd>
                    </div>
                  </dl>
                </section>

                <section className="border-t pt-4">
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <Link2
                      aria-hidden
                      className="size-4 text-muted-foreground"
                    />{" "}
                    الربط
                  </h3>
                  <dl className="space-y-2 text-xs">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">الفرع</dt>
                      <dd>{selectedDevice.branchName ?? "غير محدد"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">الموقع</dt>
                      <dd>{selectedDevice.location ?? "غير محدد"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">
                        بصمات تحتاج ربطاً
                      </dt>
                      <dd
                        className={
                          (selectedDevice.pendingPunches ?? 0) > 0
                            ? "font-semibold text-[var(--sem-warn)]"
                            : "text-muted-foreground"
                        }
                      >
                        {selectedDevice.pendingPunches ?? 0}
                      </dd>
                    </div>
                  </dl>
                </section>

                <section className="border-t pt-4">
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <ScanFace
                      aria-hidden
                      className="size-4 text-muted-foreground"
                    />{" "}
                    معلومات الجهاز
                  </h3>
                  <dl className="space-y-2 text-xs">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">الرقم التسلسلي</dt>
                      <dd className="max-w-44 truncate font-mono" dir="ltr">
                        {selectedDevice.serialNumber ?? "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">الطراز</dt>
                      <dd>{selectedDevice.model ?? "—"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">إصدار البرنامج</dt>
                      <dd className="font-mono" dir="ltr">
                        {selectedDevice.firmware ?? "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">البروتوكول</dt>
                      <dd>
                        {PROTOCOL_LABELS[selectedDevice.protocol ?? ""] ??
                          selectedDevice.protocol ??
                          "—"}
                      </dd>
                    </div>
                  </dl>
                </section>

                <Button
                  variant="outline"
                  className="w-full justify-between"
                  onClick={() => setGuideOpen(true)}
                >
                  <span className="inline-flex items-center gap-2">
                    <Settings2 aria-hidden className="size-4" /> إعدادات الاتصال
                  </span>
                  <ChevronLeft aria-hidden className="size-4" />
                </Button>
              </CardContent>
            </>
          ) : (
            <CardContent className="grid min-h-72 place-items-center p-6 text-center">
              <div>
                <ScanFace
                  aria-hidden
                  className="mx-auto mb-3 size-8 text-muted-foreground"
                />
                <p className="text-sm font-semibold">
                  اختر جهازاً لعرض تفاصيله
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  ستظهر هنا حالة الاتصال والربط والإجراءات المتاحة.
                </p>
              </div>
            </CardContent>
          )}
        </Card>
      </div>

      {/* البصمات الخام */}
      <Card id="device-punches" className="scroll-mt-4">
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
              <AppSelect
                className="h-9"
                value={punchDeviceId}
                onValueChange={(next) => setPunchDeviceId(next)}
                aria-label="الجهاز"
              >
                <option value="">كل الأجهزة</option>
                {devices.map((d) => (
                  <option key={d.id} value={String(d.id)}>
                    {d.name}
                  </option>
                ))}
              </AppSelect>
            </FilterField>
            <FilterField label="الموظف">
              <AppSelect
                className="h-9"
                value={punchEmployeeId}
                onValueChange={(next) => setPunchEmployeeId(next)}
                aria-label="الموظف"
              >
                <option value="">كل الموظفين</option>
                {employeeOptions.map((emp) => (
                  <option key={emp.id} value={String(emp.id)}>
                    {emp.name}
                  </option>
                ))}
              </AppSelect>
            </FilterField>
            <FilterField label="من تاريخ">
              <Input
                type="date"
                dir="ltr"
                value={punchDateFrom}
                onChange={(e) => setPunchDateFrom(e.target.value)}
                className="h-9 w-36"
                aria-label="من تاريخ"
              />
            </FilterField>
            <FilterField label="إلى تاريخ">
              <Input
                type="date"
                dir="ltr"
                value={punchDateTo}
                onChange={(e) => setPunchDateTo(e.target.value)}
                className="h-9 w-36"
                aria-label="إلى تاريخ"
              />
            </FilterField>
            {punchFiltersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={resetPunchFilters}
                className="text-muted-foreground"
              >
                <X aria-hidden className="size-4" /> {FILTER_LABELS.reset}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* ترقيمٌ خادميّ (offset + hasMore) — استبدل زرَّي «الأحدث/الأقدم» اليدويَّين كي لا
             يقفز شريطان بمقدارَين مختلفَين فتُتخطّى صفوفٌ بصمت. */}
          <DataTable<PunchRow>
            columns={punchColumns}
            data={punches.data?.rows ?? []}
            /* الفلاتر في ترويسة البطاقة أعلاه (تُغذّي الاستعلام) — بلا هذا يظهر حقلا بحثٍ متجاوران. */
            searchable={false}
            externalFiltersActive={punchFiltersActive || unmatchedOnly}
            loading={punches.isLoading}
            errorState={{ isError: punches.isError, message: punches.error?.message, onRetry: () => void punches.refetch() }}
            serverPagination={{
              page: Math.floor(punchOffset / 25),
              onPageChange: (next) => setPunchOffset(next * 25),
              pageSize: 25,
              hasMore: punches.data?.hasMore,
              isFetching: punches.isFetching,
            }}
            emptyText="لا بصمات واردة بعد — ستظهر هنا لحظة وصولها من الأجهزة."
          />
        </CardContent>
      </Card>

      {/* حوار ربط مستخدمي الجهاز بالموظفين */}
      <Dialog
        open={mapDeviceId != null}
        onOpenChange={(o) => {
          if (!o) {
            setMapDeviceId(null);
            setDeviceUserQuery("");
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>ربط مستخدمي الجهاز بالموظفين</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground -mt-1">
            كل رقم في الجهاز يقابله موظف في النظام — بعد الربط تُحتسب بصماته
            حضوراً تلقائياً (حتى السابقة منها). إن كانت القائمة فارغة اسحب
            المستخدمين من الجهاز بزر «المستخدمون».
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
          {/* شبكةُ تحرير لا عرض (موجة الجداول ٢/٩/٢٦): كل صفٍّ يحمل `AppSelect` يربط رقمَ
              الجهاز بموظّف ويُطلق `mapUser.mutate` مباشرةً — `DataTable` أداةُ عرضٍ فتبقى هذه
              خامّةً عن قصد. جدولا الأجهزة والبصمات في الشاشة نفسها محوَّلان أصلاً. */}
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
                    <td className="p-2 text-center tabular-nums">
                      {u.enrollId}
                    </td>
                    <td className="p-2 text-xs">{u.name ?? "—"}</td>
                    <td className="p-2 text-center text-xs">
                      {u.hasBackup ? "نعم" : "—"}
                    </td>
                    <td className="p-2">
                      <AppSelect
                        className="h-9"
                        value={u.employeeId ? String(u.employeeId) : ""}
                        onValueChange={(next) =>
                          mapDeviceId != null &&
                          mapUser.mutate({
                            deviceId: mapDeviceId,
                            enrollId: u.enrollId,
                            employeeId: next
                              ? Number(next)
                              : null,
                          })
                        }
                      >
                        <option value="">— غير مربوط —</option>
                        {employeeOptions.map((emp) => (
                          <option key={emp.id} value={String(emp.id)}>
                            {emp.name}
                          </option>
                        ))}
                      </AppSelect>
                    </td>
                  </tr>
                ))}
                {!deviceUsers.isLoading && visibleDeviceUsers.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="p-4 text-center text-xs text-muted-foreground"
                    >
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
              اضبط:{" "}
              <span dir="ltr" className="font-mono text-xs">
                Server Req = Yes
              </span>
            </li>
            <li>
              فعّل النطاق:{" "}
              <span dir="ltr" className="font-mono text-xs">
                Use domainNm = Yes
              </span>
            </li>
            <li>
              ثم اكتب:{" "}
              <span dir="ltr" className="font-mono text-xs">
                DomainNm = {myHost}
              </span>
            </li>
            <li>
              والمنفذ:{" "}
              <span dir="ltr" className="font-mono text-xs">
                SerPortNo = {bridgePort}
              </span>
            </li>
            <li>
              احفظ وأعد تشغيل الجهاز — سيظهر خلال دقيقة في الجدول أعلاه (متصل /
              بانتظار الاعتماد).
            </li>
            <li>
              أجهزة ZKTeco: نفس الفكرة من قائمة Cloud Server Setting (ADMS) بنفس
              النطاق والمنفذ.
            </li>
          </ol>
          <p className="text-[11px] text-muted-foreground">
            بديلٌ للنطاق:{" "}
            <span dir="ltr" className="font-mono text-xs">
              Use domainNm = No
            </span>{" "}
            ثم
            <span dir="ltr" className="font-mono text-xs">
              {" "}
              Server IP ={" "}
            </span>{" "}
            عنوان الخادم الرقمي — لكن النطاق أفضل (تغيّر عنوان الخادم يُحلّ
            بتحديث DNS واحد بلا لمس الأجهزة).
          </p>
          <p className="text-[11px] text-muted-foreground">
            يحتفظ الجهاز بالسجلات الموجودة في ذاكرته، ويعيد إرسالها تلقائياً بعد
            الاتصال. ويمكن طلب السجل كاملاً من قائمة إجراءات الجهاز.
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
            <DialogTitle>
              {editId != null ? "تعديل جهاز حضور" : "إضافة جهاز حضور"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="d-name">اسم الجهاز</Label>
              <Input
                id="d-name"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="جهاز البصمة — المدخل الرئيسي"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-sn">الرقم التسلسلي (SN)</Label>
              <Input
                id="d-sn"
                dir="ltr"
                value={form.serialNumber}
                onChange={(e) =>
                  setForm((f) => ({ ...f, serialNumber: e.target.value }))
                }
                placeholder="ZXRB06004623"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-proto">نوع الجهاز</Label>
              <AppSelect
                id="d-proto"
                className="h-9"
                value={form.protocol}
                onValueChange={(next) =>
                  setForm((f) => ({ ...f, protocol: next }))
                }
              >
                {Object.entries(PROTOCOL_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </AppSelect>
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
                onChange={(e) =>
                  setForm((f) => ({ ...f, model: e.target.value }))
                }
                placeholder="AI518 وجه + بطاقة"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-location">الموقع</Label>
              <Input
                id="d-location"
                value={form.location}
                onChange={(e) =>
                  setForm((f) => ({ ...f, location: e.target.value }))
                }
                placeholder="بوابة الفرع الرئيسي"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-branch">الفرع</Label>
              <AppSelect
                id="d-branch"
                className="h-9"
                value={form.branchId}
                onValueChange={(next) =>
                  setForm((f) => ({ ...f, branchId: next }))
                }
              >
                <option value="">— بلا فرع —</option>
                {(opts.data?.branches ?? []).map((b) => (
                  <option key={b.id} value={String(b.id)}>
                    {b.name}
                  </option>
                ))}
              </AppSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-code">معرّف الجهاز (Device ID)</Label>
              <Input
                id="d-code"
                dir="ltr"
                value={form.deviceCode}
                onChange={(e) =>
                  setForm((f) => ({ ...f, deviceCode: e.target.value }))
                }
                placeholder="1"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            عند التسجيل المسبق يلزم ربط الرقم التسلسلي بعنوان جهاز فريد. الشبكات
            المشتركة أو NAT تحتاج مفتاح جهاز خاصاً في إعداد الخادم. لا تُقبل
            بصمات الجهاز المكتشف قبل الاعتماد.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenAdd(false)}>
              إلغاء
            </Button>
            <Button
              disabled={create.isPending || update.isPending}
              onClick={submit}
            >
              {create.isPending || update.isPending
                ? "جارٍ…"
                : editId != null
                  ? "حفظ"
                  : "إضافة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
