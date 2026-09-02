// مجمّع تقارير المبيعات — يوحّد ٣ تقارير تحت تبويبات. السبب: تدقيق UX/IA كشف
// أن لـSalesReport و SalesRegister و SalesByDimension تداخلاً (كلها تقارير مبيعات
// بزوايا مختلفة) ⇒ صفحة موحّدة بتبويبات تستغني عن ٣ مداخل متفرّقة في الشريط.
// التطبيق خفيف بالتعمّد: lazy + Suspense للصفحات الكاملة بدل تكرار/استخراج كودها.

import { lazy, Suspense } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHeader } from "@/components/PageHeader";
import { ACTION_LABELS } from "@shared/actionLabels";

const SalesReport = lazy(() => import("./SalesReport"));
const SalesRegister = lazy(() => import("./SalesRegister"));
const SalesByDimension = lazy(() => import("./SalesByDimension"));
const WorkOrderProfitability = lazy(() => import("./WorkOrderProfitability"));

function TabFallback() {
  return <div className="p-10 text-center text-muted-foreground">{ACTION_LABELS.loading}</div>;
}

export default function SalesReportsHub() {
  return (
    <div className="p-4 max-w-7xl space-y-4">
      <PageHeader
        title="تقارير المبيعات"
        description="أربع زوايا للنظر إلى مبيعاتك: الملخّص، التفصيل بنداً-بنداً، التوزيع حسب البُعد (عميل/فرع/طريقة دفع/كاشير)، وربحية أوامر الشغل."
      />
      <Tabs defaultValue="summary" className="w-full">
        <TabsList>
          <TabsTrigger value="summary">ملخّص</TabsTrigger>
          <TabsTrigger value="detailed">تفصيلي (بنداً-بنداً)</TabsTrigger>
          <TabsTrigger value="dimension">حسب البُعد</TabsTrigger>
          <TabsTrigger value="wo-profitability">ربحية أوامر الشغل</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="mt-3">
          <Suspense fallback={<TabFallback />}><SalesReport /></Suspense>
        </TabsContent>
        <TabsContent value="detailed" className="mt-3">
          <Suspense fallback={<TabFallback />}><SalesRegister /></Suspense>
        </TabsContent>
        <TabsContent value="dimension" className="mt-3">
          <Suspense fallback={<TabFallback />}><SalesByDimension /></Suspense>
        </TabsContent>
        <TabsContent value="wo-profitability" className="mt-3">
          <Suspense fallback={<TabFallback />}><WorkOrderProfitability /></Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
