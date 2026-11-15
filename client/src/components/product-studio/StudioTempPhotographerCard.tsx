import React, { useState } from "react";
import { Clock, Copy, KeyRound, Loader2, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

interface IssuedTempAccount {
  userId: number;
  name: string;
  username: string;
  code: string;
  expiresAt: string | Date;
}

export function StudioTempPhotographerCard() {
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<IssuedTempAccount | null>(null);

  const listQuery = trpc.productStudio.listTemporaryStudioPhotographers.useQuery(undefined, {
    staleTime: 30_000,
  });

  const createMutation = trpc.productStudio.createTemporaryStudioPhotographer.useMutation({
    onSuccess: (res) => {
      setIssued(res);
      setName("");
      toast.success("تم إصدار الحساب المؤقت لمدة 24 ساعة");
      void listQuery.refetch();
    },
    onError: (err) => {
      toast.error(err.message || "تعذر إصدار الحساب المؤقت");
    },
  });

  const revokeMutation = trpc.productStudio.revokeTemporaryStudioPhotographer.useMutation({
    onSuccess: () => {
      toast.success("تم إلغاء وحذف الحساب المؤقت");
      void listQuery.refetch();
    },
    onError: (err) => {
      toast.error(err.message || "تعذر إلغاء الحساب المؤقت");
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 3) {
      toast.error("اكتب اسم الموظف (3 أحرف على الأقل)");
      return;
    }
    createMutation.mutate({ name: trimmed, hoursValid: 24 });
  };

  const handleCopy = async (account: IssuedTempAccount) => {
    const text = `حساب تصوير مؤقت (24 ساعة)\nالاسم: ${account.name}\nاسم المستخدم: ${account.username}\nكلمة المرور: ${account.code}`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("تم نسخ بيانات الدخول المؤقت");
    } catch {
      toast.info(`اسم المستخدم: ${account.username} | الرمز: ${account.code}`);
    }
  };

  const activeList = listQuery.data ?? [];

  return (
    <Card className="border-border/60" data-testid="studio-temp-photographer-card">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4 text-primary" />
              <span>حساب تصوير مؤقت (24 ساعة)</span>
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              للموظف الذي لا يملك حساباً في النظام — يفتح الاستوديو فقط ويُحذف تلقائياً بعد 24 ساعة.
            </CardDescription>
          </div>
          <Badge variant="outline" className="gap-1 text-xs">
            <Clock className="size-3" />
            <span>صلاحية 24 ساعة</span>
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <form onSubmit={handleCreate} className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="اسم الموظف المؤقت (مثال: أحمد علي)"
            className="h-11 flex-1"
            minLength={3}
            maxLength={80}
          />
          <Button
            type="submit"
            disabled={createMutation.isPending || name.trim().length < 3}
            className="h-11 gap-2 px-5"
          >
            {createMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <UserPlus className="size-4" />
            )}
            <span>إصدار حساب 24 ساعة</span>
          </Button>
        </form>

        {issued && (
          <div
            className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2"
            data-testid="temp-account-credentials"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-primary">
                تم إنشاء حساب «{issued.name}» — يُنسخ الآن (لا يظهر الرمز مرة أخرى)
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleCopy(issued)}
                className="gap-1.5"
              >
                <Copy className="size-3.5" />
                <span>نسخ الدخول</span>
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 sm:text-sm">
              <div className="rounded bg-background/80 px-2.5 py-1.5">
                <span className="text-muted-foreground">اسم المستخدم: </span>
                <code className="font-mono font-bold select-all">{issued.username}</code>
              </div>
              <div className="rounded bg-background/80 px-2.5 py-1.5">
                <span className="text-muted-foreground">كلمة المرور: </span>
                <code className="font-mono font-bold select-all">{issued.code}</code>
              </div>
            </div>
          </div>
        )}

        {activeList.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              الحسابات المؤقتة النشطة حالياً ({activeList.length})
            </p>
            <div className="divide-y divide-border/60 rounded-lg border border-border/60">
              {activeList.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="font-medium truncate">{item.name}</div>
                    <div className="text-xs text-muted-foreground">
                      <code className="font-mono">{item.username}</code>
                      {item.expiresAt && (
                        <> · ينتهي: {new Date(item.expiresAt).toLocaleString("ar-IQ-u-nu-latn")}</>
                      )}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive gap-1"
                    disabled={revokeMutation.isPending}
                    onClick={() => revokeMutation.mutate({ userId: item.id })}
                  >
                    <Trash2 className="size-3.5" />
                    <span>إلغاء فوري</span>
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
