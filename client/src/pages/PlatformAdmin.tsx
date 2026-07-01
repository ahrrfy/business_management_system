/**
 * PlatformAdmin — شاشة إدارة الشركات لمدير المنصّة (تعدد الشركات بعزل قاعدة فعلي).
 *
 * مسار مخصّص `/platform-admin` منفصل تماماً عن `/login` وعن AppLayout — مصادقته
 * الخاصة (كوكي/JWT منفصلان، راجع server/tenancy/platformAuth.ts) لا تمنح أي وصول
 * لبيانات أي شركة، فقط لعرض/تفعيل/تعطيل سجلّات erp_control.companies. لا إنشاء
 * شركة من هنا عمداً — التوفير عملية تشغيلية (`pnpm company:new`) تناسب CLI.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

function CompaniesDashboard() {
  const utils = trpc.useUtils();
  const companies = trpc.platformAdmin.companies.list.useQuery();
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
                لا شركات بعد — أضف شركة عبر: <code dir="ltr">pnpm company:new &lt;رمز&gt; "&lt;اسم&gt;" --admin-email ... --admin-password ...</code>
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
