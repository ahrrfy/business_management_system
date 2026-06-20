import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CredentialsShare } from "@/components/form/CredentialsShare";
import { isStrongPassword } from "@shared/const";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { ROLE_OPTIONS, ROLE_LABEL } from "./Users";
import { ROLES, type RoleKey } from "@/lib/permissionsModel";

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
  const [username, setUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [usernameChecked, setUsernameChecked] = useState(false);
  const [role, setRole] = useState<RoleKey>("cashier");
  const [branchId, setBranchId] = useState<string>("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [loaded, setLoaded] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [mustChangeOnReset, setMustChangeOnReset] = useState(true);
  const [resetShare, setResetShare] = useState<{ password: string; email: string; username?: string; name: string; phone?: string } | null>(null);

  useEffect(() => {
    if (detail.data && !loaded) {
      const u = detail.data;
      setName(u.name ?? "");
      setEmail(u.email ?? "");
      setUsername((u as { username?: string | null }).username ?? "");
      setRole((u.role as RoleKey) ?? "cashier");
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
    onSuccess: (_, vars) => {
      setPwMsg("تمّت إعادة تعيين كلمة المرور؛ أُبطِلت جلسات المستخدم.");
      setResetShare({
        password: vars.newPassword,
        email: detail.data?.email ?? "",
        username: (detail.data as { username?: string | null })?.username ?? undefined,
        name: detail.data?.name ?? "",
        phone: (detail.data as any)?.phone ?? undefined,
      });
      setNewPassword("");
    },
    onError: (e) => setPwMsg(e.message),
  });
  const generatePw = trpc.users.generatePassword.useQuery(undefined, { enabled: false });

  async function handleGeneratePassword() {
    try {
      const res = await utils.users.generatePassword.fetch();
      setNewPassword(res.password);
    } catch {
      const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$%!";
      setNewPassword(Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""));
    }
  }

  async function checkUsernameFn() {
    const v = username.trim().toLowerCase();
    if (!v) { setUsernameError(""); setUsernameChecked(false); return; }
    if (!/^[a-z][a-z0-9._-]{2,31}$/.test(v)) {
      setUsernameError("٣–٣٢ خانة، يبدأ بحرف إنجليزي، حروف/أرقام/نقطة/شرطة فقط.");
      setUsernameChecked(false);
      return;
    }
    try {
      const ok = await utils.users.checkUsername.fetch({ username: v, excludeUserId: userId });
      setUsernameError(ok ? "" : "اسم المستخدم مستخدم مسبقاً.");
      setUsernameChecked(true);
    } catch { setUsernameChecked(false); }
  }

  function submit() {
    setError(""); setDone("");
    if (!name.trim()) return setError("الاسم مطلوب.");
    if (usernameError) return setError(usernameError);
    const emailV = email.trim().toLowerCase();
    const usernameV = username.trim().toLowerCase();
    if (!emailV && !usernameV) return setError("يجب إبقاء بريد إلكتروني أو اسم مستخدم واحد على الأقل.");
    if (emailV && !/^\S+@\S+\.\S+$/.test(emailV)) return setError("بريد إلكتروني غير صالح.");
    if (usernameV && !/^[a-z][a-z0-9._-]{2,31}$/.test(usernameV)) return setError("اسم مستخدم غير صالح — ٣–٣٢ خانة تبدأ بحرف إنجليزي.");
    // نرسل القيمتين دائماً: "" ⇒ مسح المعرّف صراحةً (الخادم يضمن بقاء معرّف واحد على الأقل).
    update.mutate({ userId, name: name.trim(), email: emailV, username: usernameV, role, branchId: branchId ? Number(branchId) : null });
  }

  function doReset() {
    setPwMsg(""); setResetShare(null);
    if (!isStrongPassword(newPassword))
      return setPwMsg("كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي حرفاً ورقماً ورمزاً.");
    resetPassword.mutate({ userId, newPassword, mustChangePassword: mustChangeOnReset });
  }

  const roleInfo = ROLES.find((r) => r.key === role);

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
          <div><div className="text-muted-foreground text-xs">اسم المستخدم</div><div className="font-mono" dir="ltr">{(u as { username?: string | null }).username || "—"}</div></div>
          <div><div className="text-muted-foreground text-xs">الدور الحالي</div><div>{ROLE_LABEL[u.role] ?? u.role}</div></div>
          <div>
            <div className="text-muted-foreground text-xs">الحالة</div>
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${isActive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
              {isActive ? "مفعّل" : "معطّل"}
            </span>
          </div>
          {(u as any).mustChangePassword && (
            <div>
              <div className="text-muted-foreground text-xs">كلمة المرور</div>
              <span className="text-xs text-amber-600 font-medium">⚠️ تغيير إلزامي</span>
            </div>
          )}
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
            <Label htmlFor="username">اسم المستخدم (للدخول)</Label>
            <Input
              id="username" dir="ltr" value={username}
              onChange={(e) => { setUsername(e.target.value); setUsernameChecked(false); setUsernameError(""); }}
              onBlur={() => void checkUsernameFn()}
              placeholder="مثال: marwa.ibrahim"
              className={usernameError ? "border-destructive" : usernameChecked && !usernameError ? "border-emerald-500" : ""}
            />
            {usernameError && <p className="text-[11px] text-destructive">{usernameError}</p>}
            {usernameChecked && !usernameError && username.trim() && <p className="text-[11px] text-emerald-600">✓ اسم المستخدم متاح</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="email">البريد الإلكتروني <span className="text-muted-foreground font-normal">(اختياري)</span></Label>
            <Input id="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@alroya.local" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="role">الدور</Label>
            <select id="role" className={selectCls} value={role} onChange={(e) => setRole(e.target.value as RoleKey)}>
              {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            {roleInfo && <p className="text-[11px] text-muted-foreground">{roleInfo.description}</p>}
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
            onClick={() => void (async () => {
              if (!(await confirm({ variant: "danger", title: "تعطيل المستخدم", description: `لن يستطيع «${name || u.email}» الدخول وتُبطَل جلساته فوراً. هل تتابع؟`, confirmText: "تعطيل" }))) return;
              setActive.mutate({ userId, isActive: false });
            })()}
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

      {/* إعادة تعيين كلمة المرور */}
      <Card>
        <CardHeader><CardTitle className="text-base">إعادة تعيين كلمة المرور</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            يضبط كلمة مرور جديدة ويُبطل كل جلسات المستخدم الحالية.
          </p>
          <div className="flex flex-wrap gap-2 items-end">
            <div className="space-y-1 flex-1 min-w-[200px]">
              <div className="flex items-center justify-between">
                <Label htmlFor="newpw">كلمة المرور الجديدة</Label>
                <Button type="button" variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={handleGeneratePassword}>
                  ⚡ توليد
                </Button>
              </div>
              <Input id="newpw" type="text" dir="ltr" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="8 أحرف على الأقل" className="font-mono" />
            </div>
            <Button variant="outline" onClick={doReset} disabled={resetPassword.isPending}>
              {resetPassword.isPending ? "…" : "إعادة التعيين"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="mustChangeReset" className="size-4" checked={mustChangeOnReset} onChange={(e) => setMustChangeOnReset(e.target.checked)} />
            <Label htmlFor="mustChangeReset" className="font-normal cursor-pointer text-sm">إلزام تغيير الكلمة عند أول دخول (72 ساعة)</Label>
          </div>
          {pwMsg && <p className={`text-sm ${resetPassword.isSuccess ? "text-emerald-600" : "text-destructive"}`}>{pwMsg}</p>}
          {resetShare && (
            <CredentialsShare
              name={resetShare.name}
              email={resetShare.email}
              username={resetShare.username}
              password={resetShare.password}
              phone={resetShare.phone}
              onClose={() => setResetShare(null)}
            />
          )}
        </CardContent>
      </Card>

      void generatePw;
    </div>
  );
}
