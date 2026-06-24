/**
 * شاشة إدارة **أجهزة الكشك الخارجية** (قارئ الأسعار) — للمدير فقط.
 *
 * إنشاء جهاز ⇒ يُعرض الرمز الخام **مرّة واحدة** + زر تنزيل المُشغّل (.cmd) + الرابط.
 * الرمز لا يُسترجَع بعدها (مخزَّن مُجزّأً)؛ لاستبداله: «تدوير الرمز». الإلغاء فوري على الخادم.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, TableEmptyRow } from "@/components/PageState";
import { trpc } from "@/lib/trpc";
import { downloadLauncherCmd, kioskUrl } from "@/lib/kioskLauncher";
import { confirm, confirmDelete } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { fmtDateTime } from "@/lib/date";
import { Download, X } from "lucide-react";
import { useState } from "react";

type Reveal = { deviceId: number; label: string; branchName: string | null; rawToken: string };

const origin = typeof window !== "undefined" ? window.location.origin : "";

function copy(text: string, msg: string) {
  navigator.clipboard?.writeText(text).then(() => notify.ok(msg)).catch(() => notify.err("تعذّر النسخ"));
}

export default function KioskDevices() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const branchesQ = trpc.branches.list.useQuery();
  const branches = branchesQ.data ?? [];
  const devicesQ = trpc.kiosk.devices.list.useQuery();
  const devices = devicesQ.data ?? [];

  const [branchId, setBranchId] = useState<number | "">("");
  const [label, setLabel] = useState("");
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const create = trpc.kiosk.devices.create.useMutation({
    onSuccess: (data) => {
      const bName = branches.find((b) => b.id === branchId)?.name ?? null;
      setReveal({ deviceId: data.id, label: label.trim(), branchName: bName, rawToken: data.rawToken });
      setLabel("");
      notify.ok("أُنشئ الجهاز — احفظ الرمز الآن (يظهر مرّة واحدة)");
      void utils.kiosk.devices.list.invalidate();
    },
    onError: (e) => notify.err(e.message),
  });

  const rotate = trpc.kiosk.devices.rotate.useMutation({
    onSuccess: (data, vars) => {
      const dev = devices.find((d) => d.id === vars.id);
      setReveal({ deviceId: vars.id, label: dev?.label ?? "", branchName: dev?.branchName ?? null, rawToken: data.rawToken });
      notify.ok("دُوِّر الرمز — الرمز القديم أُبطِل");
      void utils.kiosk.devices.list.invalidate();
    },
    onError: (e) => notify.err(e.message),
  });

  const setActive = trpc.kiosk.devices.setActive.useMutation({
    onSuccess: () => { void utils.kiosk.devices.list.invalidate(); },
    onError: (e) => notify.err(e.message),
  });

  const remove = trpc.kiosk.devices.remove.useMutation({
    onSuccess: () => { notify.ok("حُذف الجهاز"); void utils.kiosk.devices.list.invalidate(); },
    onError: (e) => notify.err(e.message),
  });

  if (me.data && me.data.role !== "admin") {
    return <div className="p-10 text-center text-muted-foreground">هذه الشاشة للمدير فقط.</div>;
  }

  function submitCreate() {
    if (!branchId || typeof branchId !== "number") return notify.err("اختر الفرع");
    if (!label.trim()) return notify.err("أدخل اسم الجهاز");
    create.mutate({ branchId, label: label.trim() });
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <PageHeader
        title="شاشات قارئ الأسعار (الأجهزة الخارجية)"
        description={
          <>
            أجهزة مستقلّة تعرض الأسعار للزبون عبر المتصفّح بوضع كشك. كل جهاز يُصادَق برمز
            <b> للقراءة فقط</b> مربوط بفرع — لا يرى التكلفة ولا المخزون، وقابل للإلغاء فوراً.
          </>
        }
      />

      {/* الرمز المكشوف مرّة واحدة */}
      {reveal && (
        <Card className="border-emerald-400/60 bg-emerald-50/50 dark:bg-emerald-950/20">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base text-emerald-700 dark:text-emerald-400">
              رمز الجهاز «{reveal.label}» — اظهر مرّة واحدة فقط
            </CardTitle>
            <button className="text-muted-foreground hover:text-foreground" onClick={() => setReveal(null)} aria-label="إغلاق"><X aria-hidden className="size-5" /></button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-300">
              احفظ الرمز/المُشغّل الآن — لن يظهر الرمز ثانيةً. إن فقدته استعمل «تدوير الرمز».
            </div>

            <div className="space-y-1">
              <Label className="text-xs">رمز الجهاز</Label>
              <div className="flex gap-2">
                <Input readOnly dir="ltr" value={reveal.rawToken} className="font-mono text-xs" />
                <Button variant="outline" size="sm" onClick={() => copy(reveal.rawToken, "نُسخ الرمز")}>نسخ</Button>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">رابط الكشك (يحوي الرمز)</Label>
              <div className="flex gap-2">
                <Input readOnly dir="ltr" value={kioskUrl(origin, reveal.rawToken)} className="font-mono text-xs" />
                <Button variant="outline" size="sm" onClick={() => copy(kioskUrl(origin, reveal.rawToken), "نُسخ الرابط")}>نسخ</Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button className="inline-flex items-center gap-1.5" onClick={() => downloadLauncherCmd({ origin, token: reveal.rawToken, label: reveal.label, branchName: reveal.branchName, deviceId: reveal.deviceId })}>
                <Download aria-hidden className="size-4" />تنزيل المُشغّل (.cmd)
              </Button>
              <span className="text-xs text-muted-foreground self-center">
                شغّل الملف على جهاز الشاشة، أو ضعه في مجلّد بدء التشغيل (shell:startup) للتشغيل التلقائي.
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* إنشاء جهاز */}
      <Card>
        <CardHeader><CardTitle className="text-base">إضافة جهاز جديد</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">الفرع</Label>
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : "")}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm min-w-[180px]"
            >
              <option value="">— اختر الفرع —</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">اسم الجهاز</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="شاشة المدخل" className="min-w-[200px]" />
          </div>
          <Button onClick={submitCreate} disabled={create.isPending}>
            {create.isPending ? "…" : "إنشاء + رمز"}
          </Button>
        </CardContent>
      </Card>

      {/* قائمة الأجهزة */}
      <Card>
        <CardHeader><CardTitle className="text-base">الأجهزة المُسجَّلة ({devices.length})</CardTitle></CardHeader>
        <CardContent>
          {devicesQ.isLoading ? (
            <LoadingState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-right text-muted-foreground">
                    <th className="py-2 px-2 font-medium">الجهاز</th>
                    <th className="py-2 px-2 font-medium">الفرع</th>
                    <th className="py-2 px-2 font-medium">الرمز</th>
                    <th className="py-2 px-2 font-medium">الحالة</th>
                    <th className="py-2 px-2 font-medium">آخر ظهور</th>
                    <th className="py-2 px-2 font-medium">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.length === 0 && (
                    <TableEmptyRow colSpan={6} message="لا أجهزة بعد — أضف جهازاً أعلاه." />
                  )}
                  {devices.map((d) => (
                    <tr key={d.id} className="border-b last:border-0">
                      <td className="py-2 px-2 font-medium">{d.label}</td>
                      <td className="py-2 px-2">{d.branchName ?? "—"}</td>
                      <td className="py-2 px-2 font-mono text-xs" dir="ltr">{d.tokenPrefix}…</td>
                      <td className="py-2 px-2">
                        {d.isActive
                          ? <span className="inline-flex items-center gap-1 text-[var(--status-active)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--status-active)]" />مفعّل</span>
                          : <span className="inline-flex items-center gap-1 text-destructive"><span className="h-1.5 w-1.5 rounded-full bg-destructive" />مُلغى</span>}
                      </td>
                      <td className="py-2 px-2 text-xs text-muted-foreground">{fmtDateTime(d.lastSeenAt)}</td>
                      <td className="py-2 px-2">
                        <div className="flex flex-wrap gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              if (!(await confirm({ variant: "warning", title: "تدوير رمز الجهاز", description: `تدوير الرمز يُبطل الرمز القديم لجهاز «${d.label}». متابعة؟`, confirmText: "تدوير الرمز" }))) return;
                              rotate.mutate({ id: d.id });
                            }}
                            disabled={rotate.isPending}
                          >
                            تدوير الرمز
                          </Button>
                          {d.isActive ? (
                            <Button variant="outline" size="sm" onClick={() => setActive.mutate({ id: d.id, active: false })} disabled={setActive.isPending}>إلغاء</Button>
                          ) : (
                            <Button variant="outline" size="sm" onClick={() => setActive.mutate({ id: d.id, active: true })} disabled={setActive.isPending}>تفعيل</Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={async () => {
                              if (!(await confirmDelete({ description: `حذف الجهاز «${d.label}» نهائياً يلغي رمزه فوراً ويعطّل الشاشة.` }))) return;
                              remove.mutate({ id: d.id });
                            }}
                            disabled={remove.isPending}
                          >
                            حذف
                          </Button>
                        </div>
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
  );
}
