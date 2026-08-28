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
import { notify } from "@/lib/notify";
import { Download, Image as ImageIcon, Loader2 } from "lucide-react";
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
  const [downloading, setDownloading] = useState(false);

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

  const canDownload = !!downloadUrl && !(scope === "PRODUCTS" && parsedProductIds.length > 500);

  // بلاغ المالك (٢٨/٨): «تنزيل صور الكتالوج يطلب مني كلمة المرور واسم المستخدم…».
  // الجذر: الملاحةُ المباشرة بـ`<a href download>` حين تنقص جلسةُ الكوكي، الخادمُ يعود بـ401
  // ومتصفّح iOS/Safari يعرض حوار «تسجيل الدخول» الخاصّ به.
  //
  // ⚠️ حلٌّ سابقٌ (`fetch` + `Blob`) كان يُصلح حوار المصادقة لكنّه **يبتلع الأرشيف كلَّه في
  // ذاكرة JS** قبل أن يبدأ التنزيلُ فعلياً: صادرةُ «كل الكتالوج» تصل ٢٠٠٠ صورة × ٩٠٠ ك.ب =
  // ‎~1.8 ج.ب، فيتفجّر Safari على iPhone بذاكرةٍ محدودة (مراجعة Codex P1). الحلّ الجديد
  // على مرحلتين: **استعلامٌ مسبق** (`?preflight=1`) خفيف يتحقّق من صلاحية الجلسة والنطاق
  // بلا بثِّ بايتٍ واحد، ثمّ **ملاحةٌ برمجية** (`location.assign`) تُطلق تنزيلَ المتصفّح
  // الأصيل الذي يبثّ الأرشيفَ من الشبكة إلى القرص مباشرةً بلا لمس ذاكرة JS. الفشلُ ما زال
  // يبقى داخل التطبيق كرسالةٍ عربية لأنّ الاستعلامَ المسبقَ يلتقط 401/403/400 قبل الملاحة.
  const beginDownload = async () => {
    if (!downloadUrl || downloading) return;
    setDownloading(true);
    try {
      const preflightUrl = `${downloadUrl}&preflight=1`;
      const check = await fetch(preflightUrl, { credentials: "include" });
      if (!check.ok) {
        if (check.status === 401) throw new Error("انتهت جلستُك — سجّل دخولاً وأعد المحاولة");
        if (check.status === 403) throw new Error("لا صلاحيةَ لتنزيل الصور — راجع مدير النظام");
        const body = await check.json().catch(() => null);
        throw new Error(body?.error ?? `تعذّر تجهيز التنزيل (${check.status})`);
      }
      // الاستعلامُ المسبق نجح ⇒ الجلسة صالحةٌ والنطاق مقبول. نُطلِق تنزيلَ المتصفّح
      // الأصيل الذي يعتمد على كوكي الجلسة نفسه (نفس السياق، نفس الأصل) ويبثّ الأرشيف
      // مباشرةً بلا Blob. الخادم يضيف `Content-Disposition: attachment` فيفتح مربّع الحفظ
      // بلا انتقالٍ فعليّ عن الصفحة.
      window.location.assign(downloadUrl);
      notify.ok("بدأ التنزيل — تحقّق من مجلّد التنزيلات");
    } catch (err) {
      notify.err(err);
    } finally {
      setDownloading(false);
    }
  };

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
              Codex P2 على PR #811). زرٌّ لا رابط: `fetch` يمرّر الكوكي صراحةً ويُعيد أخطاءَ
              الخادم رسالةً عربية داخل التطبيق — لا حوار مصادقةٍ متصفّحيّ عاجز. */}
          <Button type="button" className="min-h-11" disabled={!canDownload || downloading} onClick={beginDownload}>
            {downloading ? (
              <>
                <Loader2 aria-hidden className="size-4 animate-spin" /> جارٍ تجهيز الأرشيف…
              </>
            ) : (
              <>
                <Download aria-hidden className="size-4" /> نزّل الأرشيف
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
