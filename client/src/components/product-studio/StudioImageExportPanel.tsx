/**
 * لوحةُ تصدير صور الاستوديو **المنشورة** — تُظهَر للمدير فقط.
 *
 * الحاجة (المالك ٢٥/٨): تحميل صور المنتجات المعدَّلة والمرتَّبة (المنشورة) محلياً
 * لاستعمالها في السوشيال ميديا وأماكن أخرى. النطاقات ثلاثة: كل الكتالوج، فئة بعينها
 * (بشجرتها الفرعية)، أو منتجات محدَّدة. كل صورةٍ باسم المنتج (وبديله عند وجوده).
 *
 * التنفيذ: نداءٌ GET إلى `/api/studio/export.zip` مع النطاق كـquery params. المتصفح
 * ينزّل الملف كأيّ رابط تنزيل. لا داعي لـfetch يدويّ + blob — نموذجٌ خفيّ مع submit
 * يترك المتصفحَ يتعامل مع الاستجابة الكبيرة بلا تحميلها في ذاكرة JS.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { Download, Image as ImageIcon } from "lucide-react";
import { useMemo, useState } from "react";

type ExportScope = "ALL" | "CATEGORY" | "PRODUCTS";

interface CategoryOption {
  id: number;
  name: string;
}

export function StudioImageExportPanel({ categories }: { categories: CategoryOption[] }) {
  const [scope, setScope] = useState<ExportScope>("ALL");
  const [categoryId, setCategoryId] = useState("");
  const [productIdsInput, setProductIdsInput] = useState("");

  const parsedProductIds = useMemo(() => {
    return productIdsInput
      .split(/[\s,،]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
  }, [productIdsInput]);

  const downloadUrl = useMemo(() => {
    if (scope === "ALL") return "/api/studio/export.zip?scope=ALL";
    if (scope === "CATEGORY") return categoryId ? `/api/studio/export.zip?scope=CATEGORY&categoryId=${encodeURIComponent(categoryId)}` : null;
    if (scope === "PRODUCTS") return parsedProductIds.length > 0 ? `/api/studio/export.zip?scope=PRODUCTS&productIds=${parsedProductIds.join(",")}` : null;
    return null;
  }, [scope, categoryId, parsedProductIds]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <ImageIcon aria-hidden className="size-4" /> تصدير الصور المنشورة
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          يجمع الصور المعتمدة (المعدَّلة والمرتَّبة) في ملف ZIP لتنزيلها محلياً. المصدر: الصور المنشورة فقط، لا الأصل غير المُعدَّل. كل صورةٍ باسم المنتج (وبديله عند وجوده). المنتجات الخدميّة مستبعَدةٌ تلقائياً. سقف كل عمليّة: ٢٠٠٠ صورة.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="studio-export-scope">النطاق</Label>
            <AppSelect id="studio-export-scope" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={scope} onValueChange={(v) => setScope(v as ExportScope)}>
              <option value="ALL">كل الكتالوج</option>
              <option value="CATEGORY">فئة (بشجرتها الفرعية)</option>
              <option value="PRODUCTS">منتجات محدَّدة</option>
            </AppSelect>
          </div>
          {scope === "CATEGORY" && (
            <div className="space-y-1.5">
              <Label htmlFor="studio-export-category">الفئة</Label>
              <AppSelect id="studio-export-category" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:h-9" value={categoryId} onValueChange={setCategoryId}>
                <option value="">اختر فئة</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </AppSelect>
            </div>
          )}
          {scope === "PRODUCTS" && (
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="studio-export-products">معرّفات المنتجات (مفصولة بفواصل أو مسافات)</Label>
              <Input
                id="studio-export-products"
                value={productIdsInput}
                onChange={(e) => setProductIdsInput(e.target.value)}
                placeholder="مثال: 12, 34, 56"
                dir="ltr"
              />
              <p className="text-xs text-muted-foreground">
                {parsedProductIds.length > 0 ? `${parsedProductIds.length} منتجاً مُختاراً` : "لا منتجات مُختارة بعد"}
                {parsedProductIds.length > 500 ? " · تجاوزَ حدّ ٥٠٠ لكل نداء" : ""}
              </p>
            </div>
          )}
        </div>
        <div>
          {/* قيدُ ٥٠٠ لنطاق PRODUCTS فقط — تبديلُ النطاق يترك حقلَ المنتجات معبَّأً،
              فتقييدُ الأزرار كلّها به يُبقيها معطَّلةً بلا سببٍ فعّال (الجذر: مراجعة
              Codex P2 على PR #811). */}
          <Button asChild className="min-h-11" disabled={!downloadUrl || (scope === "PRODUCTS" && parsedProductIds.length > 500)}>
            {downloadUrl && (scope !== "PRODUCTS" || parsedProductIds.length <= 500) ? (
              // <a download> يُخبِر المتصفح بفتح مربّع حفظ (بدل عرض الاستجابة). الخادم يُرسل
              // Content-Disposition attachment كذلك كإحتياط. الفتحُ في نافذةٍ جديدة يمنع
              // خسارة حالة الاستوديو إن ألغى المستخدمُ التنزيل.
              <a href={downloadUrl} download rel="noopener noreferrer">
                <Download aria-hidden className="size-4" /> نزّل الأرشيف
              </a>
            ) : (
              <span>
                <Download aria-hidden className="size-4" /> نزّل الأرشيف
              </span>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
