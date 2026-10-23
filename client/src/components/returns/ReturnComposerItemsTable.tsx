/**
 * ReturnComposer — **المكوّن المرجعيّ الوحيد للمرتجع** (بلاغ المالك ١٧/٨/٢٦).
 *
 * لماذا وُحِّد: كان للمرتجع شاشتان بمنطقين مختلفين (`/returns` نموذجٌ مديريّ،
 * و`/sales-returns/new` محرّرٌ كامل)، وكلتاهما تحسب سقوف الاسترداد **محلياً** بمنطقٍ يخالف
 * الخادم ⇒ يملأ الموظف كل شيء ثمّ يُرفض الطلب برسالة سقفٍ غامضة. والمرتجع عمليةٌ يوميّةٌ
 * متكرّرة (نصّ المالك: «الزبائن مزاجهم متقلّب ويطلبون مرتجع كثيراً») فوجب أن تكون بمألوفيّة
 * شاشة البيع وأن تكون **غير قابلة للخطأ بالبناء**.
 *
 * مبدأ التصميم الحاكم هنا: **لا خيار على الشاشة إلّا وقد أذِن به الخادم**.
 * السقوف تأتي من `returns.getInvoice` (المحسوبة بنفس دالّة `loadRefundCaps` التي ستحكم على
 * الطلب)، **والروافدُ والأدراجُ من المنتقي الموحَّد `<RefundRailPicker>`** (م٢ ق١٠) الذي يستفتي
 * `refundRails.preflight` بالمبلغ المطلوب ⇒ ما تعراه الشاشة = ما يقبله الخادم بالتعريف.
 * لا تُعِد حساب سقفٍ هنا ولا تُضِف رافداً بنصٍّ ثابت — تلك بالضبط العلّة التي أُصلحت.
 *
 * قرارات المالك المُجسَّدة (١٧/٨/٢٦):
 *  · رافدا الردّ **نقدٌ أو بطاقة فقط** مهما كان رافد القبض (بطاقة/نقد/تحويل/رصيد زين).
 *  · النقد يخرج من **وردية المنفّذ المفتوحة** افتراضاً، أو يختار وردية مفتوحة أخرى صراحةً؛
 *    وبلا وردية مفتوحة يخرج من **الخزينة** للإداريّ (استثناءٌ مصنَّف خادمياً — الخادم يعلنه رافداً).
 *  · الردّ بالبطاقة يُنفَّذ على الجهاز ثمّ يُوثَّق بمرجعه (إثباتٌ لا إقفال).
 */
import { Zap } from "lucide-react";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { fmt } from "@/lib/money";
import type { ReturnComposerModel } from "./useReturnComposer";
import { returnQuantityLabel } from "./returnComposerTypes";

type Props = Pick<
  ReturnComposerModel,
  | "qty"
  | "fastBarcode"
  | "setFastBarcode"
  | "items"
  | "selectedLines"
  | "qtyLocked"
  | "isLocked"
  | "approve"
  | "create"
  | "setQtyClamped"
  | "fillAll"
  | "handleFastItemScan"
  | "triggerExpressReturn"
>;
export function ReturnComposerItemsTable({
  qty,
  fastBarcode,
  setFastBarcode,
  items,
  selectedLines,
  qtyLocked,
  isLocked,
  approve,
  create,
  setQtyClamped,
  fillAll,
  handleFastItemScan,
  triggerExpressReturn,
}: Props) {
  return (
    <Card>
      <CardHeader className="p-3 pb-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">بنود الإرجاع</CardTitle>
          <Badge variant="secondary" className="text-xs font-mono">
            {selectedLines.length} من {items.length} صنف
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* مسح باركود الصنف السريع */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleFastItemScan();
            }}
            className="flex items-center gap-1.5"
          >
            <UnifiedSearchInput
              value={fastBarcode}
              onChange={setFastBarcode}
              onScan={(code) => handleFastItemScan(code)}
              debounceMs={0}
              size="compact"
              placeholder="امسح باركود صنف..."
              className="w-48"
              inputClassName="font-mono text-xs"
              disabled={isLocked || qtyLocked}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="h-8 px-2.5 text-xs"
              disabled={isLocked || qtyLocked || !fastBarcode.trim()}
            >
              إضافة
            </Button>
          </form>

          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs font-semibold"
            onClick={fillAll}
            disabled={isLocked || items.every((it) => it.remaining <= 0)}
          >
            تحديد الكل
          </Button>

          <Button
            size="sm"
            variant="default"
            className="h-8 gap-1 text-xs font-bold bg-primary hover:bg-primary/90 text-primary-foreground"
            onClick={triggerExpressReturn}
            disabled={
              isLocked ||
              items.every((it) => it.remaining <= 0) ||
              create.isPending ||
              approve.isPending
            }
          >
            <Zap className="size-3.5" aria-hidden />
            <span>إرجاع فوري لكامل الفاتورة</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2 text-start">المنتج</th>
                <th className="p-2 text-center">المُباع</th>
                <th className="p-2 text-center">أُرجع سابقاً</th>
                <th className="p-2 text-right">السعر</th>
                <th className="w-56 p-2 text-center">يرجع الآن</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const v = qty[it.invoiceItemId] ?? 0;
                const step = it.conversionFactor > 1 ? it.conversionFactor : 1;
                return (
                  <tr
                    key={it.invoiceItemId}
                    className={`border-t ${v > 0 ? "bg-[var(--sem-info-bg)]/40" : ""}`}
                  >
                    <td className="p-2">
                      <div className="font-semibold">
                        {it.productName}
                        {it.variantLabel ? ` — ${it.variantLabel}` : ""}
                      </div>
                      {it.isBundle && (
                        <div className="text-[11px] font-medium text-primary">
                          يُرجع كبكج كامل؛ وعند إعادته للمخزون يعيد النظام
                          مكوّناته تلقائياً
                        </div>
                      )}
                      {it.conversionFactor > 1 && (
                        <div className="text-[11px] text-muted-foreground">
                          ١ {it.unitName} = {it.conversionFactor}{" "}
                          {it.baseUnitName}
                        </div>
                      )}
                    </td>
                    <td className="p-2 text-center">
                      {returnQuantityLabel(
                        it.baseQuantity,
                        it.conversionFactor,
                        it.unitName,
                        it.baseUnitName,
                      )}
                    </td>
                    <td className="p-2 text-center">
                      {it.returnedBaseQuantity > 0
                        ? returnQuantityLabel(
                            it.returnedBaseQuantity,
                            it.conversionFactor,
                            it.unitName,
                            it.baseUnitName,
                          )
                        : "—"}
                    </td>
                    <td className="p-2 text-right tabular-nums" dir="ltr">
                      {fmt(it.unitPrice)}
                    </td>
                    <td className="p-2">
                      {it.remaining <= 0 ? (
                        <div className="text-center text-xs text-muted-foreground">
                          أُرجع بالكامل
                        </div>
                      ) : (
                        <div
                          className="flex items-center justify-center gap-1"
                          dir="ltr"
                        >
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 w-8 p-0 font-black"
                            aria-label="أنقص كمية الإرجاع"
                            disabled={isLocked || qtyLocked || v <= 0}
                            onClick={() =>
                              setQtyClamped(
                                it.invoiceItemId,
                                v - step,
                                it.remaining,
                              )
                            }
                          >
                            −
                          </Button>
                          <Input
                            dir="ltr"
                            inputMode="numeric"
                            className="h-8 w-16 text-center font-bold tabular-nums"
                            value={v > 0 ? String(v) : ""}
                            placeholder="0"
                            disabled={isLocked || qtyLocked}
                            aria-label={`كمية إرجاع ${it.productName} بوحدة ${it.unitName}`}
                            onChange={(e) => {
                              const raw = e.target.value.replace(/[^\d]/g, "");
                              setQtyClamped(
                                it.invoiceItemId,
                                raw ? parseInt(raw, 10) : 0,
                                it.remaining,
                              );
                            }}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 w-8 p-0 font-black"
                            aria-label="زد كمية الإرجاع"
                            disabled={
                              isLocked || qtyLocked || v >= it.remaining
                            }
                            onClick={() =>
                              setQtyClamped(
                                it.invoiceItemId,
                                v + step,
                                it.remaining,
                              )
                            }
                          >
                            +
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2 text-[11px] font-bold"
                            disabled={
                              isLocked || qtyLocked || v >= it.remaining
                            }
                            onClick={() =>
                              setQtyClamped(
                                it.invoiceItemId,
                                it.remaining,
                                it.remaining,
                              )
                            }
                          >
                            الكل
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
