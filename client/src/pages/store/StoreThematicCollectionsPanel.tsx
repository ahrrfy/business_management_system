/**
 * StoreThematicCollectionsPanel — لوحة إدارة التشكيلات التحريرية الذكية والمؤتمتة.
 * تتيح لمدير المتجر:
 * ١. مراقبة محرك التعدين الخوارزمي وتوليد التشكيلات الحية بحسب رصيد الكتالوج والمخزون.
 * ٢. إعادة تشغيل التحليل الفوري للمنتجات وعرض بطاقات الواجهة قبل ظهورها للزبائن.
 * ٣. التبديل بسلاسة بين «الوضع التلقائي الذكي» (الافتراضي) و«الوضع التحريري المخصص».
 */

import React, { useState } from "react";
import {
  Sparkles,
  RefreshCw,
  Sliders,
  CheckCircle2,
  Layers,
  Eye,
  Save,
  Loader2,
  Briefcase,
  GraduationCap,
  PenTool,
  Tag,
  LayoutGrid,
  Palette,
  ChevronLeft,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const ICON_MAP = {
  Briefcase,
  GraduationCap,
  PenTool,
  Tag,
  LayoutGrid,
  Palette,
  Sparkles,
} as const;

export default function StoreThematicCollectionsPanel() {
  const utils = trpc.useUtils();
  const query = trpc.storeAdmin.thematicCollections.get.useQuery();
  const updateM = trpc.storeAdmin.thematicCollections.update.useMutation({
    onSuccess: () => {
      notify.ok("تم حفظ إعدادات التشكيلات التحريرية بنجاح وتحديث المتجر فورياً.");
      utils.storeAdmin.thematicCollections.get.invalidate();
      utils.storefront.thematicCollections.invalidate();
    },
    onError: (err) => {
      notify.err(err.message || "تعذر حفظ إعدادات التشكيلات.");
    },
  });

  const [isRecalculating, setIsRecalculating] = useState(false);

  const config = query.data?.config;
  const cards = query.data?.algorithmicCards ?? [];
  const currentMode = config?.mode ?? "AUTO";

  async function handleRecalculate() {
    setIsRecalculating(true);
    try {
      await utils.storeAdmin.thematicCollections.preview.fetch();
      await utils.storeAdmin.thematicCollections.get.invalidate();
      await utils.storefront.thematicCollections.invalidate();
      notify.ok("تمت إعادة تحليل الكتالوج بنجاح وتحديث التشكيلات الثلاث.");
    } catch {
      notify.err("تعذر تحديث تحليل الكتالوج.");
    } finally {
      setIsRecalculating(false);
    }
  }

  function handleToggleMode() {
    const nextMode = currentMode === "AUTO" ? "CUSTOM" : "AUTO";
    updateM.mutate({
      mode: nextMode,
      customCards: nextMode === "CUSTOM" ? cards : undefined,
    });
  }

  return (
    <div className="space-y-6">
      {/* بطاقة التحكم الرئيسية */}
      <Card className="border-primary/20 bg-gradient-to-l from-primary/5 via-card to-card">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Sparkles aria-hidden className="size-5" />
              </span>
              <div>
                <CardTitle className="text-base font-bold">محرك التشكيلات التحريرية الذكية (Smart Curation Engine)</CardTitle>
                <p className="text-xs text-muted-foreground">
                  نظام خوارزمي مؤتمت يحلل الكتالوج والمخزون الحي لحظياً، ويختار أفضل ٣ مجموعات ترويجية ذات أعلى جاذبية ومعدل تحويل.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {currentMode === "AUTO" ? (
                <Badge variant="outline" className="border-[var(--sem-pos)]/40 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] text-xs font-bold gap-1 py-1 px-2.5">
                  <CheckCircle2 aria-hidden className="size-3.5" />
                  الوضع التلقائي الخوارزمي (مفعل)
                </Badge>
              ) : (
                <Badge variant="outline" className="border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] text-xs font-bold gap-1 py-1 px-2.5">
                  <Sliders aria-hidden className="size-3.5" />
                  الوضع التحريري المخصص
                </Badge>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={handleRecalculate}
                disabled={isRecalculating || query.isLoading}
                className="gap-1.5 text-xs font-bold"
              >
                <RefreshCw aria-hidden className={`size-3.5 ${isRecalculating ? "animate-spin" : ""}`} />
                إعادة تحليل الكتالوج الآن
              </Button>

              <Button
                variant={currentMode === "AUTO" ? "secondary" : "default"}
                size="sm"
                onClick={handleToggleMode}
                disabled={updateM.isPending}
                className="gap-1.5 text-xs font-bold"
              >
                {updateM.isPending ? (
                  <Loader2 aria-hidden className="size-3.5 animate-spin" />
                ) : (
                  <Sliders aria-hidden className="size-3.5" />
                )}
                {currentMode === "AUTO" ? "التبديل إلى التحرير المخصص" : "العودة للوضع التلقائي الذكي"}
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="rounded-xl border border-slate-200/60 bg-slate-50/50 p-3 text-xs leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-300">
            <p className="font-semibold text-foreground mb-1">كيف تعمل الخوارزمية الذكية؟</p>
            <ul className="list-disc list-inside space-y-1 text-muted-foreground text-[11px]">
              <li>تفحص منتجات الكتالوج وتصنفها ضمن أنماط التسوق الستة: الفخامة والإهداء، التفوق الأكاديمي، الخط العربي، عروض التوفير، والإنتاجية المكتبية.</li>
              <li>تحسب مجموع المنتجات المتوفرة فعلياً في المخزون وتستبعد أي مجموعة برصيد صفر لمنع إحباط الزبائن.</li>
              <li>ترشح أفضل ٣ مجموعات ذات أعلى نقاط لعرضها تلقائياً على واجهة المتجر مع ربط الزر بتصفية الكتالوج مباشرة.</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* استعراض التشكيلات الفعالة الحية */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Eye aria-hidden className="size-4 text-primary" />
            <h3 className="text-sm font-bold text-foreground">معاينة التشكيلات الحية في واجهة المتجر ({cards.length})</h3>
          </div>
          <span className="text-xs text-muted-foreground">تتحدث تلقائياً مع حركة المبيعات وتوفر المخزون</span>
        </div>

        {query.isLoading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-56 rounded-3xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
            ))}
          </div>
        ) : cards.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-xs text-muted-foreground dark:border-slate-800">
            لا تتوفر تشكيلات مؤهلة حالياً بسبب عدم وجود منتجات كافية في المخزون.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {cards.map((col) => {
              const IconComponent = (col.iconName && ICON_MAP[col.iconName as keyof typeof ICON_MAP]) || Sparkles;

              return (
                <div
                  key={col.id}
                  className={`group relative flex flex-col justify-between overflow-hidden rounded-3xl border ${col.borderColor} bg-gradient-to-br ${col.bgGradient} p-5 text-white shadow-md`}
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="flex size-9 items-center justify-center rounded-xl bg-white/10 backdrop-blur-md">
                        <IconComponent aria-hidden className="size-4 text-white/90" />
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="rounded-full bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border border-[var(--sem-pos)]/30 px-2 py-0.5 text-[10px] font-bold">
                          {col.itemCount} منتج متوفر
                        </span>
                        <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[10px] font-bold text-slate-200">
                          {col.tag}
                        </span>
                      </div>
                    </div>

                    <h4 className="mt-4 text-base font-black leading-snug text-white">
                      {col.title}
                    </h4>
                    <p className="mt-1.5 text-xs text-slate-300 line-clamp-2">
                      {col.description}
                    </p>

                    {col.sampleProductNames && col.sampleProductNames.length > 0 && (
                      <div className="mt-3 rounded-lg bg-black/20 p-2 text-[10px] text-slate-300">
                        <span className="font-bold text-slate-200 block mb-0.5">عينات من الأصناف:</span>
                        <p className="truncate">{col.sampleProductNames.join(" • ")}</p>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between text-xs font-bold text-slate-200">
                    <span className="truncate">{col.cta}</span>
                    <span className="text-[11px] text-slate-400 font-mono">نقاط الجاذبية: {col.score ?? 0}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
