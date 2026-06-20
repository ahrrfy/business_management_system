import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { useLocation } from "wouter";

export default function Login() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const login = trpc.auth.login.useMutation({
    onSuccess: async (data) => {
      // refetch (not invalidate): force-await the fresh session so the route
      // guard sees the authenticated user immediately, avoiding a redirect race.
      await utils.auth.me.refetch();
      // كلمة مرور مؤقتة تستوجب التغيير الفوري → وجّه لصفحة الحساب
      if (data.mustChangePassword) {
        navigate("/account?mustChange=1");
      } else {
        navigate("/");
      }
    },
    onError: (e) => setError(e.message),
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-xl">نظام إدارة الأعمال — الرؤية العربية</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError("");
              login.mutate({ identifier: identifier.trim(), password });
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="identifier">البريد الإلكتروني أو اسم المستخدم</Label>
              <Input id="identifier" type="text" dir="ltr" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">كلمة المرور</Label>
              <Input id="password" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} required />
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
