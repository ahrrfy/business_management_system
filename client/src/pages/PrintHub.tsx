// PrintHub — وحدة «المطبعة والإنتاج» بتبويبات (طابور المطبعة + محطة التنفيذ + الإنتاج + الوصفات).
// الإنشاء يتم من شاشة الاستقبال الموحدة؛ مسارات التفصيل (‎/work-orders/:id، ‎/production/:id) تبقى مستقلّة.
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { PageTabs, type HubTab } from "@/components/PageTabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ClipboardPenLine, FileCheck2, PackageCheck } from "lucide-react";
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
    <div className="space-y-4">
      <Card
        aria-labelledby="print-journey-title"
      >
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="print-journey-title" className="text-base font-bold">
              مسار الطلب المخصّص
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              ثبّت الطلب أولاً، اعتمد نسخة التصميم الحالية، ثم نفّذ وسلّم أو
              أسند للتوصيل.
            </p>
          </div>
          <Button asChild size="sm">
            <Link href="/pos?mode=RECEPTION">
              <ClipboardPenLine aria-hidden className="size-4" /> استقبال طلب /
              عرض
            </Link>
          </Button>
        </div>

          <ol className="mt-4 grid gap-3 border-t pt-4 md:grid-cols-3">
          <li className="flex gap-3">
            <ClipboardPenLine
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-primary"
            />
            <div>
              <p className="text-sm font-bold">١. الطلب والعرض</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                سجّل مواصفات العميل والسعر المتفق عليه في الاستقبال؛ عرض السعر
                الرسمي يُتابَع من قسم الفرص وعروض الأسعار.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <FileCheck2
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-primary"
            />
            <div>
              <p className="text-sm font-bold">٢. اعتماد التصميم</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                احفظ النسخة واطلب اعتمادها بالدليل من المهمة المرتبطة. لا تبدأ
                الإنتاج قبل اعتماد النسخة الحالية.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <PackageCheck
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-primary"
            />
            <div>
              <p className="text-sm font-bold">٣. التنفيذ والتسليم</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                نفّذ من محطة التنفيذ ثم علّم الطلب جاهزاً؛ سلّمه مع الفوترة أو
                أسنده للتوصيل لمتابعة الوصول والتحصيل.
              </p>
            </div>
          </li>
          </ol>
        </CardContent>
      </Card>

      <PageTabs tabs={TABS} ariaLabel="أقسام المطبعة والإنتاج" />
    </div>
  );
}
