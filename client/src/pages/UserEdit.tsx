import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN_LEN, isStrongPassword } from "@shared/const";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { ROLE_LABEL, ROLE_OPTIONS } from "./Users";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function UserEdit() {
  const [, params] = useRoute<{ id: string }>("/users/:id/edit");
  const utils = trpc.useUtils();
  const userId = Number(params?.id ?? 0);

  const detail = trpc.users.get.useQuery({ userId }, { enabled: userId > 0 });
  const branches = trpc.branches.list.useQuery();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLE_OPTIONS)[number]["value"]>("cashier");
  const [branchId, setBranchId] = useState<string>("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [loaded, setLoaded] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [pwMsg, setPwMsg] = useState("");

  useEffect(() => {
    if (detail.data && !loaded) {
      const u = detail.data;
      setName(u.name ?? "");
      setEmail(u.email ?? "");
      setRole((u.role as (typeof ROLE_OPTIONS)[number]["value"]) ?? "cashier");
      setBranchId(u.branchId ? String(u.branchId) : "");
      setLoaded(true);
    }
  }, [detail.data, loaded]);

  function invalidate() {
    return Promise.all([utils.users.list.invalidate(), utils.users.get.invalidate({ userId })]);
  }

  const update = trpc.users.update.useMutation({
    onSuccess: async () => { setDone("تمّ حفظ التعديلات بنجاح."); await invalidate(); },
    onError: (e) => setError(e.message),
  });
  const setActive = trpc.users.setActive.useMutation({
    onSuccess: async () => { await invalidate(); },
    onError: (e) => setError(e.message),
  });
  const resetPassword = trpc.users.resetPassword.useMutation({
    onSuccess: () => { setPwMsg("تمّت إعادة تعيين كلمة المرور؛ أُبطِلت جلسات المستخدم."); setNewPassword(""); },
    onError: (e) => setPwMsg(e.message),
  });

  function submit() {
    setError("");
    setDone("");
    if (!name.trim()) return setError("اسم المستخدم مطلوب.");
    if (!email.trim()) return setError("البريد الإلكتروني مطلوب.");
    update.mutate({
      userId,
      name: name.trim(),
      email: email.trim(),
      role,
      branchId: branchId ? Number(branchId) : null,
    });
  }

  function doReset() {
    setPwMsg("");
    if (!isStrongPassword(newPassword))
      return setPwMsg(`كلمة المرور يجب أن تكون ${PASSWORD_MIN_LEN} أحرف على الأقل وتحتوي حرفاً ورقماً.`);
    resetPassword.mutate({ userId, newPassword });
  }

  if (!userId) return <div className="p-6 text-center text-muted-foreground">معرّف مستخدم غير صالح.</div>;
  if (detail.isLoading) return <div className="p-6 text-center text-muted-foreground">جارٍ تحميل بيانات المستخدم…</div>;
  if (!detail.data) return <div className="p-6 text-center text-muted-foreground">المستخدم غير موجود. <Link className="text-primary underline" href="/users">رجوع للقائمة</Link></div>;

  const u = detail.data;
  const isActive = !!u.isActive;

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">تعديل مستخدم</h1>
        <Link href="/users" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">بطاقة المستخدم</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-muted-foreground text-xs">المعرّف</div><div className="font-mono" dir="ltr">#{Number(u.id)}</div></div>
          <div><div className="text-muted-foreground text-xs">الدور الحالي</div><div>{ROLE_LABEL[u.role] ?? u.role}</div></div>
          <div>
            <div className="text-muted-foreground text-xs">الحالة</div>
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
              {isActive ? "مفعّل" : "معطّل"}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">البيانات الأساسية</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="name">الاسم *</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="email">البريد الإلكتروني *</Label>
            <Input id="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="role">الدور</Label>
            <select id="role" className={selectCls} value={role} onChange={(e) => setRole(e.target.value as any)}>
              {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="branch">الفرع</Label>
            <select id="branch" className={selectCls} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">— بلا فرع —</option>
              {(branches.data ?? []).map((b) => <option key={Number(b.id)} value={String(b.id)}>{b.name}</option>)}
            </select>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && <p className="text-sm text-emerald-600">{done}</p>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={submit} disabled={update.isPending}>
          {update.isPending ? "جارٍ الحفظ…" : "حفظ التعديلات"}
        </Button>
        {isActive ? (
          <Button
            variant="outline"
            onClick={() => { if (confirm("تأكيد تعطيل المستخدم؟ تُبطَل جلساته فوراً.")) setActive.mutate({ userId, isActive: false }); }}
            disabled={setActive.isPending}
          >
            {setActive.isPending ? "…" : "تعطيل المستخدم"}
          </Button>
        ) : (
          <Button variant="outline" onClick={() => setActive.mutate({ userId, isActive: true })} disabled={setActive.isPending}>
            {setActive.isPending ? "…" : "إعادة تفعيل"}
          </Button>
        )}
        <Link href="/users"><Button variant="ghost">رجوع</Button></Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">إعادة تعيين كلمة المرور</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            يضع كلمة مرور جديدة للمستخدم ويُبطل كل جلساته الحالية (يجبره على دخول جديد).
          </p>
          <div className="flex flex-wrap gap-2 items-end">
            <div className="space-y-1 flex-1 min-w-[220px]">
              <Label htmlFor="newpw">كلمة المرور الجديدة</Label>
              <Input id="newpw" type="password" dir="ltr" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="٨ أحرف على الأقل، حرف ورقم" />
            </div>
            <Button variant="outline" onClick={doReset} disabled={resetPassword.isPending}>
              {resetPassword.isPending ? "…" : "إعادة التعيين"}
            </Button>
          </div>
          {pwMsg && <p className={`text-sm ${resetPassword.isSuccess ? "text-emerald-600" : "text-destructive"}`}>{pwMsg}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
