import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN_LEN, isStrongPassword } from "@shared/const";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ROLE_OPTIONS } from "./Users";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export default function UserNew() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<(typeof ROLE_OPTIONS)[number]["value"]>("cashier");
  const [branchId, setBranchId] = useState<string>("");
  const [error, setError] = useState("");

  const branches = trpc.branches.list.useQuery();

  const create = trpc.users.create.useMutation({
    onSuccess: async () => {
      await utils.users.list.invalidate();
      navigate("/users");
    },
    onError: (e) => setError(e.message),
  });

  function submit() {
    setError("");
    if (!name.trim()) return setError("اسم المستخدم مطلوب.");
    if (!email.trim()) return setError("البريد الإلكتروني مطلوب.");
    if (!isStrongPassword(password))
      return setError(`كلمة المرور يجب أن تكون ${PASSWORD_MIN_LEN} أحرف على الأقل وتحتوي حرفاً ورقماً.`);
    create.mutate({
      name: name.trim(),
      email: email.trim(),
      password,
      role,
      branchId: branchId ? Number(branchId) : null,
    });
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">إضافة مستخدم</h1>
        <Link href="/users" className="text-sm text-muted-foreground">← رجوع للقائمة</Link>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">بيانات الدخول</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label htmlFor="name">الاسم *</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: عبد الله الكاشير" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="email">البريد الإلكتروني *</Label>
            <Input id="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@alroya.local" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">كلمة المرور *</Label>
            <Input id="password" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="٨ أحرف على الأقل، حرف ورقم" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">الدور والفرع</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>
          {create.isPending ? "جارٍ الحفظ…" : "حفظ المستخدم"}
        </Button>
        <Link href="/users"><Button variant="outline">إلغاء</Button></Link>
      </div>
    </div>
  );
}
