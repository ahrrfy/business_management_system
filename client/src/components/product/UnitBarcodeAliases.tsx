import { useState } from "react";
import { AlertCircle, Barcode, Plus, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * إدارة الباركودات البديلة (aliases) لوحدة منتج — نفس السلعة/التكلفة/السعر/المخزون بعدّة باركودات.
 * قارئ الباركود يمسح أياً منها ⇒ يجد نفس المنتج.
 *
 * الاستعمال: زرّ صغير بجوار حقل الباركود الأساسيّ. يعرض عداد البدائل، ويفتح Dialog للإضافة/الحذف.
 * لا يعمل إن `productUnitId` غير موجود (منتج جديد لم يُحفظ بعد) — الزرّ يظهر معطَّلاً برمز توضيحيّ.
 */
/** بديل باركود في وضع محلّي (قبل حفظ المنتج) — لا يعبر tRPC، يعيش في state الأمّ. */
export type LocalAlias = { barcode: string; note?: string | null };

export interface UnitBarcodeAliasesProps {
  /** إمّا `productUnitId` مباشرةً، أو (`variantId` + `unitName`) لنَحلّها ذاتياً — أيّهما توفّر. */
  productUnitId?: number | null;
  variantId?: number | null;
  unitName: string;
  variantLabel?: string;
  /** نبطّل الزرّ لغير المدير — إدارة الباركودات مقصورة على `productsManagerProcedure`. */
  disabled?: boolean;
  /** **وضع محلّي (create)**: إن مُرِّرتا، لا استدعاءات tRPC — كل تعديل يكتب في state الأمّ.
   *  الحفظ النهائي مع المنتج يُدرج البدائل ذرّياً عبر `createProduct`. */
  localAliases?: LocalAlias[];
  onLocalChange?: (next: LocalAlias[]) => void;
}

export function UnitBarcodeAliases({ productUnitId: unitIdProp, variantId, unitName, variantLabel, disabled, localAliases, onLocalChange }: UnitBarcodeAliasesProps) {
  const isLocal = !!onLocalChange;
  const [open, setOpen] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newNote, setNewNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const _utils = trpc.useUtils();
  void _utils;

  // حلّ (variantId + unitName) إلى productUnitId إذا لم يُمرَّر مباشرةً — للوضع الخادميّ فقط.
  const shouldResolve = !isLocal && !unitIdProp && !!variantId;
  const resolveQ = trpc.catalog.resolveProductUnitId.useQuery(
    { variantId: Number(variantId), unitName },
    { enabled: shouldResolve, staleTime: 30_000 },
  );
  const productUnitId = unitIdProp ?? resolveQ.data ?? null;

  const enabled = !isLocal && !!productUnitId && open;
  const listQ = trpc.catalog.listUnitBarcodes.useQuery(
    { productUnitId: Number(productUnitId) },
    { enabled, staleTime: 5_000 },
  );

  // العدد للشارة على الزرّ — يعمل بمجرّد توفّر productUnitId (خادميّ) أو من المصفوفة المحلّية.
  const countQ = trpc.catalog.listUnitBarcodes.useQuery(
    { productUnitId: Number(productUnitId) },
    { enabled: !isLocal && !!productUnitId, staleTime: 30_000 },
  );
  const aliasCount = isLocal ? (localAliases?.length ?? 0) : (countQ.data?.aliases.length ?? 0);

  const addMut = trpc.catalog.addUnitBarcodeAlias.useMutation({
    onSuccess: async () => {
      setNewCode("");
      setNewNote("");
      setError(null);
      await Promise.all([listQ.refetch(), countQ.refetch()]);
    },
    onError: (e) => setError(e.message),
  });

  const removeMut = trpc.catalog.removeUnitBarcodeAlias.useMutation({
    onSuccess: async () => {
      await Promise.all([listQ.refetch(), countQ.refetch()]);
    },
    onError: (e) => setError(e.message),
  });

  function submitAdd() {
    const code = newCode.trim();
    if (!code) {
      setError("أدخل الباركود.");
      return;
    }
    if (isLocal) {
      // فحص تكرار محلّي (بلا حاجة لتحقّق خادميّ حتى الحفظ).
      const dup = (localAliases ?? []).some((a) => a.barcode === code);
      if (dup) {
        setError(`الباركود ${code} مضاف مسبقاً في هذه الوحدة.`);
        return;
      }
      onLocalChange!([...(localAliases ?? []), { barcode: code, note: newNote.trim() || null }]);
      setNewCode("");
      setNewNote("");
      setError(null);
      return;
    }
    if (!productUnitId) return;
    addMut.mutate({
      productUnitId: Number(productUnitId),
      barcode: code,
      note: newNote.trim() || null,
    });
  }

  function removeLocalAt(idx: number) {
    if (!isLocal) return;
    const next = (localAliases ?? []).filter((_, i) => i !== idx);
    onLocalChange!(next);
  }

  const busy = addMut.isPending || removeMut.isPending;

  // في وضع local لا نحتاج productUnitId — نُظهر الزرّ فوراً.
  if (!isLocal && !productUnitId) {
    // منتج جديد لم يُحفظ بعد — تعليمة توضيحية (لا يظهر عادةً لأن الوضع المحلّي يُغطّي هذا).
    return (
      <button
        type="button"
        disabled
        title="احفظ المنتج أوّلاً لإضافة باركودات بديلة"
        className="inline-flex items-center gap-1 rounded border border-dashed border-muted-foreground/30 px-2 py-1 text-[10px] text-muted-foreground/60 cursor-not-allowed"
      >
        <Plus aria-hidden className="size-3" />
        بديل (بعد الحفظ)
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title="إدارة الباركودات البديلة — نفس السلعة، عدّة باركودات"
        className={cn(
          "inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors",
          disabled
            ? "border-muted-foreground/30 text-muted-foreground/50 cursor-not-allowed"
            : aliasCount > 0
              ? "border-primary/50 bg-primary/5 text-primary hover:bg-primary/10"
              : "border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}
      >
        <Tag aria-hidden className="size-3" />
        بدائل
        {aliasCount > 0 && (
          <span className="rounded-full bg-primary/15 px-1.5 text-[9px] font-bold tabular-nums">
            {aliasCount}
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Barcode aria-hidden className="size-4" />
              باركودات بديلة — {unitName}
              {variantLabel ? <span className="text-xs text-muted-foreground">({variantLabel})</span> : null}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              نفس السلعة والتكلفة والسعر والمخزون — بأيّ من هذه الباركودات يُتعرَّف عليها عند البيع/الاستلام.
            </p>
          </DialogHeader>

          <div className="space-y-3">
            {isLocal && (
              <div className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs">
                هذه البدائل ستُحفظ ذرّياً مع المنتج عند الضغط على «حفظ». لا تعبر الشبكة قبلها.
              </div>
            )}

            {/* الأساسيّ للمرجعية — يظهر فقط في الوضع الخادميّ (المنتج القائم). */}
            {!isLocal && (
              <div className="rounded-md border bg-muted/30 p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">الباركود الأساسيّ:</span>
                  <span className="font-mono tabular-nums" dir="ltr">
                    {listQ.data?.primary || <span className="text-muted-foreground italic">— بلا باركود —</span>}
                  </span>
                </div>
              </div>
            )}

            {/* قائمة البدائل */}
            <div className="max-h-56 overflow-auto rounded-md border">
              {(isLocal ? false : listQ.isLoading) ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">جارٍ التحميل…</div>
              ) : aliasCount === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  لا باركودات بديلة بعد — أضف واحداً أدناه.
                </div>
              ) : isLocal ? (
                <ul>
                  {(localAliases ?? []).map((a, idx) => (
                    <li key={`local-${idx}-${a.barcode}`} className="flex items-center justify-between gap-2 border-b last:border-b-0 px-3 py-2 text-sm">
                      <div className="flex items-center gap-2 truncate">
                        <span className="font-mono tabular-nums" dir="ltr">{a.barcode}</span>
                        {a.note ? <span className="text-xs text-muted-foreground truncate">— {a.note}</span> : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        onClick={() => removeLocalAt(idx)}
                        aria-label={`حذف الباركود ${a.barcode}`}
                        title="حذف"
                      >
                        <X className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul>
                  {(listQ.data?.aliases ?? []).map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2 border-b last:border-b-0 px-3 py-2 text-sm">
                      <div className="flex items-center gap-2 truncate">
                        <span className="font-mono tabular-nums" dir="ltr">{a.barcode}</span>
                        {a.note ? <span className="text-xs text-muted-foreground truncate">— {a.note}</span> : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        disabled={busy}
                        onClick={() => removeMut.mutate({ id: a.id })}
                        aria-label={`حذف الباركود ${a.barcode}`}
                        title="حذف"
                      >
                        <X className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* إضافة جديد */}
            <div className="rounded-md border bg-muted/20 p-3 space-y-2">
              <div className="text-xs font-medium">إضافة باركود بديل</div>
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
                <Input
                  value={newCode}
                  // نقبل EAN/UPC (أرقام فقط) و Code128 (أرقام + حروف + رموز) حتى ٦٤ خانة — نطاق varchar(64) في DB.
                  onChange={(e) => setNewCode(e.target.value.slice(0, 64))}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    if (e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    submitAdd();
                  }}
                  placeholder="الباركود (أرقام أو أرقام+حروف)…"
                  dir="ltr"
                  className="font-mono"
                  aria-label="باركود بديل جديد"
                />
                <Input
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="ملاحظة (اختياري) — «شكل ٢»، «دفعة استيراد ٢»…"
                  dir="auto"
                  aria-label="ملاحظة"
                />
                <Button
                  type="button"
                  onClick={submitAdd}
                  disabled={busy || !newCode.trim()}
                  className="whitespace-nowrap"
                >
                  <Plus aria-hidden className="size-4 me-1" />
                  إضافة
                </Button>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                aria-live="assertive"
                className="rounded-md border border-red-500/40 bg-red-50 dark:bg-red-950/40 p-2 text-xs flex items-start gap-2"
              >
                <AlertCircle className="size-3.5 mt-0.5 shrink-0 text-red-600" />
                <div>{error}</div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
