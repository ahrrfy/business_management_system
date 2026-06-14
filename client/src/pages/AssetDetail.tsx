import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { categoryIcon, iqd } from "@/lib/assets/ui";
import { printAssetLabel } from "@/lib/assets/print";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { assetCategoryLabel, assetStatusLabel, depreciationMethodLabel } from "@shared/assets";
import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";

const today = () => new Date().toISOString().slice(0, 10);
const selectCls = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Field({ label, value, dir }: { label: string; value: React.ReactNode; dir?: "ltr" | "rtl" }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className={dir === "ltr" ? "tabular-nums" : ""} dir={dir}>{value ?? "—"}</div>
    </div>
  );
}

export default function AssetDetail() {
  const params = useParams();
  const id = Number(params.id);
  const utils = trpc.useUtils();
  const q = trpc.assets.get.useQuery({ id }, { enabled: Number.isFinite(id) });
  const opts = trpc.assets.formOptions.useQuery();

  const [tab, setTab] = useState("overview");
  const [openHandover, setOpenHandover] = useState(false);
  const [openMaint, setOpenMaint] = useState(false);
  const [openLabel, setOpenLabel] = useState(false);
  const [openDispose, setOpenDispose] = useState(false);

  // نماذج النوافذ
  const [hEmp, setHEmp] = useState("");
  const [hNote, setHNote] = useState("");
  const [mType, setMType] = useState("");
  const [mVendor, setMVendor] = useState("");
  const [mCost, setMCost] = useState("");
  const [mNote, setMNote] = useState("");
  const [mDate, setMDate] = useState(today());
  const [dKind, setDKind] = useState<"retired" | "disposed">("retired");
  const [dDate, setDDate] = useState(today());
  const [dReason, setDReason] = useState("");
  const [dValue, setDValue] = useState("");

  const refresh = async () => {
    await Promise.all([utils.assets.get.invalidate({ id }), utils.assets.list.invalidate(), utils.assets.dashboard.invalidate(), utils.assets.disposalLog.invalidate(), utils.assets.custodyReport.invalidate()]);
  };

  const handover = trpc.assets.handover.useMutation({ onSuccess: async () => { notify.ok("تم تسليم العهدة"); setOpenHandover(false); setHEmp(""); setHNote(""); await refresh(); }, onError: (e) => notify.err(e) });
  const addMaint = trpc.assets.addMaintenance.useMutation({ onSuccess: async () => { notify.ok("تم تسجيل الصيانة"); setOpenMaint(false); setMType(""); setMVendor(""); setMCost(""); setMNote(""); await refresh(); }, onError: (e) => notify.err(e) });
  const returnMaint = trpc.assets.returnFromMaintenance.useMutation({ onSuccess: async () => { notify.ok("أُعيد الأصل للخدمة"); await refresh(); }, onError: (e) => notify.err(e) });
  const dispose = trpc.assets.dispose.useMutation({ onSuccess: async () => { notify.ok("تم تنفيذ الإخراج/الاستبعاد"); setOpenDispose(false); setDReason(""); setDValue(""); await refresh(); }, onError: (e) => notify.err(e) });

  const a = q.data;
  const Icon = useMemo(() => (a ? categoryIcon(a.category) : null), [a]);

  if (q.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (!a) return <div className="p-10 text-center text-muted-foreground">الأصل غير موجود. <Link href="/assets/register" className="text-primary">رجوع للسجلّ</Link></div>;

  const isLive = a.status === "active" || a.status === "maintenance";

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Link href="/assets/register" className="text-sm text-muted-foreground">← رجوع للسجلّ</Link>
      </div>

      {/* ترويسة الأصل */}
      <Card>
        <CardContent className="p-4 flex items-start justify-between flex-wrap gap-3">
          <div className="flex items-start gap-3">
            {Icon && <span className="inline-flex size-12 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="size-6" /></span>}
            <div>
              <div className="text-lg font-bold leading-tight">{a.name}</div>
              <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground flex-wrap">
                <span className="font-mono" dir="ltr">{a.code}</span>
                <span>·</span>
                <span>{assetCategoryLabel(a.category)}</span>
                <span>·</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{assetStatusLabel(a.status)}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => setOpenLabel(true)}>بطاقة الأصل</Button>
            {isLive && <Button variant="outline" size="sm" onClick={() => setOpenMaint(true)}>تسجيل صيانة</Button>}
            {a.status === "maintenance" && <Button variant="outline" size="sm" onClick={() => returnMaint.mutate({ assetId: id })} disabled={returnMaint.isPending}>إعادة للخدمة</Button>}
            {isLive && <Button variant="outline" size="sm" onClick={() => setOpenHandover(true)}>تسليم عهدة</Button>}
            {isLive && <Button variant="outline" size="sm" className="text-destructive" onClick={() => setOpenDispose(true)}>إخراج / استبعاد</Button>}
          </div>
        </CardContent>
      </Card>

      {/* مؤشّرات */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4"><div className="text-muted-foreground text-xs mb-1">القيمة الدفترية</div><div className="text-lg font-bold tabular-nums" dir="ltr">{iqd(a.bookValue)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-muted-foreground text-xs mb-1">قيمة الشراء</div><div className="text-lg font-bold tabular-nums" dir="ltr">{iqd(a.purchaseValue)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-muted-foreground text-xs mb-1">الإهلاك المتراكم</div><div className="text-lg font-bold tabular-nums" dir="ltr">{iqd(a.accumulated)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-muted-foreground text-xs mb-1">العمر التشغيلي</div><div className="text-lg font-bold tabular-nums" dir="ltr">{a.ageYears} سنة</div></CardContent></Card>
      </div>

      {/* شريط استهلاك القيمة */}
      <Card>
        <CardContent className="p-4 space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">استهلاك القيمة ({depreciationMethodLabel(a.depreciationMethod)})</span>
            <span className="tabular-nums" dir="ltr">{a.depPct}%</span>
          </div>
          <Progress value={a.depPct} />
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="overview">نظرة عامة</TabsTrigger>
          <TabsTrigger value="depreciation">الإهلاك</TabsTrigger>
          <TabsTrigger value="maintenance">الصيانة ({a.maintenance.length})</TabsTrigger>
          <TabsTrigger value="custody">العهدة ({a.custody.length})</TabsTrigger>
          <TabsTrigger value="documents">المستندات ({a.docs.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <Card><CardContent className="p-4 grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <Field label="الماركة" value={a.brand} />
            <Field label="الرقم التسلسلي" value={a.serial} dir="ltr" />
            <Field label="الفرع" value={a.branchName} />
            <Field label="الموقع" value={a.location} />
            <Field label="العهدة الحالية" value={a.custodianName ?? "بلا عهدة"} />
            <Field label="المورّد" value={a.supplierName} />
            <Field label="تاريخ الشراء" value={a.purchaseDate} dir="ltr" />
            <Field label="نهاية الكفالة" value={a.warrantyEnd} dir="ltr" />
            <Field label="الحالة الفنية" value={a.condition} />
            <Field label="العمر الإنتاجي" value={`${a.usefulLifeYears} سنة`} />
            <Field label="القيمة التخريدية" value={iqd(a.salvageValue)} dir="ltr" />
            <Field label="إجمالي الصيانة" value={iqd(a.maintTotal)} dir="ltr" />
            {a.status === "disposed" || a.status === "retired" ? (
              <>
                <Field label="تاريخ الإخراج" value={a.disposalDate} dir="ltr" />
                {a.disposalValue != null && <Field label="عائد الاستبعاد" value={iqd(a.disposalValue)} dir="ltr" />}
                <Field label="سبب الإخراج" value={a.disposalReason} />
              </>
            ) : null}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="depreciation">
          <Card>
            <CardHeader><CardTitle className="text-base">جدول الإهلاك السنوي — {depreciationMethodLabel(a.depreciationMethod)}</CardTitle></CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50"><tr className="text-right">
                  <th className="p-2">السنة</th>
                  <th className="p-2 text-left">القيمة أول المدة</th>
                  <th className="p-2 text-left">إهلاك السنة</th>
                  <th className="p-2 text-left">القيمة آخر المدة</th>
                </tr></thead>
                <tbody>
                  {a.schedule.map((r) => (
                    <tr key={r.year} className={`border-t ${r.isCurrent ? "bg-primary/5 font-medium" : ""}`}>
                      <td className="p-2" dir="ltr">{r.year}{r.isCurrent ? " ◄" : ""}</td>
                      <td className="p-2 text-left tabular-nums" dir="ltr">{iqd(r.opening)}</td>
                      <td className="p-2 text-left tabular-nums" dir="ltr">{iqd(r.dep)}</td>
                      <td className="p-2 text-left tabular-nums" dir="ltr">{iqd(r.closing)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="maintenance">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">سجلّ الصيانة — الإجمالي {iqd(a.maintTotal)} د.ع</CardTitle>
              {isLive && <Button size="sm" variant="outline" onClick={() => setOpenMaint(true)}>+ تسجيل صيانة</Button>}
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50"><tr className="text-right">
                  <th className="p-2">التاريخ</th><th className="p-2">النوع</th><th className="p-2">المزوّد</th><th className="p-2">ملاحظات</th><th className="p-2 text-left">التكلفة</th>
                </tr></thead>
                <tbody>
                  {a.maintenance.map((m) => (
                    <tr key={m.id} className="border-t">
                      <td className="p-2 text-xs" dir="ltr">{m.maintDate}</td>
                      <td className="p-2">{m.type}</td>
                      <td className="p-2 text-xs">{m.vendor ?? "—"}</td>
                      <td className="p-2 text-xs text-muted-foreground">{m.note ?? "—"}</td>
                      <td className="p-2 text-left tabular-nums" dir="ltr">{iqd(m.cost)}</td>
                    </tr>
                  ))}
                  {a.maintenance.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">لا عمليات صيانة مسجّلة.</td></tr>}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="custody">
          <Card>
            <CardHeader><CardTitle className="text-base">سلسلة العهدة</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {a.custody.length === 0 && <p className="text-sm text-muted-foreground">لا سجلّ عهدة لهذا الأصل.</p>}
              {a.custody.map((c) => (
                <div key={c.id} className="flex items-start gap-3 border-s-2 ps-3 border-border">
                  <div className="flex-1">
                    <div className="font-medium text-sm">{c.employeeName ?? "موظف"}</div>
                    <div className="text-xs text-muted-foreground" dir="ltr">{c.fromDate} ← {c.toDate ?? "حتى الآن"}</div>
                    {c.note && <div className="text-xs text-muted-foreground mt-0.5">{c.note}</div>}
                  </div>
                  {!c.toDate && <span className="rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 px-2 py-0.5 text-xs h-fit">جارية</span>}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="documents">
          <Card>
            <CardHeader><CardTitle className="text-base">المستندات</CardTitle></CardHeader>
            <CardContent>
              {a.docs.length === 0 ? (
                <p className="text-sm text-muted-foreground">لا مستندات مرفقة.</p>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {a.docs.map((doc) => (
                    <div key={doc.id} className="rounded-md border p-3 text-sm text-center">{doc.title}</div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* نافذة تسليم العهدة */}
      <Dialog open={openHandover} onOpenChange={setOpenHandover}>
        <DialogContent>
          <DialogHeader><DialogTitle>تسليم عهدة الأصل</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>الموظف المستلِم</Label>
              <select className={selectCls} value={hEmp} onChange={(e) => setHEmp(e.target.value)}>
                <option value="">— اختر موظفاً —</option>
                {(opts.data?.employees ?? []).map((e) => <option key={e.id} value={String(e.id)}>{e.name}{e.position ? ` — ${e.position}` : ""}</option>)}
              </select>
            </div>
            <div className="space-y-1"><Label>ملاحظة (اختياري)</Label><Textarea rows={2} value={hNote} onChange={(e) => setHNote(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenHandover(false)}>إلغاء</Button>
            <Button disabled={!hEmp || handover.isPending} onClick={() => handover.mutate({ assetId: id, employeeId: Number(hEmp), note: hNote.trim() || undefined })}>{handover.isPending ? "جارٍ…" : "تسليم"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* نافذة تسجيل الصيانة */}
      <Dialog open={openMaint} onOpenChange={setOpenMaint}>
        <DialogContent>
          <DialogHeader><DialogTitle>تسجيل صيانة</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>النوع *</Label><Input value={mType} onChange={(e) => setMType(e.target.value)} placeholder="صيانة دورية / استبدال قطعة" /></div>
              <div className="space-y-1"><Label>التاريخ</Label><Input type="date" dir="ltr" value={mDate} onChange={(e) => setMDate(e.target.value)} /></div>
              <div className="space-y-1"><Label>المزوّد</Label><Input value={mVendor} onChange={(e) => setMVendor(e.target.value)} /></div>
              <div className="space-y-1"><Label>التكلفة (د.ع)</Label><Input dir="ltr" value={mCost} onChange={(e) => setMCost(e.target.value)} placeholder="0" /></div>
            </div>
            <div className="space-y-1"><Label>ملاحظات</Label><Textarea rows={2} value={mNote} onChange={(e) => setMNote(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenMaint(false)}>إلغاء</Button>
            <Button disabled={!mType.trim() || addMaint.isPending} onClick={() => addMaint.mutate({ assetId: id, type: mType.trim(), vendor: mVendor.trim() || undefined, cost: mCost.trim() || undefined, note: mNote.trim() || undefined, maintDate: mDate })}>{addMaint.isPending ? "جارٍ…" : "حفظ"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* نافذة بطاقة الأصل (QR) */}
      <Dialog open={openLabel} onOpenChange={setOpenLabel}>
        <DialogContent>
          <DialogHeader><DialogTitle>بطاقة الأصل</DialogTitle></DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            <BarcodeDisplay barcodeSet={{ barcode128: a.code, qrPayload: a.code, displayLabel: `${a.name}\n${a.code}` }} size="md" />
            <div className="text-sm text-muted-foreground">{a.serial ? <span dir="ltr">SN: {a.serial}</span> : null}</div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenLabel(false)}>إغلاق</Button>
            <Button onClick={() => printAssetLabel({ code: a.code, name: a.name, serial: a.serial, branchName: a.branchName, category: a.category })}>طباعة الملصق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* نافذة الإخراج / الاستبعاد */}
      <Dialog open={openDispose} onOpenChange={setOpenDispose}>
        <DialogContent>
          <DialogHeader><DialogTitle>إخراج / استبعاد الأصل</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>النوع</Label>
              <select className={selectCls} value={dKind} onChange={(e) => setDKind(e.target.value as "retired" | "disposed")}>
                <option value="retired">إخراج من الخدمة (retired)</option>
                <option value="disposed">استبعاد ببيع/خردة (disposed)</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>التاريخ</Label><Input type="date" dir="ltr" value={dDate} onChange={(e) => setDDate(e.target.value)} /></div>
              {dKind === "disposed" && <div className="space-y-1"><Label>العائد (د.ع)</Label><Input dir="ltr" value={dValue} onChange={(e) => setDValue(e.target.value)} placeholder="0" /></div>}
            </div>
            <div className="space-y-1"><Label>السبب</Label><Textarea rows={2} value={dReason} onChange={(e) => setDReason(e.target.value)} /></div>
            {dKind === "disposed" && dValue.trim() && (
              <div className="text-xs text-muted-foreground">النتيجة مقابل القيمة الدفترية ({iqd(a.bookValue)}): <span dir="ltr" className={Number(dValue) - a.bookValue >= 0 ? "text-emerald-600" : "text-rose-600"}>{iqd(Number(dValue) - a.bookValue)}</span></div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenDispose(false)}>إلغاء</Button>
            <Button className="bg-destructive text-white hover:bg-destructive/90" disabled={dispose.isPending || (dKind === "disposed" && !dValue.trim())} onClick={() => dispose.mutate({ assetId: id, kind: dKind, date: dDate, reason: dReason.trim() || undefined, value: dKind === "disposed" ? dValue.trim() : undefined })}>{dispose.isPending ? "جارٍ…" : "تأكيد"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
