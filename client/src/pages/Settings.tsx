import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DangerConfirmDialog } from "@/components/DangerConfirmDialog";
import { confirmDelete } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { getServerBridgeStatus, serverPrintTest } from "@/lib/printing/print";
import { fmtDateTime } from "@/lib/date";
import { useEffect, useRef, useState } from "react";

function fmtKb(kb: number): string {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} م.ب` : `${kb} ك.ب`;
}
function fileToB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
function downloadBackup(name: string) {
  const a = document.createElement("a");
  a.href = `/api/backups/download?name=${encodeURIComponent(name)}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

type DangerAction =
  | { kind: "restore-server"; name: string }
  | { kind: "restore-upload"; fileName: string; fileB64: string }
  | { kind: "reset" };

export default function Settings() {
  const utils = trpc.useUtils();
  const info = trpc.system.systemInfo.useQuery();
  const backups = trpc.system.listBackups.useQuery();
  const fileRef = useRef<HTMLInputElement>(null);
  const [danger, setDanger] = useState<DangerAction | null>(null);
  const [bridge, setBridge] = useState<{ enabled: boolean; description: string }>({ enabled: false, description: "" });

  useEffect(() => { getServerBridgeStatus().then(setBridge).catch(() => {}); }, []);

  const refresh = async () => {
    await Promise.all([utils.system.systemInfo.invalidate(), utils.system.listBackups.invalidate()]);
  };

  const backupNow = trpc.system.backupNow.useMutation({
    onSuccess: async (r) => {
      notify.ok(r.created ? `أُنشئت نسخة: ${r.created.name}` : "تمّت النسخة الاحتياطية");
      await refresh();
    },
    onError: (e) => notify.err(e.message || "فشلت النسخة"),
  });
  const deleteBackup = trpc.system.deleteBackup.useMutation({
    onSuccess: async () => { notify.ok("حُذفت النسخة"); await refresh(); },
    onError: (e) => notify.err(e.message || "تعذّر الحذف"),
  });

  const afterDestructive = (msg: string) => {
    setDanger(null);
    notify.ok(`${msg} — سيُعاد تحميل النظام`);
    setTimeout(() => window.location.reload(), 1600);
  };
  const restoreBackup = trpc.system.restoreBackup.useMutation({
    onSuccess: () => afterDestructive("تمّت الاستعادة بنجاح"),
    onError: (e) => notify.err(e.message || "فشلت الاستعادة"),
  });
  const restoreUpload = trpc.system.restoreUpload.useMutation({
    onSuccess: () => afterDestructive("تمّت الاستعادة من الملف"),
    onError: (e) => notify.err(e.message || "فشلت الاستعادة من الملف"),
  });
  const resetSystem = trpc.system.resetSystem.useMutation({
    onSuccess: () => afterDestructive("تمّ تصفير النظام"),
    onError: (e) => notify.err(e.message || "فشل التصفير"),
  });
  const dangerPending = restoreBackup.isPending || restoreUpload.isPending || resetSystem.isPending;

  const confirmToken = info.data?.confirmToken ?? info.data?.db.name ?? "";

  async function backupAndDownload() {
    try {
      const r = await backupNow.mutateAsync();
      if (r.created) downloadBackup(r.created.name);
    } catch { /* toast من onError */ }
  }
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.name.endsWith(".sql")) { notify.err("اختر ملف .sql صالحاً"); return; }
    try {
      const fileB64 = await fileToB64(file);
      setDanger({ kind: "restore-upload", fileName: file.name, fileB64 });
    } catch { notify.err("تعذّر قراءة الملف"); }
  }
  function handleDangerConfirm({ password, seed, confirm }: { password: string; seed: boolean; confirm: string }) {
    if (!danger) return;
    if (danger.kind === "restore-server") restoreBackup.mutate({ name: danger.name, confirm, password });
    else if (danger.kind === "restore-upload") restoreUpload.mutate({ fileName: danger.fileName, fileB64: danger.fileB64, confirm, password });
    else resetSystem.mutate({ confirm, password, seed });
  }

  const c = info.data?.counts;
  const list = backups.data?.backups ?? [];

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-2xl font-bold">الإعدادات والنسخ الاحتياطي</h1>

      {(info.isError || backups.isError) && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>تعذّر تحميل بيانات النظام/النسخ. تحقّق من الاتصال بالخادم.</span>
          <Button size="sm" variant="outline" onClick={() => { info.refetch(); backups.refetch(); }}>إعادة المحاولة</Button>
        </div>
      )}

      {/* معلومات النظام */}
      <Card>
        <CardHeader><CardTitle className="text-base">معلومات النظام</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <Stat label="القاعدة" value={info.data?.db.name ?? "…"} mono />
          <Stat label="الخادم" value={info.data?.db.host ?? "…"} mono />
          <Stat label="الفروع" value={c ? String(c.branches) : "…"} />
          <Stat label="المستخدمون" value={c ? String(c.users) : "…"} />
          <Stat label="المنتجات" value={c ? String(c.products) : "…"} />
          <Stat label="العملاء" value={c ? String(c.customers) : "…"} />
          <Stat label="الفواتير" value={c ? String(c.invoices) : "…"} />
          <Stat label="النسخ" value={info.data ? `${info.data.backups.count} (${fmtKb(info.data.backups.totalKb)})` : "…"} />
          <Stat label="آخر نسخة" value={fmtDateTime(info.data?.backups.latest ?? null)} />
          <Stat label="الطباعة الصامتة" value={bridge.enabled ? "مفعّلة" : "غير مفعّلة"} ok={bridge.enabled} />
          <Stat label="النسخ التلقائي" value={`يومياً 02:00${info.data?.schedule.offsiteConfigured ? " + خارجي" : ""}`} />
        </CardContent>
      </Card>

      {/* النسخ الاحتياطي */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base">النسخ الاحتياطي</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>
              {backupNow.isPending ? "جارٍ…" : "نسخة الآن"}
            </Button>
            <Button onClick={backupAndDownload} disabled={backupNow.isPending}>
              نسخة + تنزيل للجهاز
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            نسخة كاملة (mysqldump ذرّي) تطابق قاعدة الإنتاج. التنزيل يحفظ الملف على جهازك. النسخ اليومي 02:00 تلقائي.
          </p>
          {backups.isLoading ? (
            <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground">لا نسخ بعد — اضغط «نسخة الآن».</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">الملف</TableHead>
                  <TableHead className="text-left">الحجم</TableHead>
                  <TableHead className="text-left">التاريخ</TableHead>
                  <TableHead className="text-center">إجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((b) => (
                  <TableRow key={b.name}>
                    <TableCell className="font-mono text-xs" dir="ltr">{b.name}</TableCell>
                    <TableCell className="text-left tabular-nums">{fmtKb(b.sizeKb)}</TableCell>
                    <TableCell className="text-left tabular-nums" dir="ltr">{fmtDateTime(b.createdAt)}</TableCell>
                    <TableCell className="text-center whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => downloadBackup(b.name)}>⬇ تنزيل</Button>
                      <Button size="sm" variant="ghost" className="text-amber-600" onClick={() => setDanger({ kind: "restore-server", name: b.name })}>↻ استعادة</Button>
                      <Button size="sm" variant="ghost" className="text-destructive"
                        onClick={async () => {
                          if (!(await confirmDelete({ description: `حذف النسخة الاحتياطية «${b.name}»؟ لا يمكن التراجع إلا باستعادة نسخة أخرى.` }))) return;
                          deleteBackup.mutate({ name: b.name });
                        }}>🗑 حذف</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* الاستعادة من ملف */}
      <Card>
        <CardHeader><CardTitle className="text-base">الاستعادة من ملف</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            استعد قاعدة البيانات من ملف نسخة (.sql) على جهازك (مثل نسخة خارجية/USB). يُتحقَّق من الملف، وتُؤخذ نسخة أمان أولاً.
          </p>
          <input ref={fileRef} type="file" accept=".sql" onChange={onPickFile} className="hidden" />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>اختر ملف .sql للاستعادة…</Button>
        </CardContent>
      </Card>

      {/* الطباعة */}
      <Card>
        <CardHeader><CardTitle className="text-base">الطباعة</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className={bridge.enabled ? "text-emerald-600" : "text-muted-foreground"}>{bridge.enabled ? "●" : "○"}</span>
            <span>جسر الطباعة الصامتة: <b>{bridge.enabled ? "مفعّل" : "غير مفعّل"}</b>{bridge.enabled ? ` (${bridge.description})` : ""}</span>
            {bridge.enabled && (
              <Button size="sm" variant="outline" className="ms-auto"
                onClick={async () => { const r = await serverPrintTest(); r.ok ? notify.ok("أُرسلت تذكرة اختبار") : notify.err(r.error ?? "فشل الاختبار"); }}>
                اختبار طباعة
              </Button>
            )}
          </div>
          {!bridge.enabled && (
            <p className="text-xs text-muted-foreground">
              للطباعة الصامتة اضبط <code dir="ltr" className="font-mono">PRINT_TARGET</code> في .env (مثل <code dir="ltr" className="font-mono">tcp://ip:9100</code> أو <code dir="ltr" className="font-mono">share://Name</code>).
            </p>
          )}
        </CardContent>
      </Card>

      {/* منطقة الخطر — التصفير */}
      <Card className="border-destructive/40">
        <CardHeader><CardTitle className="text-base text-destructive">منطقة الخطر — تصفير النظام</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            يمسح كل البيانات المُدخلة (فواتير، مخزون، عملاء، منتجات…) ويُبقي المستخدمين والفروع فقط — للبدء من جديد بنظام فارغ.
            عملية لا رجعة فيها؛ تتطلّب اسم القاعدة + كلمة المرور، وتُؤخذ نسخة أمان أولاً.
          </p>
          <Button variant="destructive" onClick={() => setDanger({ kind: "reset" })}>تصفير النظام…</Button>
        </CardContent>
      </Card>

      {/* الصيانة CLI */}
      <Card>
        <CardHeader><CardTitle className="text-base">الصيانة (سطر الأوامر)</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-xs text-muted-foreground font-mono" dir="ltr">
          <div>pnpm db:backup</div>
          <div>pnpm db:restore &lt;file.sql&gt; --confirm RESTORE</div>
          <div>pnpm db:reset --confirm RESET</div>
        </CardContent>
      </Card>

      {/* حوار التأكيد الموحّد للعمليات المدمّرة */}
      <DangerConfirmDialog
        open={danger != null}
        onOpenChange={(o) => { if (!o) setDanger(null); }}
        title={danger?.kind === "reset" ? "تصفير النظام" : "استعادة قاعدة البيانات"}
        description={
          danger?.kind === "restore-server" ? `سيُستبدَل النظام الحالي بالكامل بمحتوى النسخة «${danger.name}».`
            : danger?.kind === "restore-upload" ? `سيُستبدَل النظام الحالي بالكامل بمحتوى الملف «${danger.fileName}».`
            : "سيُمسح كل ما أُدخل ويُبقى المستخدمون والفروع فقط."
        }
        warnings={
          danger?.kind === "reset"
            ? ["كل الفواتير والمخزون والعملاء والمنتجات ستُمسح.", "لا يمكن التراجع إلا باستعادة نسخة."]
            : ["كل البيانات الحالية ستُستبدَل بمحتوى النسخة.", "نفّذها والمتجر مغلق (لا مستخدمين متّصلين)."]
        }
        confirmToken={confirmToken}
        actionLabel={danger?.kind === "reset" ? "تصفير الآن" : "استعادة الآن"}
        showSeedToggle={danger?.kind === "reset"}
        pending={dangerPending}
        onConfirm={handleDangerConfirm}
      />
    </div>
  );
}

function Stat({ label, value, mono, ok }: { label: string; value: string; mono?: boolean; ok?: boolean }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={`${mono ? "font-mono" : ""} ${ok ? "text-emerald-600 font-semibold" : ""}`} dir={mono ? "ltr" : undefined}>{value}</div>
    </div>
  );
}
