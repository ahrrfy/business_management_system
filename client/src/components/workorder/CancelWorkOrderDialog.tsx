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
import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, PackageX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtAr } from "@/lib/money";

export interface CancelMaterialRow {
  id: number;
  name: string;
  baseQuantity: number;
  unitCost: string | null;
}

export interface CancelDecision {
  reason: string;
  materials: Array<{ workOrderMaterialId: number; returnBase: number; wasteBase: number }> | undefined;
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
  orderNumber,
  title,
  /** أسطر الخامة المستهلَكة — فارغةٌ إن لم يبدأ التنفيذ (فلا جدولَ ولا هدر). */
  materials,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orderNumber: string;
  title: string;
  materials: CancelMaterialRow[];
  pending?: boolean;
  onConfirm: (d: CancelDecision) => void;
}) {
  const [reason, setReason] = useState("");
  const [waste, setWaste] = useState<Record<number, number>>({});

  const hasMaterials = materials.length > 0;
  const wastedValue = useMemo(
    () => materials.reduce((sum, m) => sum + (waste[m.id] ?? 0) * Number(m.unitCost ?? 0), 0),
    [materials, waste],
  );
  const anyWaste = materials.some((m) => (waste[m.id] ?? 0) > 0);

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
                            {w > 0 ? fmtAr(String(w * Number(m.unitCost ?? 0))) : "—"}
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
                  يُسجَّل هدرٌ بقيمة <span dir="ltr" className="tabular-nums">{fmtAr(String(wastedValue))}</span> خسارةً على المكتبة — ولا يعود للمخزون.
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
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>تراجع</Button>
          <Button
            variant="destructive"
            disabled={pending || reason.trim().length < 3}
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
              })
            }
          >
            {pending ? (<><Loader2 aria-hidden className="size-3.5 me-1 animate-spin" /> جارٍ…</>) : "أكّد الإلغاء"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
