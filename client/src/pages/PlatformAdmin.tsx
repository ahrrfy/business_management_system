/**
 * PlatformAdmin — شاشة إدارة الشركات لمدير المنصّة (تعدد الشركات بعزل قاعدة فعلي).
 *
 * مسار مخصّص `/platform-admin` منفصل تماماً عن `/login` وعن AppLayout — مصادقته
 * الخاصة (كوكي/JWT منفصلان، راجع server/tenancy/platformAuth.ts) لا تمنح أي وصول
 * لبيانات أي شركة، فقط لعرض/تفعيل/تعطيل سجلّات erp_control.companies + طلب توفير
 * شركة جديدة (طابور — التوفير الفعلي ينفّذه عامل منفصل بصلاحيات مرتفعة، راجع تعليق
 * platformAdminRouter.ts.companies.requestCreate).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, CheckCircle2, CopyIcon, XCircle } from "lucide-react";
import { fmtDateTime } from "@/lib/date";
import { trpc } from "@/lib/trpc";

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

const CODE_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "قيد الانتظار",
  PROCESSING: "جارٍ التوفير…",
  DONE: "تمّ بنجاح",
  FAILED: "فشل",
};

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "DONE"
      ? "bg-money-positive/15 text-money-positive"
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
  return (
    <div className="rounded-lg border border-money-positive/40 bg-money-positive/5 p-3 space-y-2">
      <p className="text-sm font-semibold text-money-positive inline-flex items-center gap-1">
        <CheckCircle2 aria-hidden className="size-4" /> طُلِب التوفير — احفظ كلمة المرور الآن
      </p>
      <div className="font-mono text-sm space-y-1" dir="ltr">
        <div>{adminEmail}</div>
        <div>{adminUsername}</div>
        <div className="font-bold tracking-wider">{tempPassword}</div>
      </div>
      <p className="text-xs text-amber-600 inline-flex items-center gap-1">
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
      setError("رمز الشركة بحروف صغيرة/أرقام/شُرَط فقط (kebab-case)، بين حرفين و٤٠ حرفاً.");
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
          {requestCreate.isPending ? "…" : "طلب توفير الشركة"}
        </Button>

        {reveal && (
          <div className="space-y-2">
            <TempPasswordReveal adminEmail={reveal.adminEmail} adminUsername={reveal.adminUsername} tempPassword={reveal.tempPassword} />
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">حالة التوفير:</span>
              {status.data ? <StatusBadge status={status.data.status} /> : <span className="text-muted-foreground">…</span>}
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

  return (
    <div dir="rtl" className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-extrabold">إدارة المنصّة — الشركات</h1>
          <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
            تسجيل الخروج
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">الشركات المسجَّلة</CardTitle>
          </CardHeader>
          <CardContent>
            {companies.isLoading && <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>}
            {companies.data && companies.data.length === 0 && (
              <p className="text-sm text-muted-foreground">
                لا شركات بعد — أضف شركة عبر النموذج أدناه، أو من الطرفية: <code dir="ltr">pnpm company:new &lt;رمز&gt; "&lt;اسم&gt;" --admin-email ... --admin-password ...</code>
              </p>
            )}
            {companies.data && companies.data.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b text-right text-xs font-bold text-muted-foreground">
                      <th className="px-2 py-2">الرمز</th>
                      <th className="px-2 py-2">الاسم</th>
                      <th className="px-2 py-2">القاعدة</th>
                      <th className="px-2 py-2">أُنشئت</th>
                      <th className="px-2 py-2">مفعّلة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {companies.data.map((c) => (
                      <tr key={c.id} className="border-b">
                        <td className="px-2 py-2 font-mono" dir="ltr">{c.code}</td>
                        <td className="px-2 py-2">{c.name}</td>
                        <td className="px-2 py-2 font-mono text-xs text-muted-foreground" dir="ltr">{c.dbName}</td>
                        <td className="px-2 py-2 text-xs text-muted-foreground" dir="ltr">
                          {new Date(c.createdAt).toLocaleDateString("ar-IQ")}
                        </td>
                        <td className="px-2 py-2">
                          <Switch
                            checked={c.isActive}
                            onCheckedChange={(v) => setActive.mutate({ id: c.id, isActive: v })}
                            disabled={setActive.isPending}
                            aria-label={`تفعيل/تعطيل ${c.name}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <NewCompanyForm />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">آخر طلبات التوفير</CardTitle>
          </CardHeader>
          <CardContent>
            {provisionRequests.isLoading && <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>}
            {provisionRequests.data && provisionRequests.data.length === 0 && (
              <p className="text-sm text-muted-foreground">لا طلبات بعد.</p>
            )}
            {provisionRequests.data && provisionRequests.data.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b text-right text-xs font-bold text-muted-foreground">
                      <th className="px-2 py-2">الرمز</th>
                      <th className="px-2 py-2">الاسم</th>
                      <th className="px-2 py-2">الحالة</th>
                      <th className="px-2 py-2">وقت الطلب</th>
                    </tr>
                  </thead>
                  <tbody>
                    {provisionRequests.data.map((r) => (
                      <tr key={r.id} className="border-b align-top">
                        <td className="px-2 py-2 font-mono" dir="ltr">{r.code}</td>
                        <td className="px-2 py-2">{r.name}</td>
                        <td className="px-2 py-2">
                          <StatusBadge status={r.status} />
                          {r.status === "FAILED" && r.errorMessage && (
                            <p className="text-xs text-destructive mt-1 max-w-xs truncate" title={r.errorMessage}>{r.errorMessage}</p>
                          )}
                        </td>
                        <td className="px-2 py-2 text-xs text-muted-foreground" dir="ltr">{fmtDateTime(r.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
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
