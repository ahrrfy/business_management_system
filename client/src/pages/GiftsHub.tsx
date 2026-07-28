// شاشة الهدايا والمجانيات — G-م١ الوارد (استلام مجّانيّ من مورّد، صفر تكلفة) + G-م٢ الصادر (منح للعميل،
// GIFT_OUT + حوكمة SOD: فوق العتبة/غير المدير ⇒ اعتماد مدير آخر). القراءة/الكتابة خلف مفتاح `gifts`.
import { useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Check, Gift, Plus, Trash2 } from "lucide-react";
import { hasModuleAccess } from "@shared/permissions";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import SupplierPicker from "@/components/voucher/SupplierPicker";
import CustomerPicker from "@/components/CustomerPicker";
import { ProductSearchBar } from "@/components/invoice/ProductSearchBar";
import type { InvoiceLine } from "@/components/invoice/types";

type Mode = "list" | "in" | "out";
type DirFilter = "ALL" | "IN" | "OUT" | "PENDING";
type GiftLine = { key: number; variantId: number; productUnitId: number; label: string; unit: string; quantity: string };

const STATUS_AR: Record<string, string> = {
  DRAFT: "مسودة",
  PENDING_APPROVAL: "بانتظار اعتماد",
  APPROVED: "معتمد",
  DELIVERED: "مُنجَز",
  CANCELLED: "ملغى",
  REVERSED: "معكوس",
};

export default function GiftsHub() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role ?? "";
  const override = (me.data as { permissionsOverride?: Record<string, "NONE" | "READ" | "FULL"> | null } | undefined)?.permissionsOverride ?? null;
  const elevated = role === "admin" || role === "manager";
  const canWrite = hasModuleAccess(role, override, "gifts", "FULL");
  const canApprove = role === "admin" || role === "manager";

  const [mode, setMode] = useState<Mode>("list");
  const [dirFilter, setDirFilter] = useState<DirFilter>("ALL");

  // ── حالة النموذج (مشتركة بين الوارد والصادر) ──
  const [formBranchId, setFormBranchId] = useState<number | null>(null);
  const branchId = elevated ? formBranchId : me.data?.branchId ?? null;
  const branches = trpc.branches.list.useQuery(undefined, { enabled: elevated });
  const [supplierId, setSupplierId] = useState<number | null>(null); // وارد
  const [customerId, setCustomerId] = useState<number | null>(null); // صادر
  const [giftType, setGiftType] = useState("");
  const [reason, setReason] = useState("");
  const [supplierRef, setSupplierRef] = useState(""); // وارد
  const [estimatedValue, setEstimatedValue] = useState(""); // وارد
  const [notes, setNotes] = useState("");
  const [sellable, setSellable] = useState(true); // وارد: قابل للبيع؟ (false = استخدام داخليّ/عيّنة)
  const [lines, setLines] = useState<GiftLine[]>([]);
  const keyRef = useRef(1);
  // مفتاح حماية الازدواج — يُولَّد لكل فتح نموذجٍ جديد؛ إعادة الإرسال بنفسه لا تُنشئ سنداً ثانياً (Codex P1).
  const [reqId, setReqId] = useState("");

  const list = trpc.gifts.list.useQuery(
    dirFilter === "PENDING"
      ? { status: "PENDING_APPROVAL" as const }
      : dirFilter === "ALL"
        ? {}
        : { direction: dirFilter as "IN" | "OUT" },
  );

  function resetForm() {
    setSupplierId(null);
    setCustomerId(null);
    setGiftType("");
    setReason("");
    setSupplierRef("");
    setEstimatedValue("");
    setNotes("");
    setSellable(true);
    setLines([]);
    setFormBranchId(null);
  }
  function backToList() {
    resetForm();
    setMode("list");
    utils.gifts.list.invalidate();
  }
  function openForm(m: "in" | "out") {
    resetForm();
    setReqId(crypto.randomUUID()); // مفتاح idempotency جديد لكل عملية إنشاء
    setMode(m);
  }

  const inbound = trpc.gifts.receiveInbound.useMutation({
    onSuccess: (res) => {
      notify.ok(`تم استلام الهدية الواردة — ${res.giftNumber}`);
      backToList();
    },
    onError: (e) => notify.err(e),
  });
  const outbound = trpc.gifts.createOutbound.useMutation({
    onSuccess: (res) => {
      notify.ok(res.pending ? `الهدية بانتظار اعتماد مدير — ${res.giftNumber}` : `تم منح الهدية — ${res.giftNumber}`);
      backToList();
    },
    onError: (e) => notify.err(e),
  });
  const approve = trpc.gifts.approveGift.useMutation({
    onSuccess: () => {
      notify.ok("تم اعتماد الهدية");
      utils.gifts.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  function addLine(l: InvoiceLine) {
    setLines((prev) => {
      const hit = prev.find((x) => x.variantId === l.variantId && x.productUnitId === l.productUnitId);
      if (hit) return prev.map((x) => (x === hit ? { ...x, quantity: String(Number(x.quantity) + l.qty) } : x));
      return [...prev, { key: keyRef.current++, variantId: l.variantId, productUnitId: l.productUnitId, label: l.name, unit: l.unit, quantity: String(l.qty) }];
    });
  }
  const setLineQty = (key: number, q: string) => setLines((prev) => prev.map((x) => (x.key === key ? { ...x, quantity: q } : x)));
  const removeLine = (key: number) => setLines((prev) => prev.filter((x) => x.key !== key));

  const busy = inbound.isPending || outbound.isPending;
  const canSubmit = canWrite && branchId != null && lines.length > 0 && lines.every((l) => Number(l.quantity) > 0) && !busy;
  const linePayload = () => lines.map((l) => ({ variantId: l.variantId, productUnitId: l.productUnitId, quantity: Number(l.quantity), refSalePrice: null }));

  function submitInbound() {
    if (!canSubmit) return;
    inbound.mutate({
      branchId: elevated ? branchId! : undefined,
      supplierId: supplierId ?? undefined,
      giftType: giftType.trim() || undefined,
      reason: reason.trim() || undefined,
      supplierRef: supplierRef.trim() || undefined,
      estimatedValue: estimatedValue.trim() || undefined,
      notes: notes.trim() || undefined,
      sellable,
      clientRequestId: reqId,
      lines: linePayload(),
    });
  }
  function submitOutbound() {
    if (!canSubmit) return;
    outbound.mutate({
      branchId: elevated ? branchId! : undefined,
      customerId: customerId ?? undefined,
      giftType: giftType.trim() || undefined,
      reason: reason.trim() || undefined,
      notes: notes.trim() || undefined,
      clientRequestId: reqId,
      lines: linePayload(),
    });
  }

  const rows = list.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <PageHeader
        title="الهدايا والمجانيات"
        description="الوارد المجّاني من الموردين (صفر تكلفة يخفّف متوسّط الكلفة، بلا دين) والصادر للعملاء (مصروف ترويجيّ بحوكمة اعتماد)."
        actions={
          mode === "list" ? (
            canWrite ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => openForm("in")}>
                  <ArrowDownToLine aria-hidden className="me-1 size-4" />
                  استلام وارد
                </Button>
                <Button size="sm" variant="secondary" onClick={() => openForm("out")}>
                  <ArrowUpFromLine aria-hidden className="me-1 size-4" />
                  منح هدية صادرة
                </Button>
              </div>
            ) : null
          ) : (
            <Button size="sm" variant="outline" onClick={backToList}>
              رجوع للقائمة
            </Button>
          )
        }
      />

      {mode === "list" ? (
        <>
          <div className="flex gap-2">
            {([
              ["ALL", "الكل"],
              ["IN", "واردة"],
              ["OUT", "صادرة"],
              ["PENDING", "بانتظار الاعتماد"],
            ] as [DirFilter, string][]).map(([k, lbl]) => (
              <Button key={k} size="sm" variant={dirFilter === k ? "default" : "outline"} onClick={() => setDirFilter(k)}>
                {lbl}
              </Button>
            ))}
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-start">رقم السند</th>
                  <th className="px-3 py-2 text-start">الاتجاه</th>
                  <th className="px-3 py-2 text-start">التاريخ</th>
                  <th className="px-3 py-2 text-start">الطرف</th>
                  <th className="px-3 py-2 text-start">الحالة</th>
                  <th className="px-3 py-2 text-end">القيمة التقديرية</th>
                  <th className="px-3 py-2 text-end">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-muted-foreground">
                      جارٍ التحميل…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-muted-foreground">
                      لا توجد سندات هدايا بعد.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{r.giftNumber}</td>
                      <td className="px-3 py-2">
                        <span className={r.direction === "IN" ? "text-money-positive" : "text-[var(--sem-info)]"}>
                          {r.direction === "IN" ? "وارد" : "صادر"}
                        </span>
                      </td>
                      <td className="px-3 py-2">{r.createdAt ? new Date(r.createdAt as unknown as string).toISOString().slice(0, 10) : ""}</td>
                      <td className="px-3 py-2">{r.supplierName ?? r.customerName ?? "—"}</td>
                      <td className="px-3 py-2">{STATUS_AR[r.status] ?? r.status}</td>
                      <td className="px-3 py-2 text-end">{r.estimatedValue ?? "—"}</td>
                      <td className="px-3 py-2 text-end">
                        {r.direction === "OUT" && r.status === "PENDING_APPROVAL" && canApprove ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={approve.isPending}
                            onClick={() => approve.mutate({ giftId: Number(r.id) })}
                          >
                            <Check aria-hidden className="me-1 size-3.5" />
                            اعتماد
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="space-y-4 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Gift aria-hidden className="size-4" />
            {mode === "in"
              ? "استلام بضاعة مجّانية من مورّد — ترفع المخزون بصفر تكلفة (تخفيف متوسّط الكلفة) بلا قيد شراء ولا دين."
              : "منح هدية للعميل — تخصم المخزون بالكلفة كمصروف «هدايا وترويج» (بلا بيع/نقد/ذمة). فوق العتبة أو من غير مدير: تُعلَّق لاعتماد مدير آخر."}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {elevated ? (
              <div className="space-y-1">
                <Label>الفرع *</Label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={formBranchId ?? ""}
                  onChange={(e) => setFormBranchId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">— اختر الفرع —</option>
                  {(branches.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {mode === "in" ? (
              <div className="space-y-1">
                <Label>المورّد (اختياري)</Label>
                <SupplierPicker supplierId={supplierId} onSupplierChange={setSupplierId} label="" />
              </div>
            ) : (
              <div className="space-y-1">
                <Label>العميل (اختياري)</Label>
                <CustomerPicker customerId={customerId} onCustomerChange={setCustomerId} />
              </div>
            )}

            <div className="space-y-1">
              <Label>نوع الهدية (اختياري)</Label>
              <Input value={giftType} onChange={(e) => setGiftType(e.target.value)} placeholder={mode === "in" ? "مثال: عيّنة، اشترِ واحصل" : "مثال: مجاملة، تعويض، حملة"} maxLength={32} />
            </div>

            {mode === "in" ? (
              <>
                <div className="space-y-1">
                  <Label>رقم عرض المورّد (اختياري)</Label>
                  <Input value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} maxLength={64} />
                </div>
                <div className="space-y-1">
                  <Label>القيمة التقديرية (اختياري)</Label>
                  <Input value={estimatedValue} onChange={(e) => setEstimatedValue(e.target.value)} inputMode="decimal" placeholder="للتقارير فقط — لا تدخل الدفتر" />
                </div>
              </>
            ) : null}

            <div className="space-y-1">
              <Label>السبب (اختياري)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} />
            </div>
          </div>

          {mode === "in" ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sellable} onChange={(e) => setSellable(e.target.checked)} className="size-4" />
              <span>قابل للبيع (يدخل مخزون البيع ويخفّف متوسّط الكلفة)</span>
              {!sellable ? <span className="text-muted-foreground">— للاستخدام الداخليّ/عيّنة: يُوثَّق بلا رفع مخزون</span> : null}
            </label>
          ) : null}

          <div className="space-y-2">
            <Label>الأصناف *</Label>
            {branchId == null ? (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">اختر الفرع أولاً لإضافة الأصناف.</div>
            ) : (
              <ProductSearchBar
                invoiceType={mode === "in" ? "PURCHASE" : "SALE"}
                branchId={branchId}
                tier="RETAIL"
                onAddProduct={addLine}
                onNotify={(msg, kind) => (kind === "error" ? notify.err(msg) : notify.info(msg))}
              />
            )}

            {lines.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-start">الصنف</th>
                      <th className="px-3 py-2 text-start">الوحدة</th>
                      <th className="px-3 py-2 text-start">الكمية</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.key} className="border-t">
                        <td className="px-3 py-2">{l.label}</td>
                        <td className="px-3 py-2">{l.unit}</td>
                        <td className="px-3 py-2">
                          <Input value={l.quantity} onChange={(e) => setLineQty(l.key, e.target.value)} inputMode="numeric" className="h-8 w-24" />
                        </td>
                        <td className="px-3 py-2 text-end">
                          <Button size="icon" variant="ghost" onClick={() => removeLine(l.key)} aria-label="حذف السطر">
                            <Trash2 aria-hidden className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label>ملاحظات (اختياري)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500} />
          </div>

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="outline" onClick={backToList}>
              إلغاء
            </Button>
            <Button onClick={mode === "in" ? submitInbound : submitOutbound} disabled={!canSubmit}>
              <Plus aria-hidden className="me-1 size-4" />
              {busy ? "جارٍ الحفظ…" : mode === "in" ? "استلام" : "منح الهدية"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
