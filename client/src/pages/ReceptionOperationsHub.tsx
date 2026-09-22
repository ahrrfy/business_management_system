import type { ComponentType } from "react";
import { PageTabs, type HubTab } from "@/components/PageTabs";
import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { trpc } from "@/lib/trpc";
import {
  RECEPTION_OPERATION_TAB_DEFINITIONS,
  type ReceptionOperationsTabValue,
} from "@/lib/receptionOperationsHub";

// لا استيراداً مباشراً لهذه الصفحات: React.lazy لا يطلب حزمة التبويب إلا بعد أن
// يركّب PageTabs لوحته النشطة، لذلك التبويبات المخفية لا تُركّب ولا تُجري استعلاماتها.
const ReceptionOrdersPage = lazy(
  () => import("@/pages/reception/ReceptionOrdersPage"),
);
const ReceptionInvoicesPage = lazy(
  () => import("@/pages/reception/ReceptionInvoicesPage"),
);
const ReceptionWorkflowPage = lazy(
  () => import("@/pages/reception/ReceptionWorkflowPage"),
);
const ReceptionHandoverPage = lazy(
  () => import("@/pages/reception/ReceptionHandoverPage"),
);
const ReceptionDraftsPage = lazy(
  () => import("@/pages/reception/ReceptionDraftsPage"),
);

const COMPONENTS: Record<ReceptionOperationsTabValue, ComponentType> = {
  orders: ReceptionOrdersPage,
  invoices: ReceptionInvoicesPage,
  workflow: ReceptionWorkflowPage,
  handover: ReceptionHandoverPage,
  drafts: ReceptionDraftsPage,
};

const TABS: HubTab[] = RECEPTION_OPERATION_TAB_DEFINITIONS.map((tab) => ({
  ...tab,
  Component: COMPONENTS[tab.value],
}));

/**
 * مركز واحد لمسارات ما بعد تثبيت الطلب. PageTabs يملك ?tab=، زر الرجوع، والعودة
 * لأول تبويب مرئي إذا كان الرابط المطلوب غير موجود أو غير مسموح للحساب الحالي.
 */
export default function ReceptionOperationsHub() {
  const me = trpc.auth.me.useQuery();

  // لا نركّب أياً من الصفحات الفرعية قبل حسم هوية المستخدم وفرعه. الصفحات الأربع
  // فرعية النطاق، وبعض استعلاماتها (الوردية/التوصيل) تفشل مغلقةً بلا فرع مُسنَد.
  if (me.isPending || !me.data) return null;
  if (me.data.branchId == null) return <NoBranchNotice />;

  return <PageTabs tabs={TABS} ariaLabel="عمليات محطة الاستقبال" />;
}

function NoBranchNotice() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5">
      <div className="rounded-xl border border-dashed p-8 text-center">
        <p className="text-sm font-bold">لا فرع مُسنَد لحسابك</p>
        <p className="mt-1 text-xs text-muted-foreground">
          مركز الاستقبال يعمل على فرع محدد — راجع المدير لإسناد فرعك قبل فتح
          الطلبات أو التحصيل أو التسليم.
        </p>
      </div>
    </div>
  );
}
