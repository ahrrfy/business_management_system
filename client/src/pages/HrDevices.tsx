/* الشاشة: أجهزة البصمة + الهجرة — الموارد البشرية (client/src/pages/HrDevices.tsx)
 * هجرة الأجهزة من المزوّد الخارجي المدفوع → خادم الرؤية العربية المملوك (HR_FINGERPRINT_TARGET).
 * بطاقة بطل تُظهر «من ← إلى» + شريط تقدّم (مُهاجَر/إجمالي)، ثم شبكة أجهزة وزر «نقل لخادمي» لكل غير مُهاجَر.
 * trpc.hrDevices.list/migrationStatus/migrate/create. */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState, TableEmptyRow } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { HR_FINGERPRINT_TARGET } from "@shared/hr";
import { ArrowLeftRight, Check, Cloud, Fingerprint, Plus, Radio, Server } from "lucide-react";
import { useState } from "react";

const PAID_PROVIDER = { provider: "IraqSoft — مزوّد خارجي", host: "api-iraqsoft.com", port: 7788 };

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const emptyForm = { name: "", model: "", location: "", branchId: "", deviceCode: "", ip: "", port: "" };

export default function HrDevices() {
  const utils = trpc.useUtils();
  const list = trpc.hrDevices.list.useQuery();
  const status = trpc.hrDevices.migrationStatus.useQuery();
  const opts = trpc.employees.formOptions.useQuery();

  const [openAdd, setOpenAdd] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });

  const refresh = async () => {
    await Promise.all([utils.hrDevices.list.invalidate(), utils.hrDevices.migrationStatus.invalidate()]);
  };

  const migrate = trpc.hrDevices.migrate.useMutation({
    onSuccess: async () => { notify.ok("تم نقل الجهاز إلى خادم الرؤية العربية"); await refresh(); },
    onError: (e) => notify.err(e),
  });

  const create = trpc.hrDevices.create.useMutation({
    onSuccess: async () => { notify.ok("تمت إضافة الجهاز"); setOpenAdd(false); setForm({ ...emptyForm }); await refresh(); },
    onError: (e) => notify.err(e),
  });

  const devices = list.data ?? [];
  const total = status.data?.total ?? 0;
  const migrated = status.data?.migrated ?? 0;
  const pending = status.data?.pending ?? 0;
  const allDone = total > 0 && pending === 0;
  const pct = total > 0 ? Math.round((migrated / total) * 100) : 0;

  const submit = () => {
    if (!form.name.trim()) { notify.warn("اسم الجهاز مطلوب"); return; }
    create.mutate({
      name: form.name.trim(),
      model: form.model.trim() || undefined,
      location: form.location.trim() || undefined,
      branchId: form.branchId ? Number(form.branchId) : undefined,
      deviceCode: form.deviceCode.trim() || undefined,
      ip: form.ip.trim() || undefined,
      port: form.port ? Number(form.port) : undefined,
      serverHost: PAID_PROVIDER.host,
      serverPort: PAID_PROVIDER.port,
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="أجهزة البصمة والتكامل"
        description="انقل أجهزة البصمة من الاشتراك الخارجي المدفوع إلى خادم الرؤية العربية الخاص بك — بصمة ضمن نظامك بلا رسوم شهرية."
        actions={<Button onClick={() => setOpenAdd(true)}><Plus className="size-4" /> جهاز جديد</Button>}
      />

      {/* بطاقة الهجرة (البطل): من ← إلى + شريط تقدّم */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start gap-3 flex-wrap">
            <span className="size-10 rounded-lg grid place-items-center shrink-0 bg-primary/10 text-primary"><Cloud className="size-5" /></span>
            <div className="flex-1 min-w-[240px]">
              <h3 className="font-bold text-[15px]">التخلّص من اشتراك البصمة الخارجي المدفوع</h3>
              <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
                أجهزتك متصلة حالياً بمزوّد خارجي (<span dir="ltr" className="font-medium">IraqSoft</span>) باشتراك شهري. انقل اتصالها إلى خادم الرؤية العربية لتعمل البصمة ومزامنة الحضور داخل نظامك مباشرةً — ثم ألغِ الاشتراك.
              </p>
            </div>
          </div>

          {/* من → إلى */}
          <div className="grid md:grid-cols-[1fr_auto_1fr] gap-3 items-stretch">
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">المزوّد الحالي (مدفوع)</span>
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-200">يُلغى</span>
              </div>
              <div className="text-[13px] font-bold mb-1">{PAID_PROVIDER.provider}</div>
              <div className="text-[11px] text-amber-700/80 dark:text-amber-400/80 space-y-1" dir="ltr">
                <div className="flex items-center gap-1.5"><Cloud className="size-3" /> {PAID_PROVIDER.host}</div>
                <div className="flex items-center gap-1.5"><Radio className="size-3" /> {PAID_PROVIDER.host}:{PAID_PROVIDER.port}</div>
              </div>
            </div>

            <div className="grid place-items-center px-1">
              <div className="size-10 rounded-full grid place-items-center bg-primary text-primary-foreground"><ArrowLeftRight className="size-5" /></div>
            </div>

            <div className="rounded-lg border-2 border-emerald-500 bg-emerald-500/[0.07] p-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">خادم الرؤية العربية (الوجهة)</span>
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">مجاني · مملوك لك</span>
              </div>
              <div className="text-[13px] font-bold mb-1">{HR_FINGERPRINT_TARGET.label}</div>
              <div className="text-[11px] text-muted-foreground space-y-1" dir="ltr">
                <div className="flex items-center gap-1.5"><Server className="size-3" /> {HR_FINGERPRINT_TARGET.host}</div>
                <div className="flex items-center gap-1.5"><Radio className="size-3" /> {HR_FINGERPRINT_TARGET.host}:{HR_FINGERPRINT_TARGET.port}</div>
              </div>
            </div>
          </div>

          {/* شريط التقدّم */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-medium">تقدّم نقل الأجهزة</span>
                <span className="tabular-nums text-muted-foreground" dir="ltr">{migrated} / {total}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>

          {allDone && (
            <div className="rounded-md p-2.5 text-[12px] flex items-center gap-2 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
              <Check className="size-4 shrink-0" /> كل الأجهزة تعمل الآن على خادمك. لم يَعُد الاشتراك الخارجي مطلوباً — يمكنك إلغاؤه بأمان دون انقطاع البصمة.
            </div>
          )}
        </CardContent>
      </Card>

      {/* قائمة الأجهزة */}
      <Card>
        <CardHeader><CardTitle className="text-base">الأجهزة ({total})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2">الجهاز</th>
                  <th className="p-2">الموقع</th>
                  <th className="p-2">الفرع</th>
                  <th className="p-2 text-center">الحالة</th>
                  <th className="p-2">الخادم الحالي</th>
                  <th className="p-2 text-center">مُهاجَر؟</th>
                  <th className="p-2 text-left"></th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => {
                  const online = d.status === "online";
                  return (
                    <tr key={d.id} className="border-t hover:bg-accent/50 transition">
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <span className={`size-9 rounded-lg grid place-items-center shrink-0 ${online ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950" : "bg-rose-50 text-rose-500 dark:bg-rose-950"}`}>
                            <Fingerprint className="size-5" />
                          </span>
                          <div>
                            <div className="font-medium">{d.name}</div>
                            {d.model && <div className="text-xs text-muted-foreground">{d.model}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="p-2 text-xs">{d.location ?? "—"}</td>
                      <td className="p-2 text-xs">{d.branchName ?? "—"}</td>
                      <td className="p-2 text-center">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${online ? "badge-status-active" : "badge-stock-out"}`}>
                          <span className={`size-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500"}`} />
                          {online ? "متصل" : "منقطع"}
                        </span>
                      </td>
                      <td className="p-2 text-xs" dir="ltr">
                        {d.serverHost ? `${d.serverHost}${d.serverPort ? `:${d.serverPort}` : ""}` : "—"}
                      </td>
                      <td className="p-2 text-center">
                        {d.migrated ? (
                          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium badge-status-active">
                            <Check className="size-3" /> على خادمك
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium badge-stock-low">
                            على المزوّد المدفوع
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-left">
                        {!d.migrated && (
                          <Button size="sm" disabled={migrate.isPending} onClick={async () => {
                            if (!(await confirm({
                              variant: "warning",
                              title: "نقل الجهاز إلى خادمك",
                              description: `نقل الجهاز «${d.name}» من المزوّد الخارجي إلى خادمك قد يستغرق دقائق. متابعة؟`,
                              confirmText: "نقل لخادمي",
                            }))) return;
                            migrate.mutate({ id: d.id });
                          }}>
                            <ArrowLeftRight className="size-3.5" /> نقل لخادمي
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {list.isError && (
                  <tr><td colSpan={7} className="p-0"><ErrorState message="تعذّر تحميل الأجهزة." onRetry={() => list.refetch()} /></td></tr>
                )}
                {!list.isLoading && !list.isError && devices.length === 0 && (
                  <TableEmptyRow colSpan={7} message="لا أجهزة بصمة مسجّلة بعد. أضف جهازاً للبدء بالهجرة." />
                )}
                {list.isLoading && (
                  <tr><td colSpan={7} className="p-0"><LoadingState /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* نافذة إضافة جهاز */}
      <Dialog open={openAdd} onOpenChange={(o) => { setOpenAdd(o); if (!o) setForm({ ...emptyForm }); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>إضافة جهاز بصمة</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="d-name">اسم الجهاز</Label>
              <Input id="d-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="جهاز البصمة — المدخل الرئيسي" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-model">الطراز</Label>
              <Input id="d-model" value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} placeholder="وجه + بطاقة + بصمة" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-location">الموقع</Label>
              <Input id="d-location" value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="بوابة الفرع الرئيسي" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-branch">الفرع</Label>
              <select id="d-branch" className={selectCls} value={form.branchId} onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}>
                <option value="">— بلا فرع —</option>
                {(opts.data?.branches ?? []).map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-code">معرّف الجهاز (Device ID)</Label>
              <Input id="d-code" dir="ltr" value={form.deviceCode} onChange={(e) => setForm((f) => ({ ...f, deviceCode: e.target.value }))} placeholder="1" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-ip">عنوان IP</Label>
              <Input id="d-ip" dir="ltr" value={form.ip} onChange={(e) => setForm((f) => ({ ...f, ip: e.target.value }))} placeholder="192.168.68.108" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-port">المنفذ (Port)</Label>
              <Input id="d-port" dir="ltr" type="number" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} placeholder="5005" />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">يُضاف الجهاز مرتبطاً بالمزوّد الحالي؛ ثم انقله لخادمك من الجدول.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenAdd(false)}>إلغاء</Button>
            <Button disabled={create.isPending} onClick={submit}>{create.isPending ? "جارٍ…" : "إضافة"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
