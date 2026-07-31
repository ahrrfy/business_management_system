/* ============================================================================
 * بطاقة ربط الموظف بجهاز الحضور (client/src/components/hr/DeviceLinkCard.tsx)
 *
 * لماذا هنا لا في شاشة الأجهزة فقط: الجهاز لا يرسل هويةً — يرسل رقماً داخلياً (enrollId)
 * والنظام يحلّه إلى موظف عبر hrDeviceUsers. فبلا ربطٍ تُخزَّن البصمات ولا تُطوى أبداً
 * (attendanceFold يختار المربوطة فقط) فيظهر الموظف بصفر ساعات يوم الراتب. وحين كان
 * الربط يُدار من شاشة الأجهزة وحدها، لم يكن شيءٌ يُنبّه من يوظّف موظفاً جديداً.
 *
 * مصدر الحقيقة يبقى جدول الربط (لا حقل على employees): موظفٌ قد يكون على جهازَي فرعين،
 * والجهاز التالف يُستبدَل فيتغيّر رقمه بلا فقد تاريخه.
 * ========================================================================== */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { Fingerprint, TriangleAlert, Unlink } from "lucide-react";
import { useEffect, useState } from "react";

const selectCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export interface DeviceLink {
  id: number;
  deviceId: number;
  deviceName: string;
  deviceEnabled: boolean;
  branchName: string | null;
  enrollId: number;
  deviceUserName: string | null;
  cardNo: string | null;
  effectiveFrom: string | null;
  syncedAt: Date | string | null;
}

export function DeviceLinkCard({
  employeeId,
  employeeName,
  hireDate,
  links,
  isTerminated,
  onChanged,
}: {
  employeeId: number;
  employeeName: string;
  hireDate: string | null;
  links: DeviceLink[];
  isTerminated: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState<string>("");
  const [enrollId, setEnrollId] = useState<string>("");
  const [effectiveFrom, setEffectiveFrom] = useState<string>(hireDate ?? "");

  const devices = trpc.hrDevices.list.useQuery(undefined, { enabled: open });
  // أرقام الجهاز غير المربوطة — الجهاز يُبلّغ الاسم المكتوب فيه فيسهل التطابق البصريّ.
  const unlinked = trpc.hrDevices.unlinkedDeviceUsers.useQuery(
    { deviceId: Number(deviceId) },
    { enabled: open && !!deviceId },
  );

  const map = trpc.hrDevices.mapUser.useMutation({
    onSuccess: async (r) => {
      notify.ok(
        r.backfilled > 0
          ? `تم الربط — وأُلحقت ${r.backfilled} بصمة سابقة وستُطوى إلى أيام حضور`
          : "تم الربط",
      );
      setOpen(false);
      // الرقم لم يعد غير مربوط ⇒ أبطِل كاش قائمة الأرقام وإلا ظهر مُتاحاً في الفتحة التالية.
      await utils.hrDevices.unlinkedDeviceUsers.invalidate();
      await onChanged();
    },
    onError: (e) => notify.err(e),
  });

  // فتح الحوار يبدأ من حالة نظيفة: الاختيارات السابقة تبقى في الحالة وإلا أُرسل جهازٌ
  // لم يعد ظاهراً في القائمة (الـselect يعرض أول خيار بينما الحالة تحمل القديم).
  useEffect(() => {
    if (!open) return;
    setDeviceId("");
    setEnrollId("");
    setEffectiveFrom(hireDate ?? "");
  }, [open, hireDate]);

  const activeDevices = (devices.data ?? []).filter((d) => d.enabled);
  const alreadyLinkedDeviceIds = new Set(links.map((l) => l.deviceId));
  const selectable = activeDevices.filter((d) => !alreadyLinkedDeviceIds.has(d.id));
  const noLinks = links.length === 0;

  return (
    <Card className={noLinks && !isTerminated ? "border-amber-500/50" : undefined}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Fingerprint aria-hidden className="size-4" />
          ربط جهاز الحضور
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {noLinks ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <TriangleAlert aria-hidden className="size-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <div className="font-medium text-amber-800 dark:text-amber-300">هذا الموظف غير مربوط بأي جهاز حضور</div>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                الجهاز يرسل رقماً داخلياً لا اسماً. بلا ربطٍ بين رقمه في الجهاز وهذا الموظف، تُخزَّن بصماته
                ولا تتحوّل إلى ساعات حضور ولا تدخل مسيّر الرواتب — ويظهر بصفر ساعات.
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-md border divide-y">
            {links.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 p-2.5 text-sm flex-wrap">
                <div className="min-w-0">
                  <div className="font-medium flex items-center gap-2">
                    <span>{l.deviceName}</span>
                    {l.branchName && <span className="text-xs text-muted-foreground">({l.branchName})</span>}
                    {!l.deviceEnabled && (
                      <span className="rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        جهاز غير معتمَد
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>
                      الرقم في الجهاز: <span dir="ltr" className="font-mono tabular-nums">{l.enrollId}</span>
                    </span>
                    {l.deviceUserName && <span>· الاسم في الجهاز: {l.deviceUserName}</span>}
                    <span>· يُحتسب من: {l.effectiveFrom ? fmtDate(l.effectiveFrom) : "بلا حدّ"}</span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={map.isPending}
                  onClick={() =>
                    void (async () => {
                      if (
                        !(await confirm({
                          variant: "danger",
                          title: "فكّ ربط جهاز الحضور",
                          description: `فكّ ربط «${employeeName}» عن الرقم ${l.enrollId} على «${l.deviceName}». بصماته الجديدة لن تُحتسب بعد ذلك. أيام الحضور المسجّلة سابقاً تبقى كما هي.`,
                          confirmText: "فكّ الربط",
                        }))
                      )
                        return;
                      map.mutate({ deviceId: l.deviceId, enrollId: l.enrollId, employeeId: null });
                    })()
                  }
                >
                  <Unlink aria-hidden className="size-3.5" />
                  فكّ الربط
                </Button>
              </div>
            ))}
          </div>
        )}

        {!isTerminated && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            ربط برقم على جهاز
          </Button>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ربط «{employeeName}» برقم على جهاز الحضور</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="dl-device">الجهاز</Label>
              <select
                id="dl-device"
                className={selectCls}
                value={deviceId}
                onChange={(ev) => {
                  setDeviceId(ev.target.value);
                  setEnrollId("");
                }}
              >
                <option value="">— اختر الجهاز —</option>
                {selectable.map((d) => (
                  <option key={d.id} value={String(d.id)}>
                    {d.name}
                    {d.branchName ? ` (${d.branchName})` : ""}
                  </option>
                ))}
              </select>
              {devices.isSuccess && selectable.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {activeDevices.length === 0
                    ? "لا أجهزة معتمَدة. اعتمد الجهاز أولاً من شاشة أجهزة الحضور."
                    : "الموظف مربوط بكل الأجهزة المعتمَدة — لكل موظف رقمٌ واحد لكل جهاز."}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="dl-enroll">الرقم في الجهاز</Label>
              {(unlinked.data ?? []).length > 0 ? (
                <select id="dl-enroll" className={selectCls} value={enrollId} onChange={(ev) => setEnrollId(ev.target.value)}>
                  <option value="">— اختر الرقم —</option>
                  {(unlinked.data ?? []).map((u) => (
                    <option key={u.enrollId} value={String(u.enrollId)}>
                      {u.enrollId}
                      {u.name ? ` — ${u.name}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="dl-enroll"
                  type="number"
                  min={0}
                  dir="ltr"
                  value={enrollId}
                  onChange={(ev) => setEnrollId(ev.target.value)}
                  placeholder="مثال: 7"
                />
              )}
              <p className="text-xs text-muted-foreground">
                هو رقم المستخدم داخل الجهاز نفسه (User ID / enroll). اسحب «قائمة المستخدمين» من شاشة الأجهزة
                لتظهر الأرقام بأسمائها المكتوبة في الجهاز.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="dl-from">يُحتسب الحضور من تاريخ</Label>
              <Input
                id="dl-from"
                type="date"
                dir="ltr"
                value={effectiveFrom}
                onChange={(ev) => setEffectiveFrom(ev.target.value)}
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                حارس ضدّ إعادة استعمال الأرقام: الجهاز يحتفظ بسجلّات قديمة، وقد يكون هذا الرقم لموظفٍ سابق.
                البصمات الأقدم من هذا التاريخ لن تُنسب لهذا الموظف.
                {!hireDate && " (تاريخ المباشرة غير مسجّل — حدّده يدوياً، وتركه فارغاً يعني بلا حدّ.)"}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              إلغاء
            </Button>
            <Button
              disabled={!deviceId || enrollId === "" || map.isPending}
              onClick={() =>
                map.mutate({
                  deviceId: Number(deviceId),
                  enrollId: Number(enrollId),
                  employeeId,
                  effectiveFrom: effectiveFrom || null,
                })
              }
            >
              {map.isPending ? "جارٍ الربط…" : "ربط"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
