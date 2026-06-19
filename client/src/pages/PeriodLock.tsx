/**
 * إقفال الفترات المالية — adminProcedure.
 * يعرض الـlock النشِط ويوفّر آلية إنشاء/فتح (admin فقط).
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const t = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleDateString("ar-IQ-u-nu-latn", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export default function PeriodLockPage() {
  const utils = trpc.useUtils();
  const status = trpc.periodLock.status.useQuery();
  const [cutoffDate, setCutoffDate] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const lockMut = trpc.periodLock.lock.useMutation({
    onSuccess: () => {
      toast.success("تم قفل الفترة بنجاح");
      utils.periodLock.status.invalidate();
      setCutoffDate("");
      setNotes("");
    },
    onError: (e) => toast.error(e.message),
  });

  const unlockMut = trpc.periodLock.unlock.useMutation({
    onSuccess: () => {
      toast.success("تم فتح أحدث قفل");
      utils.periodLock.status.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const lock = status.data?.lock;

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold">إقفال الفترات المالية</h1>

      <Card>
        <CardHeader className="font-semibold">القفل النشِط</CardHeader>
        <CardContent>
          {status.isLoading ? (
            <p className="text-muted-foreground">جاري التحميل…</p>
          ) : lock ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-muted-foreground">تاريخ الإقفال:</div>
                <div className="font-medium">{fmtDate(lock.cutoffDate)}</div>
                <div className="text-muted-foreground">تاريخ التطبيق:</div>
                <div>{fmtDate(lock.lockedAt)}</div>
                <div className="text-muted-foreground">ملاحظات:</div>
                <div>{lock.notes ?? "—"}</div>
              </div>
              <p className="text-sm text-amber-700 bg-amber-50 rounded p-2">
                ⚠️ أي قيد محاسبي بتاريخ ≤ {fmtDate(lock.cutoffDate)} سيُرفَض.
              </p>
              <Button
                variant="destructive"
                onClick={async () => {
                  if (await confirm({ title: "فتح القفل", description: "هل أنت متأكد من فتح أحدث قفل؟ هذا يسمح بكتابة قيود تاريخية.", variant: "danger" })) {
                    unlockMut.mutate();
                  }
                }}
                disabled={unlockMut.isPending}
              >
                فتح أحدث قفل
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">لا قفل نشِط — كل التواريخ مفتوحة للكتابة.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="font-semibold">إنشاء قفل جديد</CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2">
            <label className="text-sm font-medium">تاريخ الإقفال (cutoff)</label>
            <input
              type="date"
              value={cutoffDate}
              onChange={(e) => setCutoffDate(e.target.value)}
              className="h-9 px-3 rounded-md border bg-transparent text-sm"
            />
            <p className="text-xs text-muted-foreground">القيود بتاريخ ≤ هذا التاريخ ستُرفَض.</p>
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">ملاحظات (اختياري)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={255}
              placeholder="مثل: إقفال شهر يناير ٢٠٢٦"
              className="h-9 px-3 rounded-md border bg-transparent text-sm"
            />
          </div>
          <Button
            onClick={() => {
              if (!cutoffDate) {
                toast.error("اختر تاريخ الإقفال");
                return;
              }
              lockMut.mutate({ cutoffDate, notes: notes.trim() || undefined });
            }}
            disabled={lockMut.isPending}
          >
            تطبيق القفل
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
