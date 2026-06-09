import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { getServerBridgeStatus } from "@/lib/printing/print";
import { useEffect, useState } from "react";
import { toast } from "sonner";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function Settings() {
  const utils = trpc.useUtils();
  const backups = trpc.system.listBackups.useQuery();
  const backupNow = trpc.system.backupNow.useMutation({
    onSuccess: async (r) => {
      toast.success(r.created ? `أُنشئت نسخة: ${r.created.name} (${r.created.sizeKb} ك.ب)` : "تمّت النسخة الاحتياطية");
      await utils.system.listBackups.invalidate();
    },
    onError: (e) => toast.error(e.message || "فشلت النسخة الاحتياطية"),
  });

  const [bridge, setBridge] = useState<{ enabled: boolean; description: string }>({ enabled: false, description: "" });
  useEffect(() => {
    getServerBridgeStatus().then(setBridge).catch(() => { /* تجاهل */ });
  }, []);

  const list = backups.data?.backups ?? [];

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-2xl font-bold">الإعدادات</h1>

      {/* النسخ الاحتياطي */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">النسخ الاحتياطي</CardTitle>
          <Button onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
            {backupNow.isPending ? "جارٍ النسخ…" : "نسخة احتياطية الآن"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            نسخة كاملة لقاعدة البيانات (mysqldump ذرّي). تُجرى تلقائياً يومياً 2ص أيضاً.
            <br />
            الاستعادة تتمّ عبر سطر الأوامر لأمانها: <code dir="ltr" className="font-mono">pnpm db:restore &lt;ملف&gt; --confirm RESTORE</code>
          </p>

          {backups.isLoading ? (
            <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground">لا توجد نسخ بعد — اضغط «نسخة احتياطية الآن».</p>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="text-right font-medium px-3 py-2">الملف</th>
                    <th className="text-left font-medium px-3 py-2">الحجم</th>
                    <th className="text-left font-medium px-3 py-2">التاريخ</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((b) => (
                    <tr key={b.name} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs" dir="ltr">{b.name}</td>
                      <td className="px-3 py-2 text-left tabular-nums">{b.sizeKb} ك.ب</td>
                      <td className="px-3 py-2 text-left tabular-nums" dir="ltr">{fmtDate(b.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* الطباعة */}
      <Card>
        <CardHeader><CardTitle className="text-base">الطباعة</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <div className="flex items-center gap-2">
            <span className={bridge.enabled ? "text-emerald-600" : "text-muted-foreground"}>
              {bridge.enabled ? "●" : "○"}
            </span>
            <span>جسر الطباعة الصامتة على الخادم: <b>{bridge.enabled ? "مفعّل" : "غير مفعّل"}</b></span>
          </div>
          <p className="text-xs text-muted-foreground">
            {bridge.enabled
              ? `الوجهة: ${bridge.description}. تُطبع فواتير الكاشير صامتةً دون حوار المتصفّح.`
              : "اضبط PRINT_TARGET في .env لتفعيل الطباعة الصامتة (tcp://ip:9100 أو share://Name)."}
          </p>
        </CardContent>
      </Card>

      {/* الصيانة */}
      <Card>
        <CardHeader><CardTitle className="text-base">الصيانة (سطر الأوامر)</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-xs text-muted-foreground font-mono" dir="ltr">
          <div>pnpm db:backup</div>
          <div>pnpm db:restore &lt;file.sql&gt; --confirm RESTORE</div>
          <div>pnpm db:reset --confirm RESET</div>
        </CardContent>
      </Card>
    </div>
  );
}
