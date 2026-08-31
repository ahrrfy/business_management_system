/**
 * **حوارُ إلغاء أمر الشغل** — سببٌ صريح ومصيرُ خامةٍ صادق (ش٤، ١٩/٨).
 *
 * كان الإلغاء نافذةَ تأكيدٍ نصّية تَعِد بأنّ «المواد تُعاد للمخزون» — وتعيدها **كاملةً دائماً**
 * ولو أُتلف نصفُها فعلاً. فيدخل المخزونَ ورقٌ محروقٌ ما زال يُحسَب أصلاً بقيمته، ويظهر ربحٌ
 * لم يقع. والسببُ كان يذوب: لا عمود يحمله ولا تقرير يُظهره.
 *
 * فهنا سطرٌ لكلّ خامة: **راجع** و**تالف**، مجموعُهما = المستهلَك (يفرضه الخادم أيضاً)، وقيمةُ
 * الهدر تظهر **قبل** التأكيد — لا امتصاصَ خفيّ (§٥).
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, PackageX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { estimatedWorkOrderCancelCashOut, workOrderCancelNeedsCashDrawer } from "@/lib/refundDrawer";
import { RefundDrawerPicker, useRefundDrawer } from "./RefundDrawerPicker";

export interface CancelMaterialRow {
  id: number;
  name: string;
  baseQuantity: number;
  unitCost: string | null;
}

/**
 * **غلافٌ يجلب التفاصيل بالمعرّف** — للشاشات التي تملك المعرّف وحده (لوحة الطلبات).
 *
 * كانت اللوحة تُلغي بـ`confirm()` نصّية: بلا سببٍ يُكتب (والعمود موجودٌ منذ 0237)، وبلا
 * قرارِ هدرٍ للخامة (فتعود محروقةً أصلاً صالحة)، وبلا درجِ ردٍّ — **ثلاثةُ حوائطَ في نافذةٍ
 * واحدة**. توحيدُها على الحوار نفسه يُغلقها معاً ويجعل سلوكَ الإلغاء واحداً في الشاشتين.
 */
export function CancelWorkOrderDialogById({
  workOrderId,
  onOpenChange,
  pending,
  onConfirm,
}: {
  /** `null` ⇒ مغلق. */
  workOrderId: number | null;
  onOpenChange: (v: boolean) => void;
  pending?: boolean;
  onConfirm: (d: CancelDecision) => void;
}) {
  const q = trpc.workOrders.get.useQuery(
    { workOrderId: workOrderId ?? 0 },
    { enabled: workOrderId != null },
  );
  const d = q.data;
  if (workOrderId == null || !d) return null;
  return (
    <CancelWorkOrderDialog
      open
      onOpenChange={onOpenChange}
      workOrderId={workOrderId}
      branchId={d.branchId}
      orderNumber={d.orderNumber}
      title={d.title}
      deposit={d.deposit}
      paymentMethod={d.paymentMethod}
      // نفسُ شرط شاشة التفاصيل: الخامة تُعرَض بعد البدء فقط — قبله لا استهلاك.
      materials={
        d.status === "IN_PROGRESS" || d.status === "READY"
          ? (d.materials ?? []).map((m) => ({
              id: Number(m.id),
              name: [m.productName, m.variantName].filter(Boolean).join(" — ") || m.sku || `#${m.variantId}`,
              baseQuantity: Number(m.baseQuantity),
              unitCost: m.unitCost ?? null,
            }))
          : []
      }
      pending={pending}
      onConfirm={onConfirm}
    />
  );
}

export interface CancelDecision {
  reason: string;
  materials: Array<{ workOrderMaterialId: number; returnBase: number; wasteBase: number }> | undefined;
  /** درجُ الاسترداد النقديّ — يُرسَل فقط حين يخرج نقدٌ فعلاً. */
  refundShiftId: number | undefined;
}

/** أسبابٌ جاهزة — نقرةٌ بدل كتابة، والحقلُ الحرّ يبقى لما لا يُحصى. */
const REASONS = [
  "لم يحضر العميل لاستلام الطلب",
  "العميل ألغى الطلب",
  "خطأ في إدخال الطلب",
  "تعذّر التنفيذ فنّياً",
  "الخامة غير متوفّرة",
];

export default function CancelWorkOrderDialog({
  open,
  onOpenChange,
  workOrderId,
  branchId,
  orderNumber,
  title,
  deposit,
  paymentMethod,
  /** أسطر الخامة المستهلَكة — فارغةٌ إن لم يبدأ التنفيذ (فلا جدولَ ولا هدر). */
  materials,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workOrderId: number;
  /** فرعُ **الأمر** لا فرعُ المستخدم — الإلغاء صلاحيةُ مديرٍ قد يعبر الفروع. */
  branchId: number | null | undefined;
  orderNumber: string;
  title: string;
  deposit: string | null | undefined;
  paymentMethod: string | null | undefined;
  materials: CancelMaterialRow[];
  pending?: boolean;
  onConfirm: (d: CancelDecision) => void;
}) {
  const [reason, setReason] = useState("");
  const [waste, setWaste] = useState<Record<number, number>>({});

  /**
   * أمانةُ أجرة التوصيل تُردّ **نقداً دائماً** عند الإلغاء ولو كان العربون بطاقة
   * ([`cancel.ts`](../../../../server/services/workOrder/cancel.ts)) — فهي رافدٌ ثالثٌ
   * يستوجب الدرج وحدَه.
   */
  const feeHeldQ = trpc.workOrders.deliveryFeeHeld.useQuery(
    { workOrderId },
    { enabled: open, staleTime: 0 },
  );
  const cashOutArgs = { deposit, paymentMethod, deliveryFeeHeldNet: feeHeldQ.data?.net ?? null };
  const needsCashDrawer = workOrderCancelNeedsCashDrawer(cashOutArgs);
  const drawer = useRefundDrawer({
    needed: open && needsCashDrawer,
    branchId,
    // مسارُ أمر الشغل يقصر على RECEPTION (resolveLockedReceptionCashShift) — عرضُ درج POS
    // هنا يُعيد نفسَ رسالة الرفض بعد الاختيار.
    requiredShiftType: "RECEPTION",
    emptyLabel: "وردية استقبال",
    estimatedAmount: estimatedWorkOrderCancelCashOut(cashOutArgs),
  });

  // فتحٌ جديد ⇒ حالةٌ نظيفة: سببٌ قديم أو درجٌ أُغلق بينهما يُنتجان تأكيداً يكذب.
  useEffect(() => {
    if (!open) return;
    setReason("");
    setWaste({});
    drawer.reset();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasMaterials = materials.length > 0;
  const anyWaste = materials.some((m) => (waste[m.id] ?? 0) > 0);
  /**
   * **الكلفة محجوبةٌ عن بعض الأدوار** (`redactPosCost` — الكاشير يرى الكمّيات لا الأسعار)
   * فتصل `unitCost = null`. و`Number(null ?? 0)` كان يُنتج **صفراً يُعرَض رقماً حقيقياً**:
   * «يُسجَّل هدرٌ بقيمة ٠» على أربع قطعٍ تالفة — كذبةٌ تُطمئن الموظّف إلى أنّ إتلافه بلا ثمن.
   * فحين تُحجَب كلفةُ **أيّ** سطرٍ مُهدَر لا نَدّعي قيمةً إطلاقاً: نُظهر الكمّية ونقول إنّ
   * القيمة غير مرئيّة لهذا الدور. والخادم يحسبها من كلفته الحقيقيّة في كلّ الأحوال.
   */
  const wastedLines = materials.filter((m) => (waste[m.id] ?? 0) > 0);
  const costVisible = wastedLines.length > 0 && wastedLines.every((m) => m.unitCost != null);
  const wastedValue = useMemo(
    () => materials.reduce((sum, m) => sum + (waste[m.id] ?? 0) * Number(m.unitCost ?? 0), 0),
    [materials, waste],
  );
  const wastedPieces = wastedLines.reduce((n, m) => n + (waste[m.id] ?? 0), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageX aria-hidden className="size-4" /> إلغاء طلب الخدمة
          </DialogTitle>
          <DialogDescription>
            «{title}» — <span dir="ltr" className="font-mono">{orderNumber}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs font-bold">سبب الإلغاء</Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={`rounded-full border px-2.5 py-1 text-2xs font-bold transition-colors ${
                    reason === r ? "border-transparent bg-primary text-primary-foreground" : "hover:bg-muted"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="أو اكتب السبب…"
              className="mt-2"
              maxLength={500}
            />
          </div>

          {hasMaterials ? (
            <div>
              <Label className="text-xs font-bold">مصير الخامة المستهلَكة</Label>
              <p className="mt-1 text-2xs text-muted-foreground">
                افتراضياً يعود كلُّ شيء للمخزون. سجّل التالف فعلاً — يُحمَّل خسارةً ولا يعود صنفاً صالحاً.
              </p>
              <div className="mt-2 overflow-x-auto rounded-md border">
                <table className="w-full text-2xs">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="p-2 text-start font-bold">الخامة</th>
                      <th className="p-2 text-center font-bold">مستهلَك</th>
                      <th className="p-2 text-center font-bold">تالف</th>
                      <th className="p-2 text-center font-bold">يعود للمخزون</th>
                      <th className="p-2 text-end font-bold">قيمة الهدر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {materials.map((m) => {
                      const w = waste[m.id] ?? 0;
                      return (
                        <tr key={m.id} className="border-t">
                          <td className="p-2">{m.name}</td>
                          <td className="p-2 text-center tabular-nums">{m.baseQuantity}</td>
                          <td className="p-2 text-center">
                            <Input
                              type="number"
                              min={0}
                              max={m.baseQuantity}
                              value={String(w)}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(m.baseQuantity, Math.floor(Number(e.target.value) || 0)));
                                setWaste((prev) => ({ ...prev, [m.id]: v }));
                              }}
                              className="mx-auto h-7 w-20 text-center"
                            />
                          </td>
                          <td className="p-2 text-center font-bold tabular-nums">{m.baseQuantity - w}</td>
                          <td className="p-2 text-end tabular-nums" dir="ltr">
                            {w > 0 ? (m.unitCost != null ? fmtAr(String(w * Number(m.unitCost))) : "—") : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {anyWaste && (
                <p className="mt-2 flex items-center gap-1.5 rounded-md bg-[var(--sem-warn-bg)] p-2 text-2xs font-bold text-[var(--sem-warn)]">
                  <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
                  {costVisible ? (
                    <span>
                      يُسجَّل هدرٌ بقيمة <span dir="ltr" className="tabular-nums">{fmtAr(String(wastedValue))}</span> خسارةً على المكتبة — ولا يعود للمخزون.
                    </span>
                  ) : (
                    <span>
                      يُسجَّل إتلافُ <span dir="ltr" className="tabular-nums">{wastedPieces}</span> وحدة خسارةً على المكتبة — ولا تعود للمخزون.
                      قيمتُها لا تظهر لدورك، ويحسبها النظام بكلفة الشراء المختومة.
                    </span>
                  )}
                </p>
              )}
            </div>
          ) : (
            <p className="rounded-md bg-muted/50 p-2 text-2xs text-muted-foreground">
              لم يبدأ التنفيذ — لا خامة مستهلَكة، ولا أثر على المخزون.
            </p>
          )}

          <p className="text-2xs text-muted-foreground">
            العربون المقبوض (إن وُجد) يُردّ بطريقة قبضه، وأمانة أجرة التوصيل تُردّ كذلك.
          </p>

          {/*
            درجُ الردّ — الحقلُ الذي كانت رسالةُ الخادم تطلبه ولا وجودَ له، فيصير أمرٌ بعربونٍ
            نقديّ غيرَ قابلٍ للإلغاء كلّما فُتحت ورديتان. ويظهر خصوصاً في الإلغاء **بعد أيّام**:
            وردية القبض مُغلقةٌ يقيناً، فالنقد يخرج من درج اليوم.
          */}
          {needsCashDrawer && (
            <RefundDrawerPicker
              state={drawer}
              needed
              hint="وردية قبض العربون قد تكون أُغلقت — النقد يخرج من درجٍ مفتوحٍ الآن."
            />
          )}
        </div>

        <DialogFooter>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {/* سببُ التعطيل مقروءٌ دائماً — زرٌّ معطَّلٌ بلا سبب هو نصفُ البابِ المسدود. */}
            {(drawer.blockReason || reason.trim().length < 3) && (
              <span className="text-2xs font-bold text-[var(--sem-warn)] sm:me-auto">
                {reason.trim().length < 3 ? "اكتب سبب الإلغاء (٣ أحرف على الأقل)." : drawer.blockReason}
              </span>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>تراجع</Button>
              <Button
                variant="destructive"
                disabled={pending || reason.trim().length < 3 || drawer.blockReason != null}
                onClick={() =>
                  onConfirm({
                    reason: reason.trim(),
                    // بلا هدرٍ ⇒ لا نُرسل الحقل إطلاقاً: العقد يقرأ غيابه «رجوعٌ كامل» — أقصرُ
                    // حمولةً وأصدقُ نيّةً من إرسال أصفارٍ صريحة.
                    materials: anyWaste
                      ? materials.map((m) => ({
                          workOrderMaterialId: m.id,
                          wasteBase: waste[m.id] ?? 0,
                          returnBase: m.baseQuantity - (waste[m.id] ?? 0),
                        }))
                      : undefined,
                    refundShiftId: drawer.refundShiftId,
                  })
                }
              >
                {pending ? (<><Loader2 aria-hidden className="size-3.5 me-1 animate-spin" /> جارٍ…</>) : "أكّد الإلغاء"}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
