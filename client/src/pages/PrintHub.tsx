// PrintHub — وحدة «المطبعة والإنتاج» بتبويبات (طابور المطبعة + محطة التنفيذ + الإنتاج + الوصفات).
// الإنشاء يتم من شاشة الاستقبال الموحدة؛ مسارات التفصيل (‎/work-orders/:id، ‎/production/:id) تبقى مستقلّة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CircleHelp, ClipboardPenLine, FileCheck2, PackageCheck, Plus, Printer } from "lucide-react";
import { Link } from "wouter";

const WorkOrders = lazy(() => import("@/pages/WorkOrders"));
const WorkOrderStation = lazy(() => import("@/pages/WorkOrderStation"));
const Production = lazy(() => import("@/pages/Production"));
const ProductionRecipes = lazy(() => import("@/pages/ProductionRecipes"));
const PrintPricingCalculator = lazy(() => import("@/pages/PrintPricingCalculator"));
const PrintPricingSettings = lazy(() => import("@/pages/PrintPricingSettings"));

const TABS: HubTab[] = [
  // توحيد اصطلاحي (٣/٨): «طابور المطبعة» يطابق الآن عنوان الصفحة نفسها («أوامر الشغل» —
  // WorkOrders.tsx:841) بدل تسمية قديمة منفصلة توحي بمفهوم مختلف (طابور المطبعة فقط).
  { value: "queue", label: "أوامر الشغل", gate: { module: "workorders", level: "READ" }, Component: WorkOrders },
  {
    value: "station",
    label: "محطة التنفيذ",
    gate: { roles: ["cashier", "manager", "print_operator"], module: "workorders", level: "FULL" },
    Component: WorkOrderStation,
  },
  { value: "production", label: "الإنتاج والتحويل", gate: { roles: ["manager"], module: "inventory", level: "FULL" }, Component: Production },
  { value: "recipes", label: "وصفات الإنتاج", gate: { roles: ["manager"], module: "inventory", level: "FULL" }, Component: ProductionRecipes },
  // محرّك تسعير الطباعة الرقمية (البند⑥ ط٢) — حاسبة + إعدادات، محصورة بالمدير.
  { value: "print-pricing", label: "حاسبة التسعير", gate: { managerOnly: true }, Component: PrintPricingCalculator },
  { value: "print-pricing-settings", label: "إعدادات التسعير", gate: { managerOnly: true }, Component: PrintPricingSettings },
];

export default function PrintHub() {
  return (
    <PageTabs
      tabs={TABS}
      ariaLabel="أقسام المطبعة والإنتاج"
      header={
        <div className="flex items-center gap-2 ps-1">
          <Printer aria-hidden className="size-4 text-primary shrink-0" />
          <span className="text-sm font-extrabold tracking-tight text-foreground">
            المطبعة والإنتاج
          </span>
        </div>
      }
      actions={
        <>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs font-bold">
                <CircleHelp aria-hidden className="size-3.5 text-muted-foreground" />
                مسار الطلب
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-3.5 text-start" dir="rtl">
              <div className="space-y-2.5">
                <div>
                  <h2 id="print-journey-title" className="text-xs font-extrabold">
                    مسار الطلب المخصّص
                  </h2>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    ثبّت الطلب أولاً، اعتمد نسخة التصميم الحالية، ثم نفّذ وسلّم أو أسند للتوصيل.
                  </p>
                </div>
                <ol className="space-y-2 border-t pt-2 text-xs">
                  <li className="flex gap-2.5">
                    <ClipboardPenLine aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    <div>
                      <p className="font-bold">١. الطلب والعرض</p>
                      <p className="text-2xs leading-relaxed text-muted-foreground">
                        سجّل مواصفات العميل والسعر المتفق عليه في الاستقبال؛ عرض السعر الرسمي يُتابَع من قسم الفرص وعروض الأسعار.
                      </p>
                    </div>
                  </li>
                  <li className="flex gap-2.5">
                    <FileCheck2 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    <div>
                      <p className="font-bold">٢. اعتماد التصميم</p>
                      <p className="text-2xs leading-relaxed text-muted-foreground">
                        احفظ النسخة واطلب اعتمادها بالدليل من المهمة المرتبطة. لا تبدأ الإنتاج قبل اعتماد النسخة الحالية.
                      </p>
                    </div>
                  </li>
                  <li className="flex gap-2.5">
                    <PackageCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    <div>
                      <p className="font-bold">٣. التنفيذ والتسليم</p>
                      <p className="text-2xs leading-relaxed text-muted-foreground">
                        نفّذ من محطة التنفيذ ثم علّم الطلب جاهزاً؛ سلّمه مع الفوترة أو أسنده للتوصيل لمتابعة الوصول والتحصيل.
                      </p>
                    </div>
                  </li>
                </ol>
              </div>
            </PopoverContent>
          </Popover>
          <Button asChild size="sm" className="gap-1.5 text-xs font-bold">
            <Link href="/pos?mode=RECEPTION">
              <Plus aria-hidden className="size-3.5" />
              استقبال طلب / عرض
            </Link>
          </Button>
        </>
      }
    />
  );
}
