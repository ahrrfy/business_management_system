/**
 * PlatformAdmin — شاشة إدارة الشركات لمدير المنصّة (تعدد الشركات بعزل قاعدة فعلي).
 *
 * مسار مخصّص `/platform-admin` منفصل تماماً عن `/login` وعن AppLayout — مصادقته
 * الخاصة (كوكي/JWT منفصلان، راجع server/tenancy/platformAuth.ts) لا تمنح أي وصول
 * لبيانات أي شركة، فقط لعرض/تفعيل/تعطيل سجلّات erp_control.companies + طلب توفير
 * شركة جديدة (طابور — التوفير الفعلي ينفّذه عامل منفصل بصلاحيات مرتفعة، راجع تعليق
 * platformAdminRouter.ts.companies.requestCreate).
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DataTable } from "@/components/data-table/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { AlertTriangle, CheckCircle2, CopyIcon, XCircle } from "lucide-react";
import { fmtDate, fmtDateTime, toDate, type DateInput } from "@/lib/date";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
import { ACTION_LABELS } from "@shared/actionLabels";

/** فرزٌ زمنيّ على الطابع الخامّ: نصّ العرض «21/06/2026» يُفرَز باليوم لا بالتاريخ. */
const cmpTime = (a: DateInput, b: DateInput) => {
  const ta = toDate(a)?.getTime() ?? -Infinity;
  const tb = toDate(b)?.getTime() ?? -Infinity;
  return ta === tb ? 0 : ta < tb ? -1 : 1;
};

type PlatformAuditRow = RouterOutputs["platformAdmin"]["audit"]["list"]["rows"][number];
type CompanyRow = RouterOutputs["platformAdmin"]["companies"]["list"][number];
type ProvisionRequestRow = RouterOutputs["platformAdmin"]["companies"]["provisionRequests"][number];

const PLATFORM_ACTION_LABELS: Record<string, string> = {
  login: "تسجيل دخول",
  logout: "تسجيل خروج",
  "company.setActive": "تغيير حالة شركة",
  "company.requestCreate": "طلب توفير شركة",
};

function platformAuditDetails(row: PlatformAuditRow): Record<string, unknown> {
  return row.details !== null && typeof row.details === "object" && !Array.isArray(row.details)
    ? row.details as Record<string, unknown>
    : {};
}

function platformAuditDetailLabel(row: PlatformAuditRow): string {
  const details = platformAuditDetails(row);
  if (row.action === "company.setActive" && typeof details.isActive === "boolean") {
    return details.isActive ? "تفعيل الشركة" : "تعطيل الشركة";
  }
  if (row.action === "company.requestCreate") {
    return [details.name, details.code, details.requestId != null ? `طلب #${details.requestId}` : null]
      .filter((value) => value != null && String(value).trim())
      .map(String)
      .join(" · ") || "طلب توفير شركة";
  }
  return "لا تفاصيل إضافية";
}

function PlatformAdminLoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const login = trpc.platformAdmin.login.useMutation({
    onSuccess: () => onSuccess(),
    onError: (e) => setError(e.message),
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-xl">إدارة المنصّة — الشركات</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError("");
              login.mutate({ email: email.trim(), password });
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="pa-email">البريد الإلكتروني</Label>
              <Input id="pa-email" type="email" dir="ltr" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pa-password">كلمة المرور</Label>
              <Input id="pa-password" type="password" dir="ltr" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={login.isPending}>
              {login.isPending ? "جارٍ الدخول…" : "دخول"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// 2..40 محرفاً — مطابقٌ لعقد الخادم `z.string().min(2).max(40)`. كان `{1,38}` (أي 2..39)
// فيرفض المحرّر رمزاً من 40 يقبله الخادم، برسالةٍ تعد بـ 40 — شاشةٌ تحجب ما يملكه الخادم.
const CODE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "قيد الانتظار",
  PROCESSING: "جارٍ التوفير…",
  DONE: "تمّ بنجاح",
  FAILED: "فشل",
};

function StatusBadge({ status }: { status: string }) {
  // حالةُ توفيرٍ لا مبلغ: الأخضر هنا يقول «اكتمل» لا «مبلغ موجب» ⇒ صنف الحالة الجاهز
  // `badge-status-active` بدل توكن المال `money-positive` الذي كان مستعمَلاً هنا.
  const cls =
    status === "DONE"
      ? "badge-status-active"
      : status === "FAILED"
      ? "bg-destructive/15 text-destructive"
      : "bg-muted text-muted-foreground";
  return <span className={`text-xs rounded-full px-2 py-0.5 ${cls}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** بطاقة كشف كلمة المرور المؤقّتة **مرّة واحدة فقط** — لا تُستعمَل CredentialsShare (مصمّمة
 *  لموظفٍ له فرع/هاتف واتساب، سياق مختلف تماماً عن مدير شركة جديدة). */
function TempPasswordReveal({
  adminEmail,
  adminUsername,
  tempPassword,
}: {
  adminEmail: string;
  adminUsername: string;
  tempPassword: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = `البريد: ${adminEmail}\nاسم المستخدم: ${adminUsername}\nكلمة المرور المؤقّتة: ${tempPassword}`;
  // نجاحُ إجراءٍ لا مبلغ ⇒ تِنت `--sem-pos` الدلاليّ بدل `money-positive`.
  return (
    <div className="rounded-lg border border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] p-3 space-y-2">
      <p className="text-sm font-semibold text-[var(--sem-pos)] inline-flex items-center gap-1">
        <CheckCircle2 aria-hidden className="size-4" /> طُلِب التوفير — احفظ كلمة المرور الآن
      </p>
      <div className="font-mono text-sm space-y-1" dir="ltr">
        <div>{adminEmail}</div>
        <div>{adminUsername}</div>
        <div className="font-bold tracking-wider">{tempPassword}</div>
      </div>
      <p className="text-xs text-[var(--sem-warn)] inline-flex items-center gap-1">
        <AlertTriangle aria-hidden className="size-3.5" /> لن تُعرَض هذه الكلمة مجدداً — سيُطلب من مدير الشركة تغييرها عند أول دخول.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="gap-1"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          } catch { /* تجاهل */ }
        }}
      >
        <CopyIcon className="h-4 w-4" /> {copied ? "تمّ النسخ!" : "نسخ الكل"}
      </Button>
    </div>
  );
}

function NewCompanyForm() {
  const utils = trpc.useUtils();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminUsername, setAdminUsername] = useState("admin");
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState("");
  const [reveal, setReveal] = useState<{ requestId: number; tempPassword: string; adminEmail: string; adminUsername: string } | null>(null);

  const requestCreate = trpc.platformAdmin.companies.requestCreate.useMutation({
    onSuccess: (res, vars) => {
      setReveal({ requestId: res.requestId, tempPassword: res.tempPassword, adminEmail: vars.adminEmail, adminUsername: vars.adminUsername ?? "admin" });
      setCode(""); setName(""); setAdminEmail(""); setAdminUsername("admin"); setDemo(false);
      void utils.platformAdmin.companies.provisionRequests.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const status = trpc.platformAdmin.companies.provisionStatus.useQuery(
    { requestId: reveal?.requestId ?? 0 },
    {
      enabled: !!reveal,
      refetchInterval: (query) => {
        const s = query.state.data?.status;
        return s === "DONE" || s === "FAILED" ? false : 3000;
      },
    }
  );

  useEffect(() => {
    if (status.data?.status === "DONE") void utils.platformAdmin.companies.list.invalidate();
  }, [status.data?.status, utils]);

  function submit() {
    setError("");
    if (!CODE_RE.test(code.trim())) {
      setError("رمز الشركة بحروف صغيرة/أرقام/شُرَط فقط (kebab-case)، بين حرفين و40 حرفاً.");
      return;
    }
    if (!name.trim()) return setError("أدخل اسم الشركة.");
    if (!adminEmail.trim()) return setError("أدخل بريد مدير الشركة.");
    requestCreate.mutate({ code: code.trim(), name: name.trim(), adminEmail: adminEmail.trim(), adminUsername: adminUsername.trim() || "admin", demo });
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">شركة جديدة</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          يُنشئ طلب توفير (قاعدة بيانات فعلية + مستخدم مخصّص + مخطّط + بذرة) — عامل خلفي منفصل
          ينفّذه خلال دقائق (لا خادم الويب). تابع الحالة أدناه أو في «آخر الطلبات».
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="nc-code">رمز الشركة (kebab-case)</Label>
            <Input id="nc-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} placeholder="sister-co" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nc-name">اسم الشركة</Label>
            <Input id="nc-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nc-email">بريد مدير الشركة</Label>
            <Input id="nc-email" type="email" dir="ltr" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nc-username">اسم مستخدم مدير الشركة</Label>
            <Input id="nc-username" dir="ltr" value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input type="checkbox" id="nc-demo" className="size-4" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
          <Label htmlFor="nc-demo" className="font-normal cursor-pointer text-sm">بذرة عيّنة (منتجات/مورد تجريبي) بدل بذرة إنتاج نظيفة</Label>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={submit} disabled={requestCreate.isPending}>
          {requestCreate.isPending ? ACTION_LABELS.sending : "طلب توفير الشركة"}
        </Button>

        {reveal && (
          <div className="space-y-2">
            <TempPasswordReveal adminEmail={reveal.adminEmail} adminUsername={reveal.adminUsername} tempPassword={reveal.tempPassword} />
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">حالة التوفير:</span>
              {status.data ? (
                <StatusBadge status={status.data.status} />
              ) : status.isError ? (
                // لا نَعِد بتحميلٍ جارٍ بينما الاستعلام ساقط: المؤشّر الأبديّ يخفي خطأً يملكه الخادم.
                <span className="inline-flex items-center gap-1 text-destructive text-xs">
                  <XCircle aria-hidden className="size-3.5" /> {status.error?.message ?? "خطأ غير معروف"}
                </span>
              ) : (
                <span className="text-muted-foreground">{ACTION_LABELS.loading}</span>
              )}
              {status.data?.status === "FAILED" && (
                <span className="inline-flex items-center gap-1 text-destructive text-xs">
                  <XCircle aria-hidden className="size-3.5" /> {status.data.errorMessage ?? "خطأ غير معروف"}
                </span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlatformAuditTable() {
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const audit = trpc.platformAdmin.audit.list.useQuery({ limit: pageSize, offset: page * pageSize });
  const columns = useMemo<ColumnDef<PlatformAuditRow, unknown>[]>(() => [
    {
      accessorKey: "success",
      header: "النتيجة",
      // عمودُ نتيجةٍ (meta.kind = "status") لا عمودُ مال ⇒ `--sem-pos` لا `money-positive`.
      cell: ({ row }) => (
        <span className={row.original.success ? "font-medium text-[var(--sem-pos)]" : "font-medium text-destructive"}>
          {row.original.success ? "نجحت" : "فشلت"}
        </span>
      ),
      meta: { kind: "status", align: "center" },
    },
    {
      accessorKey: "ipAddress",
      header: "IP",
      cell: ({ row }) => row.original.ipAddress ?? "غير متاح",
      meta: { kind: "code" },
    },
    {
      id: "details",
      header: "التفاصيل",
      accessorFn: platformAuditDetailLabel,
      cell: ({ row }) => <span className="whitespace-normal text-sm">{platformAuditDetailLabel(row.original)}</span>,
      meta: { kind: "text", width: "wide", wrap: true },
    },
  ], []);
  const operation = useMemo(() => ({
    mode: "columns" as const,
    getOperation: (row: PlatformAuditRow) => {
      const details = platformAuditDetails(row);
      const subjectId = row.companyId ?? details.requestId ?? details.code;
      return {
        actor: { name: row.actorEmail, source: "platform" as const },
        action: {
          code: row.action,
          label: row.action === "company.setActive" && typeof details.isActive === "boolean"
            ? (details.isActive ? "تفعيل شركة" : "تعطيل شركة")
            : PLATFORM_ACTION_LABELS[row.action] ?? row.action,
        },
        subject: { type: "company", label: "شركة/طلب", id: subjectId as string | number | null | undefined },
        at: row.createdAt,
      };
    },
  }), []);

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">سجلّ حركات إدارة المنصّة</CardTitle></CardHeader>
      <CardContent className="p-0">
        <DataTable
          data={audit.data?.rows ?? []}
          columns={columns}
          operation={operation}
          loading={audit.isLoading}
          errorState={{ isError: audit.isError, message: "تعذّر تحميل سجلّ المنصّة.", onRetry: () => void audit.refetch() }}
          searchable={false}
          emptyText="لا حركات مسجّلة بعد."
          viewKey="platform-audit"
          getRowId={(row) => String(row.id)}
          serverPagination={{
            page,
            onPageChange: setPage,
            pageSize,
            total: audit.data?.total ?? 0,
          }}
        />
      </CardContent>
    </Card>
  );
}

function CompaniesDashboard() {
  const utils = trpc.useUtils();
  const companies = trpc.platformAdmin.companies.list.useQuery();
  const provisionRequests = trpc.platformAdmin.companies.provisionRequests.useQuery();
  const logout = trpc.platformAdmin.logout.useMutation({
    onSuccess: () => utils.platformAdmin.me.invalidate(),
  });
  const setActive = trpc.platformAdmin.companies.setActive.useMutation({
    onSuccess: () => companies.refetch(),
  });

  // أعمدة الشركات — داخل المكوّن لأنّ مفتاح التفعيل يستدعي الطفرة `setActive`.
  const companyColumns = useMemo<ColumnDef<CompanyRow, unknown>[]>(() => [
    { id: "code", header: "الرمز", accessorFn: (c) => c.code, meta: { kind: "code", width: "id" }, cell: ({ row }) => row.original.code },
    { id: "name", header: "الاسم", accessorFn: (c) => c.name, meta: { width: "wide" }, cell: ({ row }) => row.original.name },
    { id: "dbName", header: "القاعدة", accessorFn: (c) => c.dbName, meta: { kind: "code" }, cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.dbName}</span> },
    { id: "createdAt", header: "أُنشئت", accessorFn: (c) => fmtDate(c.createdAt), meta: { kind: "date" }, sortingFn: (a, b) => cmpTime(a.original.createdAt, b.original.createdAt), cell: ({ row }) => <span className="text-xs text-muted-foreground">{fmtDate(row.original.createdAt)}</span> },
    {
      id: "isActive",
      header: "مفعّلة",
      accessorFn: (c) => (c.isActive ? "مفعّلة" : "معطّلة"),
      enableSorting: false,
      meta: { align: "center", width: "status" },
      cell: ({ row }) => (
        <Switch
          checked={row.original.isActive}
          onCheckedChange={(v) => setActive.mutate({ id: row.original.id, isActive: v })}
          disabled={setActive.isPending}
          aria-label={`تفعيل/تعطيل ${row.original.name}`}
        />
      ),
    },
  ], [setActive]);

  const provisionRequestColumns = useMemo<ColumnDef<ProvisionRequestRow, unknown>[]>(() => [
    { id: "code", header: "الرمز", accessorFn: (r) => r.code, meta: { kind: "code", width: "id" }, cell: ({ row }) => row.original.code },
    { id: "name", header: "الاسم", accessorFn: (r) => r.name, meta: { width: "wide" }, cell: ({ row }) => row.original.name },
    {
      id: "status",
      header: "الحالة",
      // التسمية العربية لا الرمز الخامّ — «نسخ القيمة» يطابق ما يقرأه المستعمِل.
      accessorFn: (r) => STATUS_LABEL[r.status] ?? r.status,
      meta: { kind: "status", wrap: true },
      cell: ({ row }) => (
        <div className="flex flex-col items-center gap-1">
          <StatusBadge status={row.original.status} />
          {row.original.status === "FAILED" && row.original.errorMessage && (
            <p className="text-xs text-destructive max-w-xs truncate" title={row.original.errorMessage}>{row.original.errorMessage}</p>
          )}
        </div>
      ),
    },
    { id: "createdAt", header: "وقت الطلب", accessorFn: (r) => fmtDateTime(r.createdAt), meta: { kind: "datetime" }, sortDescFirst: true, sortingFn: (a, b) => cmpTime(a.original.createdAt, b.original.createdAt), cell: ({ row }) => <span className="text-xs text-muted-foreground">{fmtDateTime(row.original.createdAt)}</span> },
  ], []);

  return (
    <div dir="rtl" className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        {/* رأسُ صفحةٍ حقيقيّ ⇒ `PageHeader` هو مصدرُ `h1` الوحيد (نمطٌ موحَّد + وصف + منطقة إجراءات)
            بدل `h1` يدويٍّ بنمطٍ خاصّ بجانب زرٍّ في `justify-between`.
            `homeHref={null}`: هذه الشاشة على مسارٍ منفصلٍ تماماً عن AppLayout بمصادقةٍ خاصّة بها
            (كوكي/JWT المنصّة — لا تمنح وصولاً لبيانات أيّ شركة)، فرابطُ «الرئيسية» إلى `/` يقذف
            مديرَ المنصّة إلى تطبيق الشركة حيث لا جلسةَ له = مخرجٌ مسدود لا اختصار. */}
        <PageHeader
          title="إدارة المنصّة — الشركات"
          description="الشركات المسجَّلة وطلبات التوفير وسجلّ التدقيق — إدارةٌ على مستوى المنصّة، منفصلةٌ عن بيانات أيّ شركة."
          homeHref={null}
          actions={
            <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
              تسجيل الخروج
            </Button>
          }
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">الشركات المسجَّلة</CardTitle>
          </CardHeader>
          <CardContent>
            {/* مُضمَّن: العنوان في رأس البطاقة، والقائمة قصيرة بطبيعتها (شركات المنصّة) فلا ترقيم. */}
            <DataTable<CompanyRow>
              embedded
              searchable={false}
              bounded={false}
              pageSize={Infinity}
              columns={companyColumns}
              data={companies.data ?? []}
              loading={companies.isLoading}
              errorState={{ isError: companies.isError, message: companies.error ? `تعذّر تحميل الشركات: ${companies.error.message}` : undefined, onRetry: () => companies.refetch() }}
              emptyState={
                <span>
                  لا شركات بعد — أضف شركة عبر النموذج أدناه، أو من الطرفية: <code dir="ltr">pnpm company:new &lt;رمز&gt; "&lt;اسم&gt;" --admin-email ... --admin-password ...</code>
                </span>
              }
            />
          </CardContent>
        </Card>

        <NewCompanyForm />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">آخر طلبات التوفير</CardTitle>
          </CardHeader>
          <CardContent>
            {/* مُضمَّن: العنوان في رأس البطاقة، والقائمة «آخر الطلبات» محدودة خادمياً. */}
            <DataTable<ProvisionRequestRow>
              embedded
              searchable={false}
              bounded={false}
              pageSize={Infinity}
              columns={provisionRequestColumns}
              data={provisionRequests.data ?? []}
              loading={provisionRequests.isLoading}
              errorState={{ isError: provisionRequests.isError, message: provisionRequests.error ? `تعذّر تحميل طلبات التوفير: ${provisionRequests.error.message}` : undefined, onRetry: () => provisionRequests.refetch() }}
              emptyText="لا طلبات بعد."
            />
          </CardContent>
        </Card>

        <PlatformAuditTable />
      </div>
    </div>
  );
}

export default function PlatformAdmin() {
  const me = trpc.platformAdmin.me.useQuery();

  if (me.isLoading) return null;
  if (!me.data) return <PlatformAdminLoginForm onSuccess={() => me.refetch()} />;
  return <CompaniesDashboard />;
}
