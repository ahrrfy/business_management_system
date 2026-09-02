import { BarcodeDisplay } from "@/components/BarcodeDisplay";
import { AppSelect } from "@/components/ui/AppSelect";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { LoadingState, ErrorState, TableEmptyRow } from "@/components/PageState";
import { AssetStatusBadge, categoryIcon, iqd } from "@/lib/assets/ui";
import { assetSettlementPresentation } from "@/lib/assetAccrualStatus";
import { printAssetLabel } from "@/lib/assets/print";
import { confirm } from "@/lib/confirm";
import { fmtDate } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { assetCategoryLabel, depreciationMethodLabel } from "@shared/assets";
import { INBOUND_METHOD_OPTIONS } from "@/lib/paymentMethod";
import type { InboundEnabledPaymentMethod } from "@shared/inboundPaymentPolicy";
import { PlayCircle, Trash2, Upload, FileText, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { selectClsFull } from "@/lib/ui/formStyles";

const today = () => new Date().toISOString().slice(0, 10);

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
  const me = trpc.auth.me.useQuery();
  const acquisitionCorrections = trpc.assets.acquisitionCorrections.useQuery(
    { assetId: id, obligationId: Number(q.data?.accrualObligationId ?? 0) },
    {
      enabled:
        Number.isFinite(id) &&
        Number(q.data?.accrualObligationId ?? 0) > 0 &&
        q.data?.accrualObligationKind === "ASSET_ACQUISITION_CASH",
    },
  );

  const [tab, setTab] = useState("overview");
  const [openHandover, setOpenHandover] = useState(false);
  const [openMaint, setOpenMaint] = useState(false);
  const [openLabel, setOpenLabel] = useState(false);
  const [openDispose, setOpenDispose] = useState(false);
  const [openCorrection, setOpenCorrection] = useState(false);

  // نماذج النوافذ
  const [hEmp, setHEmp] = useState("");
  const [hNote, setHNote] = useState("");
  const [mType, setMType] = useState("");
  const [mVendor, setMVendor] = useState("");
  const [mVendorSupplierId, setMVendorSupplierId] = useState("");
  const [mEvidenceReference, setMEvidenceReference] = useState("");
  const [mClientRequestId, setMClientRequestId] = useState(() => crypto.randomUUID());
  const [mCost, setMCost] = useState("");
  const [mNote, setMNote] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [docImages, setDocImages] = useState<ImageItem[]>([]);
  const [mDate, setMDate] = useState(today());
  const [dKind, setDKind] = useState<"retired" | "disposed">("retired");
  const [dDate, setDDate] = useState(today());
  const [dReason, setDReason] = useState("");
  const [dValue, setDValue] = useState("");
  const [supplierSettlementRequestId, setSupplierSettlementRequestId] = useState(() => crypto.randomUUID());
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionEvidence, setCorrectionEvidence] = useState("");
  const [correctionAttachment, setCorrectionAttachment] = useState<ImageItem[]>([]);
  const [correctionRefundMethod, setCorrectionRefundMethod] = useState<InboundEnabledPaymentMethod>("CASH");
  const [correctionRefundBucket, setCorrectionRefundBucket] = useState<"DRAWER" | "TREASURY">("TREASURY");
  const [correctionRefundReference, setCorrectionRefundReference] = useState("");
  const [correctionRefundCardTail, setCorrectionRefundCardTail] = useState("");
  const [correctionReviewReason, setCorrectionReviewReason] = useState("");
  const [correctionClientRequestId, setCorrectionClientRequestId] = useState(() => crypto.randomUUID());

  const refresh = async () => {
    await Promise.all([utils.assets.get.invalidate({ id }), utils.assets.list.invalidate(), utils.assets.dashboard.invalidate(), utils.assets.disposalLog.invalidate(), utils.assets.custodyReport.invalidate()]);
  };

  const handover = trpc.assets.handover.useMutation({ onSuccess: async () => { notify.ok("تم تسليم العهدة"); setOpenHandover(false); setHEmp(""); setHNote(""); await refresh(); }, onError: (e) => notify.err(e) });
  const addMaint = trpc.assets.addMaintenance.useMutation({ onSuccess: async (a) => { notify.ok(a?.paymentPending ? "سُجّلت الصيانة، أمّا دفعها النقدي فمعلّق حتى اعتماد مالكٍ آخر من سندات الصرف" : "تم تسجيل الصيانة"); setOpenMaint(false); setMType(""); setMVendor(""); setMVendorSupplierId(""); setMEvidenceReference(""); setMClientRequestId(crypto.randomUUID()); setMCost(""); setMNote(""); await refresh(); }, onError: (e) => notify.err(e) });
  const returnMaint = trpc.assets.returnFromMaintenance.useMutation({ onSuccess: async () => { notify.ok("أُعيد الأصل للخدمة"); await refresh(); }, onError: (e) => notify.err(e) });
  const addDoc = trpc.assets.addDocument.useMutation({ onSuccess: async () => { notify.ok("رُفِع المستند"); setDocTitle(""); setDocImages([]); await refresh(); }, onError: (e) => notify.err(e) });
  const delDoc = trpc.assets.deleteDocument.useMutation({ onSuccess: async () => { notify.ok("حُذِف المستند"); await refresh(); }, onError: (e) => notify.err(e) });
  const dispose = trpc.assets.dispose.useMutation({ onSuccess: async () => { notify.ok("تم تنفيذ الإخراج/الاستبعاد"); setOpenDispose(false); setDReason(""); setDValue(""); await refresh(); }, onError: (e) => notify.err(e) });
  const requestSupplierSettlement = trpc.assets.requestSupplierSettlement.useMutation({ onSuccess: async () => { notify.ok("أُنشئ طلب سداد ذمة المورد بلا أثر نقدي حتى اعتماد مالك آخر"); setSupplierSettlementRequestId(crypto.randomUUID()); await refresh(); }, onError: (e) => notify.err(e) });
  const requestCorrection = trpc.assets.requestAcquisitionCorrection.useMutation({
    onSuccess: async () => {
      notify.ok("سُجل طلب تصحيح المصدر؛ لا عكس مالي قبل اعتماد مالك آخر وإثبات الاسترداد عند الدفع");
      setOpenCorrection(false);
      setCorrectionClientRequestId(crypto.randomUUID());
      setCorrectionReason("");
      setCorrectionEvidence("");
      setCorrectionAttachment([]);
      await Promise.all([refresh(), acquisitionCorrections.refetch()]);
    },
    onError: (e) => notify.err(e),
  });
  const approveCorrection = trpc.assets.approveAcquisitionCorrection.useMutation({
    onSuccess: async () => {
      notify.ok("اعتمد التصحيح وعُكس الاعتراف بقيد مستقل");
      await Promise.all([refresh(), acquisitionCorrections.refetch()]);
    },
    onError: (e) => notify.err(e),
  });
  const rejectCorrection = trpc.assets.rejectAcquisitionCorrection.useMutation({
    onSuccess: async () => {
      notify.ok("رُفض التصحيح وبقي الالتزام والأثر الأصليان كما هما");
      await Promise.all([refresh(), acquisitionCorrections.refetch()]);
    },
    onError: (e) => notify.err(e),
  });

  const a = q.data;
  const Icon = useMemo(() => (a ? categoryIcon(a.category) : null), [a]);

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState message={`تعذّر تحميل الأصل: ${q.error.message}`} onRetry={() => q.refetch()} />;
  if (!a) return <div className="p-10 text-center text-muted-foreground">الأصل غير موجود. <Link href="/assets/register" className="text-primary">رجوع للسجلّ</Link></div>;

  // حالة الأصل التشغيلية مستقلة عن تسوية التزام اقتنائه. ثبوت الحيازة يفعّل
  // الأصل والإهلاك فوراً، بينما يصف paymentPending النقد الذي لم يخرج بعد.
  const isPaymentPending = a.paymentPending === true;
  const isLive = a.isActive !== false && (a.status === "active" || a.status === "maintenance");
  const settlement = assetSettlementPresentation(a.settlementStatus);
  const pendingCorrection = acquisitionCorrections.data?.find((item) => item.status === "PENDING") ?? null;
  const canRequestCorrection =
    a.accrualObligationKind === "ASSET_ACQUISITION_CASH" &&
    ["ACCRUED_UNPAID", "PAYMENT_PENDING", "PAID"].includes(a.settlementStatus ?? "") &&
    pendingCorrection == null;

  return (
    <div className="space-y-4 max-w-5xl">
      <PageHeader
        title="بطاقة الأصل"
        backHref="/assets/register"
        backLabel="رجوع لسجلّ الأصول"
      />

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
                <AssetStatusBadge status={a.status} />
                {a.settlementStatus && (
                  <span
                    title={settlement.detail}
                    className={`${settlement.tone === "active" ? "badge-status-active" : settlement.tone === "cancelled" ? "badge-status-cancelled" : "badge-status-pending"} rounded-full px-2 py-0.5 text-xs`}
                  >
                    {settlement.label}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {a.status !== "disposed" && <Link href={`/assets/${id}/edit`}><Button variant="outline" size="sm">تعديل</Button></Link>}
            {a.settlementStatus === "PAYABLE_UNSETTLED" && <Button variant="outline" size="sm" disabled={requestSupplierSettlement.isPending} onClick={() => requestSupplierSettlement.mutate({ assetId: id, clientRequestId: supplierSettlementRequestId })}>طلب سداد ذمة المورد</Button>}
            {canRequestCorrection && <Button variant="outline" size="sm" className="text-destructive" onClick={() => setOpenCorrection(true)}>طلب تصحيح الاقتناء</Button>}
            <Button variant="outline" size="sm" onClick={() => setOpenLabel(true)}>بطاقة الأصل</Button>
            {isLive && <Button variant="outline" size="sm" onClick={() => setOpenMaint(true)}>تسجيل صيانة</Button>}
            {a.status === "maintenance" && <Button variant="outline" size="sm" onClick={async () => { if (!(await confirm({ variant: "warning", title: "إعادة الأصل للخدمة", description: `إعادة الأصل «${a.name}» (${a.code}) من الصيانة إلى الخدمة؟`, confirmText: "إعادة للخدمة" }))) return; returnMaint.mutate({ assetId: id }); }} disabled={returnMaint.isPending}>إعادة للخدمة</Button>}
            {isLive && <Button variant="outline" size="sm" onClick={() => setOpenHandover(true)}>تسليم عهدة</Button>}
            {isLive && <Button variant="outline" size="sm" className="text-destructive" onClick={() => setOpenDispose(true)}>إخراج / استبعاد</Button>}
          </div>
        </CardContent>
      </Card>

      {settlement.liabilityOutstanding && (
        <div role="status" className="rounded-md border badge-status-pending p-3 text-sm">
          <div className="font-bold">{settlement.detail}</div>
          <p className="mt-1">
            الأصل مُثبت تشغيلياً، وتسوية الالتزام معلّقة. الحيازة وقيمة الأصل مثبتتان ويستمر التشغيل والإهلاك وفق حالته.
            {isPaymentPending ? " لم يخرج نقد بعد." : ""}
          </p>
        </div>
      )}

      {(acquisitionCorrections.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">سجل تصحيح مصدر الاقتناء</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {acquisitionCorrections.data?.map((item) => {
              const canReview =
                item.status === "PENDING" &&
                item.previousObligationStatus !== "PAID" &&
                me.data?.isOwner === true &&
                Number(item.requestedBy) !== Number(me.data.id);
              return (
                <div key={item.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">طلب #{item.id} — {item.status === "PENDING" ? "بانتظار الاعتماد" : item.status === "APPROVED" ? "معتمد" : "مرفوض"}</div>
                    <span className={item.status === "APPROVED" ? "badge-status-active rounded-full px-2 py-0.5 text-xs" : item.status === "REJECTED" ? "badge-status-cancelled rounded-full px-2 py-0.5 text-xs" : "badge-status-pending rounded-full px-2 py-0.5 text-xs"}>{item.previousObligationStatus === "PAID" ? "يتطلب استرداداً فعلياً" : "عكس اعتراف فقط"}</span>
                  </div>
                  <p className="mt-2">{item.reason}</p>
                  <p className="mt-1 text-xs text-muted-foreground" dir="ltr">{item.externalEvidenceReference}</p>
                  {item.status === "PENDING" && item.previousObligationStatus === "PAID" && (
                    <p className="mt-2 text-xs text-muted-foreground">يعتمد أو يُرفض من سند قبض الاسترداد المعلّق؛ لا يُنشأ قبض تلقائي.</p>
                  )}
                  {canReview && (
                    <div className="mt-3 space-y-2 border-t pt-3">
                      <Label htmlFor={`correction-review-${item.id}`}>سبب الرفض عند الرفض</Label>
                      <Input id={`correction-review-${item.id}`} value={correctionReviewReason} onChange={(event) => setCorrectionReviewReason(event.target.value)} placeholder="يُترك فارغاً عند الاعتماد" />
                      <div className="flex gap-2">
                        <Button size="sm" disabled={approveCorrection.isPending || rejectCorrection.isPending} onClick={async () => {
                          if (!(await confirm({ variant: "warning", title: "اعتماد تصحيح الاقتناء", description: "سيُعكس قيد الاعتراف ويُغلق المصدر الأصلي. العملية append-only ولا تحذف الأثر السابق.", confirmText: "اعتماد التصحيح" }))) return;
                          approveCorrection.mutate({ assetId: id, correctionRequestId: Number(item.id) });
                        }}>اعتماد التصحيح</Button>
                        <Button variant="destructive" size="sm" disabled={correctionReviewReason.trim().length < 3 || approveCorrection.isPending || rejectCorrection.isPending} onClick={() => rejectCorrection.mutate({ assetId: id, correctionRequestId: Number(item.id), reason: correctionReviewReason.trim() })}>رفض التصحيح</Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

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
            <Field label="تاريخ الشراء" value={fmtDate(a.purchaseDate)} dir="ltr" />
            <Field label="نهاية الكفالة" value={fmtDate(a.warrantyEnd)} dir="ltr" />
            <Field label="الحالة الفنية" value={a.condition} />
            <Field label="العمر الإنتاجي" value={`${a.usefulLifeYears} سنة`} />
            <Field label="القيمة التخريدية" value={iqd(a.salvageValue)} dir="ltr" />
            <Field label="إجمالي الصيانة" value={iqd(a.maintTotal)} dir="ltr" />
            {a.status === "disposed" || a.status === "retired" ? (
              <>
                <Field label="تاريخ الإخراج" value={fmtDate(a.disposalDate)} dir="ltr" />
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
                <thead className="bg-muted/50"><tr>
                  <th className="p-2">السنة</th>
                  <th className="p-2 text-right">القيمة أول المدة</th>
                  <th className="p-2 text-right">إهلاك السنة</th>
                  <th className="p-2 text-right">القيمة آخر المدة</th>
                </tr></thead>
                <tbody>
                  {a.schedule.map((r) => (
                    <tr key={r.year} className={`border-t ${r.isCurrent ? "bg-primary/5 font-medium" : ""}`}>
                      <td className="p-2" dir="ltr"><span className="inline-flex items-center gap-1">{r.year}{r.isCurrent ? <PlayCircle aria-hidden className="size-3" /> : null}</span></td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{iqd(r.opening)}</td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{iqd(r.dep)}</td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{iqd(r.closing)}</td>
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
                <thead className="bg-muted/50"><tr>
                  <th className="p-2">التاريخ</th><th className="p-2">النوع</th><th className="p-2">المزوّد</th><th className="p-2">ملاحظات</th><th className="p-2 text-right">التكلفة</th>
                </tr></thead>
                <tbody>
                  {a.maintenance.map((m) => (
                    <tr key={m.id} className="border-t">
                      <td className="p-2 text-xs" dir="ltr">{fmtDate(m.maintDate)}</td>
                      <td className="p-2">{m.type}</td>
                      <td className="p-2 text-xs">{m.vendor ?? "—"}</td>
                      <td className="p-2 text-xs text-muted-foreground">{m.note ?? "—"}</td>
                      <td className="p-2 text-right tabular-nums" dir="ltr">{iqd(m.cost)}</td>
                    </tr>
                  ))}
                  {a.maintenance.length === 0 && <TableEmptyRow colSpan={5} message="لا عمليات صيانة مسجّلة." />}
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
                    <div className="text-xs text-muted-foreground" dir="ltr">{fmtDate(c.fromDate)} — {c.toDate ? fmtDate(c.toDate) : "حتى الآن"}</div>
                    {c.note && <div className="text-xs text-muted-foreground mt-0.5">{c.note}</div>}
                  </div>
                  {!c.toDate && <span className="badge-status-active rounded-full px-2 py-0.5 text-xs h-fit">جارية</span>}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="documents">
          <Card>
            <CardHeader><CardTitle className="text-base">المستندات</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {/* رفع مستند جديد (فاتورة شراء/كفالة/محضر…) — صورة مضغوطة تلقائياً */}
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                    <div className="space-y-1">
                      <Label htmlFor="doc-title" className="text-xs">عنوان المستند</Label>
                      <Input id="doc-title" value={docTitle} maxLength={255} onChange={(e) => setDocTitle(e.target.value)} placeholder="مثال: فاتورة الشراء / بطاقة الكفالة" />
                    </div>
                    <Button
                      type="button"
                      disabled={!docTitle.trim() || !docImages[0]?.dataUrl || addDoc.isPending}
                      onClick={() => addDoc.mutate({ assetId: id, title: docTitle.trim(), dataUrl: docImages[0]!.dataUrl })}
                      className="gap-1.5"
                    >
                      <Upload aria-hidden className="size-4" /> رفع المستند
                    </Button>
                  </div>
                  <ImageUploader
                    value={docImages}
                    onChange={setDocImages}
                    maxItems={1}
                    singlePrimary={false}
                    hint="صورة المستند (PNG/JPG) — تُضغط تلقائياً قبل الحفظ."
                  />
              </div>

              {/* المستندات المرفوعة */}
              {a.docs.length === 0 ? (
                <p className="text-sm text-muted-foreground">لا مستندات مرفقة بعد.</p>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {a.docs.map((doc) => (
                    <div key={doc.id} className="flex flex-col gap-2 rounded-md border p-3 text-sm">
                      <div className="flex items-start gap-1.5 font-medium">
                        <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span className="break-words">{doc.title}</span>
                      </div>
                      <div className="mt-auto flex items-center justify-between gap-2">
                        {doc.dataUrl ? (
                          <a href={doc.dataUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
                            <ExternalLink aria-hidden className="size-3.5" /> عرض
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">بلا ملف</span>
                        )}
                        <button
                            type="button"
                            disabled={delDoc.isPending}
                            onClick={async () => {
                              if (await confirm({ variant: "danger", title: "حذف المستند؟", description: `«${doc.title}» — لا يمكن التراجع.`, confirmText: "حذف" })) {
                                delDoc.mutate({ docId: doc.id });
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                            aria-label={`حذف المستند ${doc.title}`}
                          >
                            <Trash2 aria-hidden className="size-3.5" /> حذف
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={openCorrection} onOpenChange={setOpenCorrection}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>طلب تصحيح مصدر اقتناء الأصل</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              هذا ليس حذفاً للأصل أو تعديلاً لقيمته. بعد اعتماد مالك آخر يُغلق المصدر الأصلي ويُنشأ عكس محاسبي مستقل. يُرفض الطلب إذا بدأ إهلاك الأصل أو صيانته أو نقله أو تسليمه أو استبعاده.
            </div>
            <div className="space-y-1">
              <Label htmlFor="asset-correction-reason">سبب التصحيح *</Label>
              <Textarea id="asset-correction-reason" rows={3} value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="asset-correction-evidence">مرجع الدليل الخارجي *</Label>
              <Input id="asset-correction-evidence" dir="ltr" value={correctionEvidence} onChange={(event) => setCorrectionEvidence(event.target.value)} placeholder="رقم إشعار دائن/محضر إلغاء" />
            </div>
            <ImageUploader value={correctionAttachment} onChange={setCorrectionAttachment} maxItems={1} singlePrimary={false} hint="مرفق الدليل الخارجي إلزامي ولا يستبدل مرجع مزود الاسترداد." />
            {a.settlementStatus === "PAID" && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">إثبات استرداد المبلغ المدفوع</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="asset-refund-method">طريقة الاسترداد *</Label>
                    {/* الخيارات مشتقّة من سياسة القبض المشتركة — «صك» كان معروضاً بينما
                        `assertInboundPaymentMethodEnabled` يرفضه في سند الاسترداد ⇒ صفر مسار نجاح. */}
                    <AppSelect id="asset-refund-method" className="h-9" value={correctionRefundMethod} onValueChange={(next) => setCorrectionRefundMethod(next as typeof correctionRefundMethod)}>
                      {INBOUND_METHOD_OPTIONS.map((m) => (
                        <option key={m.v} value={m.v}>{m.label}</option>
                      ))}
                    </AppSelect>
                  </div>
                  {correctionRefundMethod === "CASH" ? (
                    <div className="space-y-1">
                      <Label htmlFor="asset-refund-bucket">وجهة النقد *</Label>
                      <AppSelect id="asset-refund-bucket" className="h-9" value={correctionRefundBucket} onValueChange={(next) => setCorrectionRefundBucket(next as typeof correctionRefundBucket)}>
                        <option value="TREASURY">الخزينة الإدارية</option>
                        <option value="DRAWER">درج الوردية</option>
                      </AppSelect>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <Label htmlFor="asset-refund-reference">مرجع مزود الاسترداد *</Label>
                      <Input id="asset-refund-reference" dir="ltr" value={correctionRefundReference} onChange={(event) => setCorrectionRefundReference(event.target.value)} />
                    </div>
                  )}
                  {correctionRefundMethod === "CARD" && (
                    <div className="space-y-1">
                      <Label htmlFor="asset-refund-card-tail">آخر أربعة أرقام *</Label>
                      <Input id="asset-refund-card-tail" dir="ltr" inputMode="numeric" maxLength={4} value={correctionRefundCardTail} onChange={(event) => setCorrectionRefundCardTail(event.target.value.replace(/\D/g, "").slice(0, 4))} />
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">سيُنشأ طلب قبض معلّق صفر الأثر؛ لا يدخل المال فعلياً إلا بعد اعتماد مالك آخر ومطابقة دليل المزود.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenCorrection(false)}>إلغاء</Button>
            <Button
              variant="destructive"
              disabled={
                requestCorrection.isPending ||
                correctionReason.trim().length < 3 ||
                !correctionEvidence.trim() ||
                !correctionAttachment[0]?.dataUrl ||
                (a.settlementStatus === "PAID" && correctionRefundMethod !== "CASH" && !correctionRefundReference.trim()) ||
                (a.settlementStatus === "PAID" && correctionRefundMethod === "CARD" && !/^\d{4}$/.test(correctionRefundCardTail))
              }
              onClick={() => requestCorrection.mutate({
                assetId: id,
                obligationId: Number(a.accrualObligationId),
                reason: correctionReason.trim(),
                externalEvidenceReference: correctionEvidence.trim(),
                attachmentUrl: correctionAttachment[0]!.dataUrl,
                refundPaymentMethod: a.settlementStatus === "PAID" ? correctionRefundMethod : null,
                refundCashBucket: a.settlementStatus === "PAID" && correctionRefundMethod === "CASH" ? correctionRefundBucket : null,
                refundReferenceNumber: a.settlementStatus === "PAID" && correctionRefundMethod !== "CASH" ? correctionRefundReference.trim() : null,
                refundCardLastFour: a.settlementStatus === "PAID" && correctionRefundMethod === "CARD" ? correctionRefundCardTail : null,
                clientRequestId: correctionClientRequestId,
              })}
            >
              {requestCorrection.isPending ? "جارٍ التسجيل…" : "تسجيل طلب التصحيح"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* نافذة تسليم العهدة */}
      <Dialog open={openHandover} onOpenChange={(o) => { setOpenHandover(o); if (!o) { setHEmp(""); setHNote(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>تسليم عهدة الأصل</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="handoverEmp">الموظف المستلِم</Label>
              <AppSelect id="handoverEmp" className="h-9" value={hEmp} onValueChange={(next) => setHEmp(next)}>
                <option value="">— اختر موظفاً —</option>
                {(opts.data?.employees ?? []).map((e) => <option key={e.id} value={String(e.id)}>{e.name}{e.position ? ` — ${e.position}` : ""}</option>)}
              </AppSelect>
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
      <Dialog open={openMaint} onOpenChange={(o) => { setOpenMaint(o); if (!o) { setMType(""); setMVendor(""); setMVendorSupplierId(""); setMEvidenceReference(""); setMClientRequestId(crypto.randomUUID()); setMCost(""); setMNote(""); setMDate(today()); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>تسجيل صيانة</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label htmlFor="maintType">النوع *</Label><Input id="maintType" value={mType} onChange={(e) => setMType(e.target.value)} placeholder="صيانة دورية / استبدال قطعة" /></div>
              <div className="space-y-1"><Label>التاريخ</Label><Input type="date" dir="ltr" value={mDate} onChange={(e) => setMDate(e.target.value)} /></div>
              <div className="space-y-1"><Label>جهة الصيانة المسجلة</Label><AppSelect className="h-9" value={mVendorSupplierId} onValueChange={(next) => setMVendorSupplierId(next)}><option value="">— جهة خارجية غير مسجلة —</option>{(opts.data?.suppliers ?? []).map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}</AppSelect></div>
              {!mVendorSupplierId && <div className="space-y-1"><Label>اسم جهة الصيانة الحقيقي *</Label><Input value={mVendor} onChange={(e) => setMVendor(e.target.value)} /></div>}
              <div className="space-y-1"><Label htmlFor="maintCost">التكلفة (د.ع)</Label><MoneyInput id="maintCost" value={mCost} onChange={setMCost} decimals={0} /></div>
              <div className="space-y-1"><Label>مرجع فاتورة/وصل الصيانة *</Label><Input value={mEvidenceReference} onChange={(e) => setMEvidenceReference(e.target.value)} dir="ltr" /></div>
            </div>
            <div className="space-y-1"><Label>ملاحظات</Label><Textarea rows={2} value={mNote} onChange={(e) => setMNote(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenMaint(false)}>إلغاء</Button>
            <Button disabled={!mType.trim() || addMaint.isPending || (!!mCost.trim() && (!mEvidenceReference.trim() || (!mVendorSupplierId && !mVendor.trim())))} onClick={() => addMaint.mutate({ assetId: id, type: mType.trim(), vendor: mVendorSupplierId ? undefined : (mVendor.trim() || undefined), vendorSupplierId: mVendorSupplierId ? Number(mVendorSupplierId) : undefined, cost: mCost.trim() || undefined, evidenceReference: mEvidenceReference.trim() || undefined, clientRequestId: mClientRequestId, note: mNote.trim() || undefined, maintDate: mDate })}>{addMaint.isPending ? "جارٍ…" : "حفظ"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* نافذة بطاقة الأصل (QR) */}
      <Dialog open={openLabel} onOpenChange={setOpenLabel}>
        <DialogContent>
          <DialogHeader><DialogTitle>بطاقة الأصل</DialogTitle></DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            <BarcodeDisplay barcodeSet={{ barcode128: a.code, qrPayload: a.code, displayLabel: `${a.name}\n${a.code}` }} size="md" showCode128={false} />
            <div className="text-sm text-muted-foreground">{a.serial ? <span dir="ltr">SN: {a.serial}</span> : null}</div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenLabel(false)}>إغلاق</Button>
            <Button onClick={() => printAssetLabel({ code: a.code, name: a.name, serial: a.serial, branchName: a.branchName, category: a.category })}>طباعة الملصق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* نافذة الإخراج / الاستبعاد */}
      <Dialog open={openDispose} onOpenChange={(o) => { setOpenDispose(o); if (!o) { setDReason(""); setDValue(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>إخراج / استبعاد الأصل</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="disposeKind">النوع</Label>
              <AppSelect id="disposeKind" className="h-9" value={dKind} onValueChange={(next) => setDKind(next as "retired" | "disposed")}>
                <option value="retired">إخراج من الخدمة</option>
                <option value="disposed">استبعاد ببيع/خردة</option>
              </AppSelect>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>التاريخ</Label><Input type="date" dir="ltr" value={dDate} onChange={(e) => setDDate(e.target.value)} /></div>
              {dKind === "disposed" && <div className="space-y-1"><Label htmlFor="disposeValue">العائد (د.ع)</Label><MoneyInput id="disposeValue" value={dValue} onChange={setDValue} decimals={0} /></div>}
            </div>
            <div className="space-y-1"><Label>السبب</Label><Textarea rows={2} value={dReason} onChange={(e) => setDReason(e.target.value)} /></div>
            {dKind === "disposed" && dValue.trim() && Number.isFinite(Number(dValue)) && (
              <div className="text-xs text-muted-foreground">النتيجة مقابل القيمة الدفترية ({iqd(a.bookValue)}): <span dir="ltr" className={Number(dValue) - a.bookValue >= 0 ? "text-money-positive" : "text-money-negative"}>{iqd(Number(dValue) - a.bookValue)}</span></div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenDispose(false)}>إلغاء</Button>
            <Button className="bg-destructive text-white hover:bg-destructive/90" disabled={dispose.isPending || (dKind === "disposed" && !dValue.trim())} onClick={async () => { if (!(await confirm({ variant: "danger", title: dKind === "disposed" ? "استبعاد الأصل" : "إخراج الأصل من الخدمة", description: `الإخراج/الاستبعاد لا رجعة فيه — يُحذف الأصل «${a.name}» (${a.code}) من السجلّ النشط ويؤثّر على الدفتر. اكتب اسم الأصل للتأكيد.`, confirmText: dKind === "disposed" ? "استبعاد" : "إخراج", requireText: a.name }))) return; dispose.mutate({ assetId: id, kind: dKind, date: dDate, reason: dReason.trim() || undefined, value: dKind === "disposed" ? dValue.trim() : undefined }); }}>{dispose.isPending ? "جارٍ…" : "تأكيد"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
