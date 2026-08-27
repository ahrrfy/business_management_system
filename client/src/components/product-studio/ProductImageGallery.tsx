/**
 * معرضُ صور المنتج القائمة — للمدير فقط.
 *
 * الحاجة (المالك ٢٦/٨): «التحكم الكامل بالصور حتى الموجودة سابقاً في المنتج من إزالتها
 * وغير ذلك أو استبدالها». مسار الاستوديو القائم يُضيف صوراً ولا يمسّ الموجودة. هذا
 * المعرض يفتح: حذفٌ، ترتيبٌ (سحبٌ لأعلى/أسفل)، وتعيينُ الرئيسيّة. الاستبدال يمرّ عبر
 * إسناد مهمّةٍ جديدةٍ بنمط «إضافة صورة جديدة» ثمّ حذف القديمة — تصميمٌ متسّق مع
 * دورة الاستوديو الحاليّة.
 *
 * كل صورةٍ تُعرَض ببديلها المرتبط (إن كانت variant-scoped)، فالمدير يرى «هذه صورة
 * ماركة X، وتلك للأمّ» — أساسٌ للتحكّم الواضح.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirm } from "@/lib/confirm";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ArrowDown, ArrowUp, Image as ImageIcon, Star, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

export function ProductImageGallery({ productId, onClose }: { productId: number; onClose?: () => void }) {
  const utils = trpc.useUtils();
  const images = trpc.productStudio.managerImages.useQuery({ productId }, { staleTime: 30_000 });

  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  const displayImages = useMemo(() => {
    const rows = images.data ?? [];
    if (localOrder == null) return rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = localOrder.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => x != null);
    // ألحق أيّ صفٍّ لم يظهر في الترتيب المحلّي (وقاية من دفعةٍ تخسر عناصر).
    for (const r of rows) if (!localOrder.includes(r.id)) ordered.push(r);
    return ordered;
  }, [images.data, localOrder]);

  const setPrimary = trpc.productStudio.setImagePrimary.useMutation({
    onSuccess: async () => {
      notify.ok("عُيِّنت الصورة رئيسيّةً");
      // نُبطِل استعلامَي الصور معاً: `managerImages` لهذا المعرض، و`productImages` لواجهة
      // الإسناد التي تستعمل نفس الصور كمصدر «إضافة/استبدال» (الجذر: مراجعة Codex P2 على PR #825).
      await Promise.all([
        utils.productStudio.managerImages.invalidate({ productId }),
        utils.productStudio.productImages.invalidate({ productId }),
      ]);
    },
    onError: (e) => notify.err(e),
  });
  const deleteImg = trpc.productStudio.deleteImage.useMutation({
    onSuccess: async (r) => {
      notify.ok(r.promotedNewPrimary ? "حُذفت الصورة ورُقّيت الصورةُ التالية رئيسيّةً" : "حُذفت الصورة");
      setLocalOrder(null);
      // نُبطِل استعلامَي الصور معاً: `managerImages` لهذا المعرض، و`productImages` لواجهة
      // الإسناد التي تستعمل نفس الصور كمصدر «إضافة/استبدال» (الجذر: مراجعة Codex P2 على PR #825).
      await Promise.all([
        utils.productStudio.managerImages.invalidate({ productId }),
        utils.productStudio.productImages.invalidate({ productId }),
      ]);
    },
    onError: (e) => notify.err(e),
  });
  const reorder = trpc.productStudio.reorderImages.useMutation({
    onSuccess: async () => {
      notify.ok("حُفظ الترتيب");
      setLocalOrder(null);
      // نُبطِل استعلامَي الصور معاً: `managerImages` لهذا المعرض، و`productImages` لواجهة
      // الإسناد التي تستعمل نفس الصور كمصدر «إضافة/استبدال» (الجذر: مراجعة Codex P2 على PR #825).
      await Promise.all([
        utils.productStudio.managerImages.invalidate({ productId }),
        utils.productStudio.productImages.invalidate({ productId }),
      ]);
    },
    onError: (e) => notify.err(e),
  });

  const moveLocal = (index: number, delta: -1 | 1) => {
    const current = localOrder ?? displayImages.map((r) => r.id);
    const next = [...current];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setLocalOrder(next);
  };
  const isDirty = localOrder != null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            <ImageIcon aria-hidden className="size-4" /> معرض صور المنتج — إدارة يدويّة
          </span>
          {onClose && (
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              إغلاق
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {images.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>}
        {images.isError && (
          <p role="alert" className="text-sm text-destructive">تعذّر جلب الصور — أعد المحاولة.</p>
        )}
        {!images.isLoading && !images.isError && displayImages.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">لا صور معتمَدة لهذا المنتج بعد.</p>
        )}
        {displayImages.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              كل صورةٍ تُعرَض ببديلها المرتبط. رتِّب بأزرار السهم واحفظ. الصورة الرئيسيّة هي التي تظهر في المتجر والفواتير.
            </p>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {displayImages.map((img, index) => (
                <li key={img.id} className={`min-w-0 rounded-md border p-2 ${img.isPrimary ? "border-primary" : ""}`}>
                  <div className="relative aspect-square overflow-hidden rounded bg-muted/30">
                    <img
                      src={img.url}
                      alt={img.variantName ? `صورة بديل ${img.variantName}` : "صورة المنتج"}
                      className="size-full object-contain"
                      loading="lazy"
                    />
                    {img.isPrimary && (
                      <Badge variant="success" className="absolute top-1 start-1">
                        <Star aria-hidden className="size-3" /> رئيسيّة
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2 min-w-0 space-y-1 text-xs">
                    <p className="truncate text-muted-foreground">
                      {img.variantName ? `بديل: ${img.variantName}` : "على مستوى المنتج"}
                      {img.origin && img.origin !== "ORIGINAL" ? ` · ${img.origin.replace("STUDIO_", "")}` : ""}
                    </p>
                    {img.width && img.height && (
                      <p className="text-muted-foreground">{img.width}×{img.height}px {img.bytes ? `· ${Math.round((img.bytes ?? 0) / 1024)}KB` : ""}</p>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Button type="button" size="sm" variant="ghost" className="min-h-10 px-2" title="حرّك لأعلى" disabled={index === 0} onClick={() => moveLocal(index, -1)}>
                      <ArrowUp aria-hidden className="size-4" />
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="min-h-10 px-2" title="حرّك لأسفل" disabled={index === displayImages.length - 1} onClick={() => moveLocal(index, 1)}>
                      <ArrowDown aria-hidden className="size-4" />
                    </Button>
                    {!img.isPrimary && (
                      <Button type="button" size="sm" variant="outline" className="min-h-10" disabled={setPrimary.isPending} onClick={() => setPrimary.mutate({ imageId: img.id })}>
                        <Star aria-hidden className="size-4" /> اجعلها رئيسيّة
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className="min-h-10"
                      disabled={deleteImg.isPending}
                      onClick={async () => {
                        // مربّع تأكيد التطبيق (بدل window.confirm) — الحرّاس تفرضه.
                        const ok = await confirm({
                          variant: "danger",
                          title: "حذف صورة نهائياً",
                          description: "لن تظهر بعد الآن في المتجر أو الفواتير. أضِف بديلاً قبل حذف الصورة الرئيسيّة.",
                          confirmText: "حذف",
                        });
                        if (!ok) return;
                        deleteImg.mutate({ imageId: img.id });
                      }}
                    >
                      <Trash2 aria-hidden className="size-4" /> حذف
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button
                type="button"
                className="min-h-11"
                disabled={!isDirty || reorder.isPending}
                onClick={() => reorder.mutate({ productId, orderedImageIds: (localOrder ?? []).slice() })}
              >
                احفظ الترتيب الجديد
              </Button>
              {isDirty && (
                <Button type="button" variant="ghost" className="min-h-11" onClick={() => setLocalOrder(null)}>
                  إلغاء التعديل
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                {displayImages.length} صورة · {displayImages.filter((i) => i.isPrimary).length} رئيسيّة (حسب البديل)
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
