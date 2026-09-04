/**
 * لوحةُ إدارة صور منتجٍ مباشرةً — بلا الحاجة إلى مهمّةٍ نشطة في قائمة الاستوديو.
 *
 * الحاجة (مراجعة Codex P2، PR #825): معرض `ProductImageGallery` كان يُركَّب فقط داخل
 * تفاصيل مهمّةٍ مُختارة. مديرٌ يريد إدارة صور منتجٍ إرثيّ (لا مهمّة له) كان مضطراً
 * لإنشاء مهمّةٍ مصطنعة أوّلاً — احتكاكٌ بلا سبب.
 *
 * الحلّ: بحثٌ سريع بالباركود أو الاسم عبر `productStudio.resolveBarcode`/`products`
 * ثم إظهار المعرض داخل نفس البطاقة. المدير يفتح، يُدير، يُغلق، ثمّ يمرّ إلى منتج آخر.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { Image as ImageIcon, ScanLine } from "lucide-react";
import { useState } from "react";
import { ProductImageGallery } from "./ProductImageGallery";

export function StudioStandaloneImageManagerCard() {
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const [productId, setProductId] = useState<number | null>(null);
  const [productName, setProductName] = useState<string | null>(null);
  const [isLooking, setIsLooking] = useState(false);

  async function openByQuery(raw = query) {
    // تقليم الحافتين فقط؛ المسافة الداخلية جزءٌ من هوية Code39 (مثل `1  0095`).
    const clean = raw.trim();
    if (!clean) return;
    setIsLooking(true);
    try {
      // نجرّب أوّلاً حلَّ الباركود عبر مسار الاستوديو. لا نحوّل رقماً مجهولاً صامتاً
      // إلى productId: الباركود 000123 كان يفتح المنتج #123 عند فشل الشبكة أو عدم الربط.
      try {
        const resolved = await utils.productStudio.resolveBarcode.fetch({ barcode: clean });
        setProductId(Number(resolved.productId));
        setProductName(resolved.productName);
        return;
      } catch (barcodeError) {
        const explicitId = /^#([1-9]\d*)$/.exec(clean);
        if (explicitId) {
          const asNumber = Number(explicitId[1]);
          if (Number.isSafeInteger(asNumber)) {
            setProductId(asNumber);
            setProductName(`المنتج #${asNumber}`);
            return;
          }
        }
        notify.err(barcodeError);
      }
    } finally {
      setIsLooking(false);
    }
  }
  const barcodeInput = useBarcodeInput((barcode) => {
    setQuery(barcode);
    void openByQuery(barcode);
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <ImageIcon aria-hidden className="size-4" /> إدارة صور منتجٍ مباشرةً — بلا مهمّة
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          امسح باركود المنتج، أو اكتب معرّفه مسبوقاً بـ#، ليُفتح معرضُ صوره — لحذف، ترتيب، أو تعيين رئيسيّة. لا حاجة لإنشاء مهمّةٍ في قائمة الاستوديو.
        </p>
        {productId == null ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label htmlFor="studio-standalone-lookup">باركود أو معرّف المنتج بصيغة #123</Label>
              <div className="relative">
                <Input
                  id="studio-standalone-lookup"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="امسح الباركود أو اكتب # ثم المعرّف"
                  className={barcodeSearchInputClass}
                  onKeyDown={(e) => {
                    barcodeInput.handleKeyDown(e, setQuery);
                    if (e.defaultPrevented) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void openByQuery();
                    }
                  }}
                />
                <BarcodeSearchCue />
              </div>
            </div>
            <Button type="button" className="min-h-11" disabled={isLooking || !query.trim()} onClick={() => void openByQuery()}>
              <ScanLine aria-hidden className="size-4" /> افتح المعرض
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
              <span className="font-medium">{productName ?? `المنتج #${productId}`}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setProductId(null);
                  setProductName(null);
                  setQuery("");
                }}
              >
                افتح منتجاً آخر
              </Button>
            </div>
            <ProductImageGallery productId={productId} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
