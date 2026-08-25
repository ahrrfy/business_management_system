import { RowActions } from "@/components/list";
import { PageHeader } from "@/components/PageHeader";
import { TableEmptyRow } from "@/components/PageState";
import { ScrollTableShell } from "@/components/table/ScrollTableShell";
import { TablePager } from "@/components/table/TablePager";
import { Button } from "@/components/ui/button";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { confirm } from "@/lib/confirm";
import { fmtDate, fmtDateTime } from "@/lib/date";
import { exportRows } from "@/lib/export";
import { fetchAllPaged } from "@/lib/fetchAllRows";
import { D, fmt, fmtInt } from "@/lib/money";
import { MoneyInput } from "@/components/form/MoneyInput";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { groupCategoriesTree } from "@/lib/categoryTree";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { CheckCircle2, ExternalLink, Scale, XCircle } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "wouter";

const MTYPE: Record<string, string> = {
  IN: "وارد",
  OUT: "صادر",
  ADJUST: "تسوية",
  RETURN: "مرتجع",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
};

/** حجم صفحة الأرصدة — onHand يعيد مصفوفة صرفة؛ صفحة مكتملة = «هناك المزيد» (نفس تقريب paginateKeyset). */
const PAGE_SIZE = 50;

type OnHandRow = RouterOutputs["inventory"]["onHand"][number];

function variantLabel(r: { variantName: string | null; color: string | null; size: string | null; sku: string }): string {
  const parts = [r.variantName, r.color, r.size].filter(Boolean);
  return parts.length ? parts.join(" / ") : r.sku;
}

export default function Inventory() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const canPickBranch = role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يختاران فرعاً
  const canAdjust = role === "admin" || role === "manager" || role === "warehouse";
  // التسوية المضمّنة سطر-بسطر للمدير فقط — المسار المعتمد للجميع صار جلسة جرد موثّقة.
  const canInlineAdjust = role === "admin" || role === "manager";
  const myBranch = me.data?.branchId ?? 1;

  const branches = trpc.branches.list.useQuery(undefined, { enabled: canPickBranch });
  const categoriesQ = trpc.catalog.categories.useQuery();

  // الفلاتر في querystring — تنجو من فتح التفاصيل والرجوع وتُشارَك رابطاً.
  // cat: "all" = الكل، "0" = بلا فئة، "<id>" = فئة محدّدة (sentinel لأن AppSelect يعامل "" كـplaceholder).
  const [f, setF, resetF] = useUrlFilters({ q: "", cat: "all", low: "", neg: "", branch: "" });
  const [page, setPage] = useState(0);
  const patchF = (patch: Partial<typeof f>) => { setF(patch); setPage(0); };

  const branchId = canPickBranch && f.branch ? Number(f.branch) : myBranch;
  const lowOnly = f.low === "1";
  const negativeOnly = f.neg === "1";
  const categoryId = f.cat === "all" ? undefined : Number(f.cat);
  const dq = useDebouncedValue(f.q, 200);

  const [err, setErr] = useState("");

  const onHandInput = {
    branchId,
    q: dq.trim() || undefined,
    lowOnly,
    negativeOnly,
    categoryId,
  };
  const onHand = trpc.inventory.onHand.useQuery(
    { ...onHandInput, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    { enabled: me.data != null },
  );
  // «آخر الحركات» بالأسماء (movementsRich) بدل الحركات الخام بأرقام المتغيّرات.
  const movements = trpc.inventory.movementsRich.useQuery(
    { branchId, limit: 20 },
    { enabled: me.data != null },
  );

  // تسوية مضمّنة (سطر واحد في كل مرة)
  const [editing, setEditing] = useState<number | null>(null);
  const [target, setTarget] = useState("");
  const [notes, setNotes] = useState("");
  // P2-#3 (٢٥/٨): سبب التسوية + مرفق إثبات. الأسبابُ الحسّاسة (DAMAGE/LOSS/THEFT) تُلزم المرفق
  // خادمياً؛ الشاشة تُظهر البادج توضيحاً وتضغط الصورة إلى ~600px قبل الإرسال (يوفّر ~90%).
  const ADJUSTMENT_REASONS = [
    { key: "STOCK_TAKE", label: "جرد" },
    { key: "DAMAGE", label: "تالف", requiresProof: true },
    { key: "LOSS", label: "فقد", requiresProof: true },
    { key: "THEFT", label: "سرقة", requiresProof: true },
    { key: "SAMPLE", label: "عيّنة" },
    { key: "INTERNAL_USE", label: "استخدام داخليّ" },
    { key: "GIFT", label: "إهداء" },
    { key: "CORRECTION", label: "تصحيح" },
    { key: "OTHER", label: "أخرى" },
  ] as const;
  type AdjReason = typeof ADJUSTMENT_REASONS[number]["key"];
  const [reason, setReason] = useState<AdjReason | "">("");
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  // معاينةُ مرفق الإثبات لطلبٍ معلَّق — يُقرأ عند الفتح (data URL خارج القائمة تخفيفاً).
  const [attachmentPreviewId, setAttachmentPreviewId] = useState<number | null>(null);
  const attachmentPreview = trpc.inventory.adjustmentAttachment.useQuery(
    { id: attachmentPreviewId ?? 0 },
    { enabled: attachmentPreviewId != null },
  );
  const reasonMeta = ADJUSTMENT_REASONS.find((r) => r.key === reason);
  const attachmentRequired = Boolean(reasonMeta && "requiresProof" in reasonMeta && reasonMeta.requiresProof);

  async function handleAttachmentChange(file: File | null) {
    if (!file) { setAttachmentUrl(null); return; }
    if (!/^image\/(jpeg|jpg|png|webp|gif)$/.test(file.type)) {
      setErr("المرفق يجب أن يكون صورة (JPEG/PNG/WebP/GIF)");
      return;
    }
    // ضغطُ الصورة إلى ≤600px عرضاً/طولاً بـcanvas قبل ترميزها base64 — يُخفض الحمولة ~10× ويبقى
    // الدليلُ البصريّ واضحاً. لا نُرسل الصورة الأصلية إذ يحتقن المخطّطُ بلا حاجة.
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 600 / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) { setErr("تعذّر ضغط الصورة (canvas غير متاح)"); return; }
    ctx.drawImage(bitmap, 0, 0, w, h);
    setAttachmentUrl(canvas.toDataURL("image/jpeg", 0.72));
    setErr("");
  }

  // فصل مهام #٦: التسوية صارت طلباً معلَّقاً يعتمده مديرٌ آخر ⇒ لا تغيير مخزون فوريّ.
  // مراجعة Codex P1 (٢٥/٨): مفتاحُ تكرارٍ مستقرّ لكل جلسة تحرير — نقرٌ مضاعف أو انقطاعُ شبكة يُعيد
  // نفس المفتاح ⇒ الخادمُ يُرجع الطلب الأوّل بدل إنشاء ثانٍ (يمنع الاعتمادَ المزدوج). يُدوَّر عند
  // بدء تحريرٍ جديد أو بعد نجاح الطلب — إعادةُ المحاولة ضمن نفس الجلسة تظلّ بالمفتاح نفسه.
  const adjustKeyRef = useRef<string | null>(null);
  const adjust = trpc.inventory.adjust.useMutation({
    onSuccess: async () => {
      adjustKeyRef.current = null; // rotate for next attempt
      setEditing(null);
      setTarget("");
      setNotes("");
      setReason("");
      setAttachmentUrl(null);
      notify.ok("سُجِّل طلب تسوية معلَّق — يعتمده مديرٌ آخر (فصل مهام).");
      await utils.inventory.pendingAdjustments.invalidate();
    },
    onError: (e) => setErr(e.message),
  });

  // اعتماد/رفض طلبات التسوية المعلَّقة (للمدير/الأدمن — على طلبات غيره، SOD-04).
  const canApprove = role === "admin" || role === "manager";
  const pending = trpc.inventory.pendingAdjustments.useQuery(
    { status: "PENDING_APPROVAL" },
    { enabled: canApprove && me.data != null },
  );
  const pendingRows = pending.data ?? [];
  const approveAdj = trpc.inventory.approveAdjustment.useMutation({
    onSuccess: async () => {
      notify.ok("اعتُمدت التسوية وطُبِّقت على المخزون.");
      await Promise.all([
        utils.inventory.pendingAdjustments.invalidate(),
        utils.inventory.onHand.invalidate(),
        utils.inventory.movements.invalidate(),
        utils.inventory.movementsRich.invalidate(),
      ]);
    },
    onError: (e) => notify.err(e),
  });
  // حوار النظام بدل window.prompt — سبب الرفض إلزامي للسجل التدقيقي.
  const [rejectTarget, setRejectTarget] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const rejectAdj = trpc.inventory.rejectAdjustment.useMutation({
    onSuccess: async () => {
      notify.ok("رُفض طلب التسوية.");
      setRejectTarget(null);
      await utils.inventory.pendingAdjustments.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  async function approveFlow(id: number) {
    if (!(await confirm({ title: "اعتماد التسوية", description: "ستُطبَّق التسوية على المخزون ويُرحَّل قيد ADJUST. متابعة؟", confirmText: "اعتماد" }))) return;
    approveAdj.mutate({ id });
  }
  function rejectFlow(id: number) {
    setRejectReason("");
    setRejectTarget(id);
  }

  /* ── إعادة تقييم التكلفة (حوكمة التكلفة — تدقيق ٢٧/٧) ────────────────────────────────
   * تعديل التكلفة من محرّر المنتج مُغلقٌ بنيوياً على صنفٍ له رصيد (يحرّك أصل المخزون بلا قيد).
   * هنا مسارُه المحكوم: طلبٌ بغرضٍ وسببٍ يعتمده مديرٌ ثانٍ فيُرحَّل القيد لكل فرعٍ له رصيد.
   */
  const [revalFor, setRevalFor] = useState<{ variantId: number; label: string } | null>(null);
  const [revalCost, setRevalCost] = useState("");
  const [revalPurpose, setRevalPurpose] = useState<"CORRECTION" | "IMPAIRMENT">("CORRECTION");
  const [revalReason, setRevalReason] = useState("");
  const revalPreview = trpc.inventory.costRevaluationPreview.useQuery(
    { variantId: revalFor?.variantId ?? 0 },
    { enabled: revalFor != null },
  );
  const [revalTab, setRevalTab] = useState<"PENDING_APPROVAL" | "APPROVED" | "REJECTED">("PENDING_APPROVAL");
  const pendingRevals = trpc.inventory.costRevaluations.useQuery(
    { status: revalTab },
    { enabled: canApprove && me.data != null },
  );
  const revalRows = pendingRevals.data ?? [];
  const requestReval = trpc.inventory.requestCostRevaluation.useMutation({
    onSuccess: async () => {
      notify.ok("سُجِّل طلب إعادة تقييم معلَّق — يعتمده مديرٌ آخر (فصل مهام).");
      setRevalFor(null);
      await utils.inventory.costRevaluations.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const approveReval = trpc.inventory.approveCostRevaluation.useMutation({
    onSuccess: async (res) => {
      notify.ok(`اعتُمدت إعادة التقييم — ${fmtInt(res.postedEntries)} قيداً بأثرٍ إجماليّ ${fmt(res.totalValueDelta)}.`);
      await Promise.all([
        utils.inventory.costRevaluations.invalidate(),
        utils.inventory.onHand.invalidate(),
      ]);
    },
    onError: (e) => notify.err(e),
  });
  const [revalRejectTarget, setRevalRejectTarget] = useState<number | null>(null);
  const [revalRejectReason, setRevalRejectReason] = useState("");
  const rejectReval = trpc.inventory.rejectCostRevaluation.useMutation({
    onSuccess: async () => {
      notify.ok("رُفض طلب إعادة التقييم.");
      setRevalRejectTarget(null);
      await utils.inventory.costRevaluations.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  // أثر القيمة يُحسب في الشاشة قبل الإرسال بنفس معادلة الخادم (Δالتكلفة × إجمالي الكمية).
  const revalDelta =
    revalPreview.data && revalCost.trim() !== ""
      ? D(revalCost).minus(D(revalPreview.data.costPrice)).times(revalPreview.data.totalQuantity)
      : null;
  const revalReasonOk = revalReason.trim().length >= 10;
  const revalCostOk =
    revalCost.trim() !== "" &&
    revalPreview.data != null &&
    !D(revalCost).isNegative() &&
    !D(revalCost).equals(D(revalPreview.data.costPrice)) &&
    (revalPurpose !== "IMPAIRMENT" || D(revalCost).lt(D(revalPreview.data.costPrice)));

  function startReval(r: { variantId: number; productName: string; sku: string }) {
    setRevalCost("");
    setRevalPurpose("CORRECTION");
    setRevalReason("");
    setRevalFor({ variantId: r.variantId, label: `${r.productName} — ${r.sku}` });
  }
  async function approveRevalFlow(id: number, delta: string) {
    if (
      !(await confirm({
        variant: "danger",
        title: "اعتماد إعادة التقييم",
        description: `ستُحدَّث تكلفة الصنف ويُرحَّل قيد ADJUST بأثرٍ قدره ${fmt(delta)} على أصل المخزون. متابعة؟`,
        confirmText: "اعتماد",
      }))
    )
      return;
    approveReval.mutate({ id });
  }

  function startAdjust(r: { variantId: number; quantity: number }) {
    setErr("");
    adjustKeyRef.current = null; // جلسةُ تحريرٍ جديدة ⇒ مفتاحٌ جديد عند أوّل نقرِ حفظ.
    setEditing(r.variantId);
    setTarget(String(r.quantity));
    setNotes("");
    setReason("");
    setAttachmentUrl(null);
  }
  async function saveAdjust(variantId: number) {
    setErr("");
    const t = Number(target);
    if (!Number.isInteger(t) || t < 0) {
      setErr("الرصيد المستهدف يجب أن يكون عدداً صحيحاً غير سالب.");
      return;
    }
    // ⭐ P2-#3: السببُ إلزاميّ على الشاشات الجديدة (الخادم يقبل NULL للتوافق الخلفيّ فقط).
    if (!reason) {
      setErr("اختر سببَ التسوية.");
      return;
    }
    if (attachmentRequired && !attachmentUrl) {
      setErr(`السبب «${reasonMeta?.label}» يستلزم مرفقَ إثبات بصريّ — التقط أو ارفع صورة.`);
      return;
    }
    if (
      !(await confirm({
        variant: "danger",
        title: "طلب تسوية الرصيد",
        description: `يُسجَّل طلبٌ لتعديل الرصيد إلى ${t.toLocaleString("ar-IQ-u-nu-latn")} — لا يُطبَّق حتى يعتمده مديرٌ آخر (فصل مهام). متابعة؟`,
        confirmText: "إرسال الطلب",
      }))
    )
      return;
    // نُوَلِّد المفتاح مرّةً فقط لكل جلسة تحرير؛ إعادةُ المحاولة (شبكة/نقر مضاعف) تظلّ بنفس المفتاح
    // ⇒ الخادم يُرجع الطلب الأوّل بدل إنشاء ثانٍ. onSuccess يُصفّره لدورةٍ جديدة.
    if (!adjustKeyRef.current) {
      adjustKeyRef.current = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `adj-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    adjust.mutate({
      variantId,
      branchId,
      targetQuantity: t,
      notes: notes.trim() || undefined,
      reason,
      attachmentUrl: attachmentUrl ?? undefined,
      clientRequestId: adjustKeyRef.current,
    });
  }

  const rows = onHand.data ?? [];
  // مصفوفة صرفة بلا COUNT — صفحة مكتملة تعني غالباً وجود المزيد (تقريب paginateKeyset في وضع offset).
  const hasMore = rows.length === PAGE_SIZE;
  const lowCount = rows.filter((r) => r.isLow).length;
  const anyFilter = f.q || f.cat !== "all" || f.low || f.neg || f.branch;

  const exportColumns = [
    { key: "productName" as const, header: "المنتج" },
    { key: "sku" as const, header: "المتغيّر / SKU", map: (r: OnHandRow) => variantLabel(r) + " (" + r.sku + ")" },
    { key: "quantity" as const, header: "الرصيد", map: (r: OnHandRow) => r.quantity },
    { key: "minStock" as const, header: "الحد الأدنى", map: (r: OnHandRow) => r.minStock ?? 0 },
    { key: "isLow" as const, header: "الحالة", map: (r: OnHandRow) => (r.isLow ? "منخفض" : "متوفّر") },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="المخزون"
        description="الأرصدة الحالية لكل منتج مع تسوية يدوية (جرد/تلف/تصحيح) تُسجَّل كحركة تدقيق، وسجلّ آخر الحركات."
        actions={
          lowCount > 0 ? (
            <span className="badge-stock-low rounded-full px-3 py-1 text-xs">
              {fmtInt(lowCount)} منتج تحت الحد الأدنى
            </span>
          ) : undefined
        }
      />

      <Card>
        <CardHeader><CardTitle className="text-base">الفلاتر</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          {canPickBranch && (
            <div className="space-y-1">
              <Label htmlFor="inv-branch">الفرع</Label>
              <AppSelect
                id="inv-branch"
                value={String(branchId)}
                onValueChange={(v) => patchF({ branch: v })}
              >
                {(branches.data ?? []).map((b) => (
                  <option key={Number(b.id)} value={String(Number(b.id))}>{b.name}</option>
                ))}
              </AppSelect>
            </div>
          )}
          <div className="space-y-1">
            <Label>بحث (اسم/SKU/متغيّر)</Label>
            <Input value={f.q} onChange={(e) => patchF({ q: e.target.value })} placeholder="مثال: ورق A4" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="inv-category">الفئة</Label>
            <AppSelect id="inv-category" value={f.cat} onValueChange={(v) => patchF({ cat: v })}>
              <option value="all">كل الفئات</option>
              <option value="0">— بلا فئة —</option>
              {groupCategoriesTree(categoriesQ.data ?? []).map(({ top, children }) =>
                children.length ? (
                  <optgroup key={top.id} label={top.name}>
                    <option value={String(top.id)}>{top.name} (عام)</option>
                    {children.map((c) => (
                      <option key={c.id} value={String(c.id)}>{c.name}</option>
                    ))}
                  </optgroup>
                ) : (
                  <option key={top.id} value={String(top.id)}>{top.name}</option>
                ),
              )}
            </AppSelect>
          </div>
          <label className="flex items-center gap-2 h-9 text-sm">
            <input type="checkbox" className="size-4" checked={lowOnly} onChange={(e) => patchF({ low: e.target.checked ? "1" : "" })} />
            <span className="text-muted-foreground">تحت الحد الأدنى فقط</span>
          </label>
          <label className="flex items-center gap-2 h-9 text-sm">
            <input type="checkbox" className="size-4" checked={negativeOnly} onChange={(e) => patchF({ neg: e.target.checked ? "1" : "" })} />
            <span className="text-muted-foreground">السوالب فقط (بانتظار الجرد الافتتاحي)</span>
          </label>
          {anyFilter && (
            <div className="flex items-center h-9">
              <Button variant="ghost" size="sm" onClick={() => { resetF(); setPage(0); }}>
                <XCircle aria-hidden className="size-4 ml-1" /> مسح الفلاتر
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {err && <p className="text-sm text-destructive">{err}</p>}

      {canApprove && pendingRows.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">طلبات تسوية معلَّقة ({fmtInt(pendingRows.length)})</CardTitle></CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">المنتج</th>
                    <th className="p-2 text-center">التغيير</th>
                    <th className="p-2 text-start">السبب</th>
                    <th className="p-2 text-start">ملاحظات + إثبات</th>
                    <th className="p-2 text-start">طلبها</th>
                    <th className="p-2 text-center">إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingRows.map((r) => {
                    const mine = r.createdBy != null && Number(r.createdBy) === Number(me.data?.id);
                    const reasonLabel = ADJUSTMENT_REASONS.find((x) => x.key === r.reason)?.label;
                    return (
                      <tr key={r.id} className="border-t">
                        <td className="p-2">{r.productName} — {r.variantName ?? r.sku}</td>
                        <td className="p-2 text-center">من {fmtInt(Number(r.currentQuantity ?? 0))} إلى {fmtInt(r.targetQuantity)}</td>
                        <td className="p-2 text-xs">{reasonLabel ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="p-2 text-muted-foreground text-xs">
                          {r.notes || <span>—</span>}
                          {r.hasAttachment && (
                            <button
                              type="button"
                              className="ms-2 text-primary underline underline-offset-2"
                              onClick={() => setAttachmentPreviewId(r.id)}
                            >
                              عرض الإثبات
                            </button>
                          )}
                        </td>
                        <td className="p-2">{r.createdByName ?? "—"}</td>
                        <td className="p-2 text-center">
                          {r.status !== "PENDING_APPROVAL" ? (
                            <span className="text-xs text-muted-foreground">
                              {r.status === "APPROVED" ? "اعتُمد" : "رُفض"}
                              {r.approvedAt ? ` — ${fmtDate(r.approvedAt)}` : ""}
                              {r.rejectionReason ? ` (${r.rejectionReason})` : ""}
                            </span>
                          ) : mine ? (
                            <span className="text-xs text-muted-foreground">أنت المُنشئ — يعتمده غيرك (فصل مهام)</span>
                          ) : (
                            <div className="flex items-center justify-center gap-2">
                              <Button size="sm" onClick={() => approveFlow(r.id)} disabled={approveAdj.isPending}><CheckCircle2 aria-hidden className="size-4 ml-1" /> اعتماد</Button>
                              <Button size="sm" variant="outline" onClick={() => rejectFlow(r.id)} disabled={rejectAdj.isPending}><XCircle aria-hidden className="size-4 ml-1" /> رفض</Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollTableShell>
          </CardContent>
        </Card>
      )}

      {/* P2-#3: معاينةُ مرفق الإثبات — يُقرأ data URL بشكلٍ مستقلٍّ عن قائمة الطلبات. */}
      <Dialog open={attachmentPreviewId != null} onOpenChange={(v) => !v && setAttachmentPreviewId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>مرفق إثبات — طلب #{attachmentPreviewId}</DialogTitle>
            <DialogDescription>
              الصورة مُقدَّمة من مُنشئ الطلب لتوثيق سببٍ حسّاس (تالف/فقد/سرقة). يعتمدها المُعتمِد ضمن الأدلّة.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-40 flex items-center justify-center">
            {attachmentPreview.isLoading ? (
              <span className="text-sm text-muted-foreground">جارٍ تحميل الصورة…</span>
            ) : attachmentPreview.data?.attachmentUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={attachmentPreview.data.attachmentUrl}
                alt="مرفق إثبات التسوية"
                className="max-h-[60vh] max-w-full rounded-md"
              />
            ) : (
              <span className="text-sm text-muted-foreground">لا مرفق مسجّل لهذا الطلب.</span>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {canApprove && (revalRows.length > 0 || revalTab !== "PENDING_APPROVAL") && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">
              إعادة تقييم التكلفة ({fmtInt(revalRows.length)})
            </CardTitle>
            {/* المعتمَد لا يختفي: حركةُ قيمةٍ بلا نقد يلزمها سجلٌّ يُظهرها بمستندها وفاعلها. */}
            <div className="w-56">
              <AppSelect
                value={revalTab}
                onValueChange={(v) => setRevalTab(v as "PENDING_APPROVAL" | "APPROVED" | "REJECTED")}
                size="sm"
                aria-label="حالة طلبات إعادة التقييم"
              >
                <option value="PENDING_APPROVAL">معلَّقة</option>
                <option value="APPROVED">معتمَدة</option>
                <option value="REJECTED">مرفوضة</option>
              </AppSelect>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollTableShell bordered={false}>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-start">المنتج</th>
                    <th className="p-2 text-center">التكلفة</th>
                    <th className="p-2 text-center">الكمية</th>
                    <th className="p-2 text-center">أثر القيمة</th>
                    <th className="p-2 text-start">الغرض والسبب</th>
                    <th className="p-2 text-start">طلبها</th>
                    <th className="p-2 text-center">{revalTab === "PENDING_APPROVAL" ? "إجراء" : "الحسم"}</th>
                  </tr>
                </thead>
                <tbody>
                  {revalRows.length === 0 && (
                    <TableEmptyRow colSpan={7} message="لا طلبات في هذه الحالة." />
                  )}
                  {revalRows.map((r) => {
                    const mine = Number(r.createdBy) === Number(me.data?.id);
                    const negative = D(r.expectedValueDelta).isNegative();
                    return (
                      <tr key={r.id} className="border-t">
                        <td className="p-2">{r.productName} — {r.variantLabel}</td>
                        <td className="p-2 text-center tabular-nums">{fmt(r.oldCost)} ← {fmt(r.newCost)}</td>
                        <td className="p-2 text-center tabular-nums">{fmtInt(r.expectedQuantity)}</td>
                        <td className={`p-2 text-center tabular-nums ${negative ? "text-money-negative" : "text-money-positive"}`}>
                          {fmt(r.expectedValueDelta)}
                        </td>
                        <td className="p-2 text-muted-foreground">
                          {r.purpose === "IMPAIRMENT" ? "هبوط قيمة" : "تصحيح تكلفة"} — {r.reason}
                        </td>
                        <td className="p-2">{r.createdByName ?? "—"}</td>
                        <td className="p-2 text-center">
                          {mine ? (
                            <span className="text-xs text-muted-foreground">أنت المُنشئ — يعتمده غيرك (فصل مهام)</span>
                          ) : (
                            <div className="flex items-center justify-center gap-2">
                              <Button size="sm" onClick={() => approveRevalFlow(r.id, r.expectedValueDelta)} disabled={approveReval.isPending}>
                                <CheckCircle2 aria-hidden className="size-4 ml-1" /> اعتماد
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => { setRevalRejectReason(""); setRevalRejectTarget(r.id); }}
                                disabled={rejectReval.isPending}
                              >
                                <XCircle aria-hidden className="size-4 ml-1" /> رفض
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollTableShell>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">الأرصدة الحالية</CardTitle>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {onHand.isLoading ? "جارٍ التحميل…" : `${fmtInt(rows.length)} في الصفحة`}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={onHand.isLoading}
              onClick={() =>
                // تصدير شامل لكل النتائج المطابقة للفلاتر (لا الصفحة المعروضة فقط) — onHand مصفوفة صرفة.
                exportRows<OnHandRow>(
                  () =>
                    fetchAllPaged<OnHandRow>(
                      (offset, fetchLimit) =>
                        utils.inventory.onHand
                          .fetch({ ...onHandInput, limit: fetchLimit, offset })
                          .then((arr) => ({ rows: arr })),
                      { pageSize: 500 },
                    ),
                  { filename: "المخزون", columns: exportColumns },
                )
              }
            >
              تصدير Excel
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {hasMore && (
            <p className="px-3 py-2 text-xs text-muted-foreground border-b bg-muted/30">
              القائمة مقسّمة صفحات — تنقّل بالترقيم أسفل الجدول، و«تصدير Excel» ينزّل كامل النتائج المطابقة للفلاتر.
            </p>
          )}
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-start">المنتج</th>
                <th className="p-2 text-start">المتغيّر / SKU</th>
                <th className="p-2 text-center">الرصيد</th>
                <th className="p-2 text-center">الحد الأدنى</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">آخر جرد</th>
                {/* العمود لكل الأدوار الآن (تحويل/حركات روابط قراءة)، والتسوية تبقى لمن يملكها */}
                <th className="p-2 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isEditing = editing === r.variantId;
                return (
                  <tr key={r.variantId} className={`border-t ${r.isLow ? "bg-[var(--sem-warn-bg)]" : ""}`}>
                    <td className="p-2 font-medium">{r.productName}</td>
                    <td className="p-2 text-xs">
                      {variantLabel(r)} <span className="text-muted-foreground font-mono" dir="ltr">({r.sku})</span>
                    </td>
                    <td className="p-2 text-center tabular-nums font-semibold">
                      {isEditing ? (
                        <Input
                          dir="ltr"
                          value={target}
                          onChange={(e) => setTarget(e.target.value)}
                          className="h-8 w-24 mx-auto text-center"
                          autoFocus
                        />
                      ) : (
                        fmtInt(r.quantity)
                      )}
                    </td>
                    <td className="p-2 text-center tabular-nums text-muted-foreground">{fmtInt(r.minStock ?? 0)}</td>
                    <td className="p-2 text-center">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${r.isLow ? "badge-stock-low" : "badge-status-active"}`}>
                        {r.isLow ? "منخفض" : "متوفّر"}
                      </span>
                    </td>
                    <td className="p-2 text-center text-xs text-muted-foreground" title="آخر جرد معتمد شمل هذا المنتج">
                      {r.lastCountedAt ? fmtDate(r.lastCountedAt) : "لم يُجرَد"}
                    </td>
                    <td className="p-2 text-center">
                      {canInlineAdjust && isEditing ? (
                        <div className="flex flex-col gap-1 items-stretch min-w-[220px]">
                          <AppSelect
                            value={reason}
                            onValueChange={(v) => setReason(v as AdjReason | "")}
                            placeholder="السبب (إلزاميّ)"
                            size="sm"
                          >
                            {ADJUSTMENT_REASONS.map((rr) => (
                              <option key={rr.key} value={rr.key}>
                                {"requiresProof" in rr && rr.requiresProof ? `${rr.label} · يستلزم مرفقاً` : rr.label}
                              </option>
                            ))}
                          </AppSelect>
                          <Input
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="ملاحظة اختيارية"
                            className="h-8 text-xs"
                          />
                          <label className="text-[11px] flex items-center gap-1 justify-center cursor-pointer text-muted-foreground hover:text-primary">
                            <input
                              type="file"
                              accept="image/*"
                              capture="environment"
                              className="hidden"
                              onChange={(e) => handleAttachmentChange(e.target.files?.[0] ?? null)}
                            />
                            {attachmentUrl
                              ? "صورة مرفقة — اضغط للتغيير"
                              : attachmentRequired
                              ? "التقط/ارفع صورة إثبات (إلزاميّ)"
                              : "إرفاق صورة (اختياريّ)"}
                          </label>
                          <div className="flex gap-1 justify-center">
                            <Button size="sm" onClick={() => saveAdjust(r.variantId)} disabled={adjust.isPending}>
                              {adjust.isPending ? "…" : "حفظ"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={adjust.isPending}>
                              إلغاء
                            </Button>
                          </div>
                        </div>
                      ) : (
                        // menu صريح: عدد الإجراءات الظاهرة يتفاوت بالدور — نثبّت ⋯ لاتساق الصفوف
                        <RowActions
                          mode="menu"
                          actions={[
                            {
                              key: "stocktake",
                              kind: "create",
                              label: "جلسة جرد للمنتج",
                              hidden: !canAdjust,
                              href: `/stocktakes/new?variants=${r.variantId}&name=${encodeURIComponent(`جرد تحقّق — ${r.productName}`)}`,
                              gate: { roles: ["warehouse", "manager"], module: "inventory", level: "FULL" },
                            },
                            {
                              key: "adjust",
                              kind: "edit",
                              label: "تسوية مباشرة (مدير)",
                              hidden: !canInlineAdjust,
                              onSelect: () => startAdjust(r),
                              gate: { roles: ["manager"], module: "inventory", level: "FULL" },
                            },
                            {
                              key: "revalue",
                              kind: "edit",
                              label: "إعادة تقييم التكلفة",
                              hidden: !canInlineAdjust,
                              onSelect: () => startReval(r),
                              gate: { roles: ["manager"], module: "inventory", level: "FULL" },
                            },
                            {
                              key: "transfer",
                              kind: "create",
                              label: "تحويل بين الفروع",
                              href: "/transfers",
                              gate: { roles: ["warehouse", "manager"], module: "inventory", level: "FULL" },
                            },
                            {
                              key: "moves",
                              kind: "view",
                              label: "حركات المنتج",
                              // شاشة الحركات تقرأ ?q= من URL فتفتح مفلترة على SKU
                              href: `/inventory-movements?q=${encodeURIComponent(r.sku)}`,
                              gate: { module: "inventory", level: "READ" },
                            },
                          ]}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
              {!onHand.isLoading && rows.length === 0 && (
                <TableEmptyRow colSpan={7} message={page > 0 ? "لا صفوف في هذه الصفحة — ارجع للصفحة السابقة." : "لا منتجات برصيد في هذا الفرع. أضف رصيداً افتتاحياً أو سجّل استلام شراء."} />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
          <TablePager
            page={page}
            onPageChange={setPage}
            pageSize={PAGE_SIZE}
            rowsOnPage={rows.length}
            hasMore={hasMore}
            isLoading={onHand.isLoading}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">آخر الحركات</CardTitle>
          <Link href="/inventory-movements" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <ExternalLink aria-hidden className="size-3.5" /> كل الحركات بالفلاتر
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollTableShell bordered={false}>
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-start">التاريخ</th>
                <th className="p-2 text-start">المنتج</th>
                <th className="p-2 text-start">النوع</th>
                <th className="p-2 text-center">الكمية (أساس)</th>
                <th className="p-2 text-start">المرجع</th>
              </tr>
            </thead>
            <tbody>
              {(movements.data?.rows ?? []).map((m) => (
                <tr key={m.id} className="border-t">
                  <td className="p-2 text-xs">{fmtDateTime(m.createdAt)}</td>
                  <td className="p-2 text-xs">
                    {m.productName}
                    <span className="text-muted-foreground"> — {variantLabel(m)}</span>
                  </td>
                  <td className="p-2 text-xs">{MTYPE[m.movementType] ?? m.movementType}</td>
                  <td className="p-2 text-center tabular-nums">{fmtInt(m.quantity)}</td>
                  <td className="p-2 text-muted-foreground text-xs">{m.referenceType ?? "—"}{m.referenceId ? ` #${m.referenceId}` : ""}</td>
                </tr>
              ))}
              {movements.data && movements.data.rows.length === 0 && (
                <TableEmptyRow colSpan={5} message="لا حركات مخزون بعد." />
              )}
            </tbody>
          </table>
          </ScrollTableShell>
        </CardContent>
      </Card>

      {/* حوار رفض طلب التسوية — بديل window.prompt: سبب إلزامي يُكتب للسجل التدقيقي. */}
      <Dialog open={rejectTarget != null} onOpenChange={(o) => { if (!o) setRejectTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>رفض طلب التسوية</DialogTitle>
            <DialogDescription>اذكر سبب الرفض — يُسجَّل في السجل التدقيقي ويظهر لمُنشئ الطلب.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1 py-1">
            <Label htmlFor="reject-reason">سبب الرفض</Label>
            <Textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="مثال: الرصيد الحالي صحيح — لا حاجة للتسوية"
              rows={3}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectTarget(null)} disabled={rejectAdj.isPending}>إلغاء</Button>
            <Button
              variant="destructive"
              disabled={rejectAdj.isPending || !rejectReason.trim()}
              onClick={() => {
                if (rejectTarget == null || !rejectReason.trim()) return;
                rejectAdj.mutate({ id: rejectTarget, reason: rejectReason.trim() });
              }}
            >
              <XCircle aria-hidden className="size-4 ml-1" /> رفض الطلب
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* طلب إعادة تقييم التكلفة — أثر القيمة يُعرَض قبل الإرسال، ولا يقع شيء حتى يعتمده مديرٌ ثانٍ. */}
      <Dialog open={revalFor != null} onOpenChange={(o) => { if (!o) setRevalFor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>إعادة تقييم التكلفة — {revalFor?.label}</DialogTitle>
            <DialogDescription>
              تغيير التكلفة يحرّك قيمة المخزون في الميزانية، فيلزمه غرضٌ محاسبيّ وسببٌ مكتوب واعتماد مديرٍ آخر.
              يُرحَّل عند الاعتماد قيدٌ بقيمة فرق التكلفة × الكمية لكل فرعٍ له رصيد.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            {revalPreview.isLoading && <p className="text-sm text-muted-foreground">جارٍ قراءة التكلفة والأرصدة…</p>}
            {revalPreview.data && (
              <>
                <div className="rounded-md border p-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">التكلفة الحالية</span>
                    <span className="tabular-nums">{fmt(revalPreview.data.costPrice)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">إجمالي الكمية المملوكة</span>
                    <span className="tabular-nums">{fmtInt(revalPreview.data.totalQuantity)}</span>
                  </div>
                  {revalPreview.data.branches.length > 1 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      موزّعة على: {revalPreview.data.branches.map((b) => `${b.branchName ?? `#${b.branchId}`} (${fmtInt(b.quantity)})`).join(" · ")}
                    </p>
                  )}
                  {revalPreview.data.totalQuantity === 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">لا رصيد لهذا الصنف — تُصحَّح التكلفة بلا قيدٍ محاسبيّ.</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="reval-cost">التكلفة الجديدة</Label>
                    <MoneyInput id="reval-cost" value={revalCost} onChange={setRevalCost} placeholder="0" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="reval-purpose">الغرض المحاسبيّ</Label>
                    <AppSelect
                      id="reval-purpose"
                      value={revalPurpose}
                      onValueChange={(v) => setRevalPurpose(v as "CORRECTION" | "IMPAIRMENT")}
                    >
                      <option value="CORRECTION">تصحيح تكلفة خاطئة</option>
                      <option value="IMPAIRMENT">هبوط قيمة / تقادم (نزولاً فقط)</option>
                    </AppSelect>
                  </div>
                </div>

                {revalDelta != null && !revalDelta.isZero() && (
                  <p className="text-sm">
                    أثر القيمة على المخزون:{" "}
                    <span className={`tabular-nums ${revalDelta.isNegative() ? "text-money-negative" : "text-money-positive"}`}>
                      {fmt(revalDelta.toFixed(2))}
                    </span>
                  </p>
                )}
                {revalPurpose === "IMPAIRMENT" && revalCost.trim() !== "" && D(revalCost).gte(D(revalPreview.data.costPrice)) && (
                  <p className="text-sm text-destructive">هبوط القيمة لا يرفع التكلفة — اختر «تصحيح تكلفة خاطئة» إن كان رفعاً مقصوداً.</p>
                )}

                <div className="space-y-1">
                  <Label htmlFor="reval-reason">سبب إعادة التقييم (١٠ محارف على الأقلّ)</Label>
                  <Textarea
                    id="reval-reason"
                    value={revalReason}
                    onChange={(e) => setRevalReason(e.target.value)}
                    placeholder="مثال: أُدخلت تكلفة الكرتون بدل تكلفة القطعة عند الاستلام"
                    rows={3}
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevalFor(null)} disabled={requestReval.isPending}>إلغاء</Button>
            <Button
              disabled={requestReval.isPending || !revalCostOk || !revalReasonOk}
              onClick={() => {
                if (revalFor == null) return;
                requestReval.mutate({
                  variantId: revalFor.variantId,
                  newCost: D(revalCost).toFixed(2),
                  purpose: revalPurpose,
                  reason: revalReason.trim(),
                });
              }}
            >
              <Scale aria-hidden className="size-4 ml-1" /> إرسال الطلب للاعتماد
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* رفض طلب إعادة التقييم — سببٌ إلزاميّ يظهر لمُنشئ الطلب. */}
      <Dialog open={revalRejectTarget != null} onOpenChange={(o) => { if (!o) setRevalRejectTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>رفض طلب إعادة التقييم</DialogTitle>
            <DialogDescription>اذكر سبب الرفض — يُسجَّل ويظهر لمُنشئ الطلب.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1 py-1">
            <Label htmlFor="reval-reject-reason">سبب الرفض</Label>
            <Textarea
              id="reval-reject-reason"
              value={revalRejectReason}
              onChange={(e) => setRevalRejectReason(e.target.value)}
              placeholder="مثال: التكلفة الحالية مطابقة لفاتورة المورّد"
              rows={3}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevalRejectTarget(null)} disabled={rejectReval.isPending}>إلغاء</Button>
            <Button
              variant="destructive"
              disabled={rejectReval.isPending || !revalRejectReason.trim()}
              onClick={() => {
                if (revalRejectTarget == null || !revalRejectReason.trim()) return;
                rejectReval.mutate({ id: revalRejectTarget, reason: revalRejectReason.trim() });
              }}
            >
              <XCircle aria-hidden className="size-4 ml-1" /> رفض الطلب
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
