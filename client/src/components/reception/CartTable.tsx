import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Image as ImageIcon,
  Layers,
  Minus,
  Pencil,
  Percent,
  Plus,
  Ruler,
  ShoppingCart,
  Trash2,
  Truck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import {
  buildStockState,
  customLineGrand,
  effectivePrice,
  isCustomKind,
  lineTotal,
  type CartLine,
  type PosRow,
} from "./cartMath";

/**
 * جسم سلّة الاستقبال (الجدول + ذيل المجموع) — نُقل حرفياً من Reception.tsx (تفكيك §١٣ ش١)
 * بصفر تغيير سلوكي. كل الحالة ملك الصفحة؛ الاستدعاءات المباشرة استُبدلت بـprops مقابلة.
 */
export interface CartTableProps {
  branchId: number;
  cart: CartLine[]; selKey: string | null; onSelect: (key: string) => void;
  discountFor: string | null; setDiscountFor: (k: string | null) => void;
  isElevated: boolean;
  /** الصفحة تقرّر مسار الاعتماد (>١٠٪ لغير المرتفع ⇒ حوار المدير). */
  onApplyDiscount: (lineKey: string, pct: number | null) => void;
  changeQty: (key: string, delta: number) => void;
  setQty: (key: string, qty: number) => void;
  removeRow: (key: string) => void;
  onEditCustomization: (row: PosRow, editingKey: string) => void;
  grandTotal: number; cartCount: number;
  /** ٢٣/٨ (Codex P2) — عدّادُ إضافةٍ صريحٌ من الأب يزيد فقط عند `addRow` (لا عند حذف/تعديل كمّية
   *  ولا عند تحميل مسوّدة). يشغّل التمريرَ إلى السطر المُدرَج/المزاد، بلا اعتماد على تغيّر الطول. */
  addTick: number;
}

export function CartTable({
  branchId,
  cart, selKey, onSelect,
  discountFor, setDiscountFor,
  isElevated,
  onApplyDiscount,
  changeQty, setQty, removeRow,
  onEditCustomization,
  grandTotal, cartCount,
  addTick,
}: CartTableProps) {
  // ٢٣/٨ — تمريرٌ تلقائيّ للسطر المُدرَج/المزاد كمّياً (بلاغ المالك «لا يظهر آخر منتجٍ مضاف»):
  // كاشير الاستقبال يضبط `selKey` على السطر الفعّال في `addRow`/المسح؛ يكفي أن يتّبع الجدولُ
  // ذلك المرجع لتُلغى الحاجة للتمرير اليدويّ. `block: nearest` يمنع القفزة إن كان الصفّ ظاهراً.
  //
  // ٢٣/٨ (Codex P2): الاعتماد على `cart.length` كان يعيد تشغيلَ التأثير عند حذف صفٍّ آخر
  // ⇒ يقفز الجدولُ إلى السطر المُحدَّد الآن (ولو كان بعيداً) بغير قصد الكاشير. وإعادةُ مسح
  // نفس السطر المحدَّد لا تُغيّر selKey ولا الطول ⇒ لا تمرير رغم أنّه الحدث الذي يطلبه الكاشير.
  // الحلّ: عدّاد `addTick` صريحٌ من الأب يزيد **فقط** عند فعل الإضافة — يشمل رفع الكمية على السطر
  // ذاته. الحذف/تعديل الكمية/تحميل المسوّدة كلّها لا تحرّكه.
  const selectedRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (!selKey) return;
    const raf = requestAnimationFrame(() => {
      selectedRowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [addTick]);
  const variantIds = Array.from(new Set(cart.filter((line) => !line.custom && !line.row.isService).map((line) => line.row.variantId)));
  const allocationsQ = trpc.reservations.activeAllocations.useQuery(
    { branchId, variantIds },
    { enabled: variantIds.length > 0, staleTime: 15_000 },
  );
  const allocationsByVariant = new Map<number, NonNullable<typeof allocationsQ.data>>();
  for (const allocation of allocationsQ.data ?? []) {
    const list = allocationsByVariant.get(allocation.variantId) ?? [];
    list.push(allocation);
    allocationsByVariant.set(allocation.variantId, list);
  }
  return (
    <>
      <div className="flex-1 overflow-y-auto">
        {cart.length === 0 ? (
          <div className="grid h-full place-items-center px-4 py-10 text-center text-muted-foreground">
            <div>
              <ShoppingCart aria-hidden className="mx-auto size-10 opacity-40" />
              <div className="mt-2 text-sm font-bold">السلة فارغة</div>
              <div className="mt-1 text-xs">امسح الباركود، ابحث عن منتج، أو أضف خدمة/أمر شغل</div>
            </div>
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-muted/50 text-[11px] text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-2 text-center font-bold">#</th>
                <th className="px-2 py-2 text-right font-bold">المنتج</th>
                <th className="w-14 px-1 py-2 text-center font-bold">الوحدة</th>
                <th className="w-24 px-1 py-2 text-center font-bold">السعر</th>
                <th className="w-16 px-1 py-2 text-center font-bold">المخزون</th>
                <th className="w-32 px-1 py-2 text-center font-bold">الكمية</th>
                <th className="w-24 px-1 py-2 text-center font-bold">الإجمالي</th>
                <th className="w-8 px-1 py-2" />
              </tr>
            </thead>
            <tbody>
              {(() => {
                const stockState = buildStockState(cart);
                return cart.map((l, idx) => {
                const isCustom = isCustomKind(l);
                const total = isCustom ? customLineGrand(l) : lineTotal(l);
                const selected = selKey === l.key;
                const stock = stockState(l);
                const allocations = allocationsByVariant.get(l.row.variantId) ?? [];
                return (
                  <tr
                    key={l.key}
                    ref={selected ? selectedRowRef : undefined}
                    onClick={() => onSelect(l.key)}
                    className={cn(
                      "cursor-pointer border-b align-top",
                      isCustom
                        ? "border-s-[3px] border-s-violet-500"
                        : stock.isOut
                          ? "border-s-[3px] border-s-destructive bg-destructive/5"
                          : stock.isShort
                            ? "border-s-[3px] border-s-amber-500 bg-amber-50"
                            : "border-s-[3px] border-s-emerald-500",
                      selected && "bg-primary/5",
                    )}
                  >
                    <td className="px-2 py-2.5 text-center text-xs font-bold text-muted-foreground">{idx + 1}</td>
                    <td className="px-2 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                            isCustom ? "bg-violet-100 text-violet-700" : "bg-emerald-100 text-emerald-700",
                          )}
                        >
                          {isCustom ? "تخصيص" : "جاهز"}
                        </span>
                        <span className="text-lg font-extrabold">
                          {isCustom ? l.custom!.title : l.row.productName}
                        </span>
                        <span className="text-xs text-muted-foreground" dir="ltr">{l.row.sku}</span>
                        {!isCustom && stock.isOut && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-destructive px-2 py-0.5 text-[10px] font-extrabold text-destructive-foreground">
                            نافذ — لا مخزون
                          </span>
                        )}
                        {!isCustom && stock.isShort && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-0.5 text-[10px] font-extrabold text-amber-50">
                            {stock.availInUnit === 0
                              ? "لا يكفي لوحدة"
                              : `المتاح ${stock.availInUnit} فقط`}
                          </span>
                        )}
                      </div>
                      {!isCustom && !l.row.isService && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                          <span>فعلي {fmt(l.row.stockBase ?? 0)}</span>
                          <span className={(l.row.reservedBase ?? 0) > 0 ? "font-bold text-amber-700 dark:text-amber-400" : ""}>
                            محجوز {fmt(l.row.reservedBase ?? 0)}
                          </span>
                          <span className="font-bold">متاح {fmt(l.row.availableBase ?? l.row.stockBase ?? 0)}</span>
                        </div>
                      )}
                      {allocations.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {allocations.map((allocation) => (
                            <span
                              key={allocation.reservationId}
                              className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                            >
                              حجز باسم {allocation.customerName} · {fmt(allocation.remainingBase)} وحدة أساس
                            </span>
                          ))}
                        </div>
                      )}
                      {isCustom && (
                        <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50/50 p-2.5">
                          <div className="flex flex-wrap gap-1.5">
                            {l.custom!.size && (
                              <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">
                                <Ruler aria-hidden className="size-3" /> {l.custom!.size}
                              </span>
                            )}
                            {l.custom!.material && (
                              <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">
                                <Layers aria-hidden className="size-3" /> {l.custom!.material}
                              </span>
                            )}
                            {l.custom!.dueDate && (
                              <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold" dir="ltr">
                                {l.custom!.dueDate}
                              </span>
                            )}
                            {l.custom!.hasDelivery && (
                              <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11px] font-bold">
                                <Truck aria-hidden className="size-3" /> توصيل
                                {Number(l.custom!.deliveryCost) > 0 && (
                                  <span dir="ltr">+{fmt(l.custom!.deliveryCost)}</span>
                                )}
                              </span>
                            )}
                            <span
                              className={cn(
                                "rounded-md border px-2 py-0.5 text-[11px] font-bold",
                                l.custom!.priority === "URGENT" && "bg-destructive/10 text-destructive border-destructive/30",
                                l.custom!.priority === "NORMAL" && "bg-[var(--sem-info)]/10 text-[var(--sem-info)] border-[var(--sem-info)]/30",
                                l.custom!.priority === "LOW" && "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
                              )}
                            >
                              {l.custom!.priority === "URGENT" ? "عاجل" : l.custom!.priority === "NORMAL" ? "عادي" : "منخفض"}
                            </span>
                          </div>
                          {l.custom!.customizationText && (
                            <div className="mt-2 line-clamp-2 inline-flex items-start gap-1 text-[11px] leading-relaxed text-muted-foreground">
                              <FileText aria-hidden className="size-3 mt-0.5 flex-shrink-0" />
                              <span>{l.custom!.customizationText}</span>
                            </div>
                          )}
                          <div className="mt-2 flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-[11px] inline-flex items-center gap-1"
                              onClick={(e) => {
                                e.stopPropagation();
                                onEditCustomization(l.row, l.key);
                              }}
                            >
                              <Pencil aria-hidden className="size-3" /> تعديل التخصيص
                            </Button>
                            <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-[11px] font-bold text-muted-foreground">
                              <ImageIcon aria-hidden className="size-3" /> صور: {l.custom!.designImages.length}
                            </span>
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-1 py-2.5 text-center text-xs text-muted-foreground">{l.row.unitName}</td>
                    <td className="px-1 py-2.5 text-center text-xs tabular-nums" dir="ltr">
                      {/* م٤ (§٨.٤): خلية السعر زرٌّ يفتح خصم الصفّ — لا حقل خصمٍ دائمٍ يُنقَر سهواً.
                          ٢٣/٨: كان الزرّ بلا حدودٍ (border-transparent) فيبدو للكاشير نصّاً غير قابلٍ للنقر
                          — بلاغ المالك «الخصم غير ظاهر». صار له حدٌّ متقطّعٌ خفيف + أيقونةُ % صغيرة يعرف
                          بها الكاشير أنّها بابُ الخصم قبل تجربتها. الحالة النشطة (l.disc) تبقى بحدّ صلبٍ
                          كهرمانيٍّ لتمييز البند المُخصَّم عن غيره. */}
                      {isCustom ? (
                        <span>{fmt(effectivePrice(l))}</span>
                      ) : (
                        <div className="relative inline-block">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setDiscountFor(discountFor === l.key ? null : l.key); }}
                            className={cn(
                              "inline-flex min-h-[32px] items-center gap-1 rounded-md border px-1.5 tabular-nums transition-colors hover:bg-muted",
                              l.disc
                                ? "border-[var(--sem-warn)] bg-[var(--sem-warn-bg)] font-bold text-[var(--sem-warn)]"
                                : "border-dashed border-primary/40 text-foreground hover:border-primary",
                            )}
                            title={l.disc ? "تعديل خصم السطر" : "انقر لإضافة خصم على هذا البند"}
                            aria-label={`سعر السطر ${fmt(effectivePrice(l))} — ${l.disc ? "تعديل خصم" : "أضِف خصماً"}`}
                          >
                            <span>{fmt(effectivePrice(l))}</span>
                            {l.disc ? (
                              <span className="text-[10px] font-bold text-[var(--sem-warn)]">−{l.disc}%</span>
                            ) : (
                              <Percent aria-hidden className="size-2.5 text-primary/70" strokeWidth={2.5} />
                            )}
                          </button>
                          {discountFor === l.key && (
                            <LineDiscountPopover
                              line={l}
                              isElevated={isElevated}
                              onApply={(pct) => {
                                onApplyDiscount(l.key, pct);
                                setDiscountFor(null);
                              }}
                              onClose={() => setDiscountFor(null)}
                            />
                          )}
                        </div>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-1 py-2.5 text-center text-xs font-bold tabular-nums",
                        isCustom ? "text-muted-foreground" : stock.isOut ? "text-destructive" : stock.isShort ? "text-amber-600" : "text-muted-foreground",
                      )}
                      dir="ltr"
                    >
                      {isCustom ? "—" : l.row.isService ? "∞" : stock.availInUnit}
                    </td>
                    <td className="px-1 py-1.5">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            changeQty(l.key, -1);
                          }}
                          className="grid size-8 place-items-center rounded-md border bg-card hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                          disabled={isCustom && l.qty <= 1}
                          title={isCustom && l.qty <= 1 ? "لا يُمكن تقليل كمية منتج مخصَّص دون ١ — احذف السطر بدلاً من ذلك" : "تقليل الكمية"}
                          aria-label="تقليل الكمية"
                        >
                          <Minus aria-hidden className="size-3.5" />
                        </button>
                        {/* م٤: الكمية مُدخلٌ مباشر داخل الصفّ (لوحة الأرقام لم تعد تعدّلها). */}
                        <input
                          value={l.qty}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
                            if (Number.isFinite(n)) setQty(l.key, n);
                            else if (e.target.value === "") setQty(l.key, 1);
                          }}
                          inputMode="numeric"
                          dir="ltr"
                          aria-label={`كمية ${isCustom ? l.custom!.title : l.row.productName}`}
                          className="h-8 w-12 rounded-md border bg-card text-center text-sm font-extrabold tabular-nums outline-none focus:border-primary"
                        />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            changeQty(l.key, +1);
                          }}
                          className="grid size-8 place-items-center rounded-md border bg-card hover:bg-muted"
                          aria-label="زيادة الكمية"
                        >
                          <Plus aria-hidden className="size-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-1 py-2.5 text-center text-sm font-extrabold tabular-nums" dir="ltr">{fmt(total)}</td>
                    <td className="px-1 py-2.5 text-center">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeRow(l.key);
                        }}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label="حذف المنتج"
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </button>
                    </td>
                  </tr>
                );
              });
              })()}
            </tbody>
          </table>
        )}
      </div>

      {cart.length > 0 && (
        <div className="flex flex-shrink-0 items-center justify-between border-t bg-muted/40 px-4 py-2.5">
          <span className="text-xs text-muted-foreground">{cart.length} منتج · {cartCount} قطعة</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs text-muted-foreground">المجموع:</span>
            <span className="text-2xl font-black tabular-nums" dir="ltr">{fmt(grandTotal)}</span>
            <span className="text-xs text-muted-foreground">د.ع</span>
          </div>
        </div>
      )}
    </>
  );
}

/** م٤ (§٨.٤) — خصم الصفّ: رقائق تقف عند ١٠٪ (م٦)، ونسبة حرّة فوقها تستدعي اعتماد المدير. */
function LineDiscountPopover({ line, isElevated, onApply, onClose }: {
  line: CartLine;
  isElevated: boolean;
  onApply: (pct: number | null) => void;
  onClose: () => void;
}) {
  const [freePct, setFreePct] = useState(line.disc != null ? String(line.disc) : "");
  const base = line.origPrice ?? Number(line.row.price ?? 0);
  const pctNum = Math.min(100, Math.max(0, parseFloat(freePct) || 0));
  const preview = base * (1 - pctNum / 100);
  return (
    <div
      className="absolute start-1/2 top-[calc(100%+4px)] z-40 w-60 -translate-x-1/2 rounded-xl border bg-card p-2.5 text-start shadow-2xl"
      dir="rtl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-[11px] font-extrabold"><Percent aria-hidden className="size-3" /> خصم الصفّ</span>
        <button type="button" onClick={onClose} aria-label="إغلاق" className="text-muted-foreground hover:text-foreground"><X aria-hidden className="size-3.5" /></button>
      </div>
      <div className="mb-1.5 flex gap-1.5">
        {[5, 10].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onApply(p)}
            className="min-h-[36px] flex-1 rounded-lg border bg-card text-xs font-extrabold tabular-nums hover:bg-muted"
          >
            {p}٪
          </button>
        ))}
        <button
          type="button"
          onClick={() => onApply(null)}
          disabled={line.disc == null}
          className="min-h-[36px] flex-1 rounded-lg border bg-card text-[11px] font-bold text-muted-foreground hover:bg-muted disabled:opacity-40"
        >
          إزالة
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={freePct}
          onChange={(e) => setFreePct(e.target.value.replace(/[^\d.]/g, ""))}
          inputMode="decimal"
          dir="ltr"
          placeholder="نسبة حرّة"
          aria-label="نسبة خصم حرّة"
          className="h-9 w-full rounded-md border bg-card px-2 text-center text-sm font-bold tabular-nums outline-none focus:border-primary"
        />
        <Button size="sm" className="h-9" disabled={pctNum <= 0} onClick={() => onApply(pctNum)}>تطبيق</Button>
      </div>
      {pctNum > 0 && (
        <div className="mt-1.5 rounded-md bg-muted/50 px-2 py-1 text-[11px] tabular-nums" dir="ltr">
          {fmt(base)} ← <span className="font-extrabold">{fmt(preview)}</span>
          <span className="ms-1 text-money-positive">وفّر {fmt(base - preview)}</span>
        </div>
      )}
      {pctNum > 10 && !isElevated && (
        <p className="mt-1.5 text-[10px] font-bold text-[var(--sem-warn)]">فوق ١٠٪ — سيُطلَب اعتماد المدير.</p>
      )}
    </div>
  );
}
