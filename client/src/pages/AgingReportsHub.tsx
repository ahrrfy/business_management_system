// مجمّع تقارير أعمار الذمم — يوحّد ٣ صفحات (AR ملخّص، AP ملخّص، AR/AP تفصيلي)
// في تبويبين (مدينة | دائنة) × معرض ملخّص/تفصيل. السبب: تدقيق UX/IA كشف أن
// الـ٣ تفصّل نفس البيانات بزوايا مختلفة ⇒ مكان واحد أسهل اكتشافاً للمستخدم.

import { lazy, Suspense, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageHeader } from "@/components/PageHeader";
import { ACTION_LABELS } from "@shared/actionLabels";

const ARAging = lazy(() => import("./ARAging"));
const APAging = lazy(() => import("./APAging"));
const ArApAgingDetail = lazy(() => import("./ArApAgingDetail"));

function TabFallback() {
  return <div className="p-10 text-center text-muted-foreground">{ACTION_LABELS.loading}</div>;
}

export default function AgingReportsHub() {
  // ملخّص = AR/AP الملخّصة المنفصلة (منظور تجاري سريع).
  // تفصيلي = ArApAgingDetail الذي يعرض المدينة والدائنة فاتورة-بفاتورة في صفحة واحدة.
  const [view, setView] = useState<"summary" | "detailed">("summary");
  return (
    <div className="p-4 max-w-7xl space-y-4">
      <PageHeader
        title="أعمار الذمم"
        description="توزيع الذمم المستحقّة حسب الفترة الزمنية — مدينة (عملاء يدينون لك) أو دائنة (موردون تدين لهم)."
        actions={
          <div className="flex gap-1 rounded-lg border p-1 bg-muted/30">
            <button
              type="button"
              onClick={() => setView("summary")}
              className={view === "summary" ? "px-3 py-1.5 text-sm font-bold rounded-md bg-background shadow-sm" : "px-3 py-1.5 text-sm text-muted-foreground"}
            >ملخّص</button>
            <button
              type="button"
              onClick={() => setView("detailed")}
              className={view === "detailed" ? "px-3 py-1.5 text-sm font-bold rounded-md bg-background shadow-sm" : "px-3 py-1.5 text-sm text-muted-foreground"}
            >تفصيلي</button>
          </div>
        }
      />

      {view === "summary" ? (
        <Tabs defaultValue="ar" className="w-full">
          <TabsList>
            <TabsTrigger value="ar">مدينة (عملاء)</TabsTrigger>
            <TabsTrigger value="ap">دائنة (موردون)</TabsTrigger>
          </TabsList>
          <TabsContent value="ar" className="mt-3">
            <Suspense fallback={<TabFallback />}><ARAging /></Suspense>
          </TabsContent>
          <TabsContent value="ap" className="mt-3">
            <Suspense fallback={<TabFallback />}><APAging /></Suspense>
          </TabsContent>
        </Tabs>
      ) : (
        // التفصيل المتداخل (AR+AP في صفحة واحدة بنداً-بنداً) — يستعمل ArApAgingDetail
        // الذي لديه فلتر دور (مدينة/دائنة) داخلياً.
        <div className="mt-3">
          <Suspense fallback={<TabFallback />}><ArApAgingDetail /></Suspense>
        </div>
      )}
    </div>
  );
}
