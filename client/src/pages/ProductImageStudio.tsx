import React, { useState, useEffect, useMemo } from "react";
import {
  Camera,
  CheckCircle2,
  Library,
  Download,
  Loader2,
  Sparkles,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StudioContinuousWorkflow } from "@/components/product-studio/StudioContinuousWorkflow";
import { StudioAdminReviewPanel } from "@/components/product-studio/StudioAdminReviewPanel";
import { StudioTempPhotographerCard } from "@/components/product-studio/StudioTempPhotographerCard";
import { StudioStandaloneImageManagerCard } from "@/components/product-studio/StudioStandaloneImageManagerCard";
import { StudioImageExportPanel } from "@/components/product-studio/StudioImageExportPanel";
import { trpc } from "@/lib/trpc";
import { useOperationPermission } from "@/hooks/useOperationPermission";
import {
  OPERATION_PERMISSIONS,
  hasOperationPolicy,
  operationDecision,
  type OperationUser,
} from "@shared/operationPermissions";
import { ACTION_LABELS } from "@shared/actionLabels";

export const STUDIO_STORAGE_DISABLED_MESSAGE =
  "خدمة التخزين السحابي غير متصلة. لا يمكن رفع صور جديدة أو سحب المسودات السابقة. استعادة المسودة المحلية متاح للحفظ المؤقت.";

export interface ProductImageStudioProps {
  mockUserRole?: string;
  mockCanManage?: boolean;
  initialTab?: string;
  initialBarcode?: string;
  initialProductId?: number;
}

export default function ProductImageStudio({
  mockUserRole,
  mockCanManage,
  initialTab: propInitialTab,
  initialBarcode: propInitialBarcode,
  initialProductId: propInitialProductId,
}: ProductImageStudioProps = {}) {
  // جلب بيانات المستخدم الحالي وصلاحياته
  const me = trpc.auth.me.useQuery(undefined, {
    enabled: mockCanManage === undefined && mockUserRole === undefined,
  });

  // جلب الفئات لقسم التصدير
  const categoriesQ = trpc.catalog.categories.useQuery(undefined, {
    staleTime: 60_000,
  });

  // تحليل معلمات الاستعلام من URL
  const { urlTab, urlBarcode, urlProductId } = useMemo(() => {
    if (typeof window === "undefined") {
      return { urlTab: null, urlBarcode: null, urlProductId: null };
    }
    const params = new URLSearchParams(window.location.search);
    return {
      urlTab: params.get("tab"),
      urlBarcode: params.get("barcode"),
      urlProductId: params.get("productId") ? Number(params.get("productId")) : null,
    };
  }, []);

  const barcodeParam = propInitialBarcode ?? urlBarcode ?? null;
  const productIdParam = propInitialProductId ?? urlProductId ?? null;

  // التحقق من الصلاحيات الإدارية وصلاحية التصدير بدقة (لا تعتمد على productStudio.tasks المتاح لجميع الموظفين)
  const user = me.data as OperationUser | undefined;
  const userRole = mockUserRole ?? user?.role;
  const canManage = useMemo(() => {
    if (mockCanManage !== undefined) return mockCanManage;
    if (userRole === "admin" || userRole === "manager") return true;
    if (user && hasOperationPolicy(user)) {
      return OPERATION_PERMISSIONS.some(
        (operation) =>
          operation.domain === "productStudio" &&
          ["productStudio.approve", "productStudio.bulkApproveStudioTasks"].includes(
            operation.path,
          ) &&
          operationDecision(user, operation.path).allowed,
      );
    }
    return false;
  }, [mockCanManage, userRole, user]);

  const exportPerm = useOperationPermission("productStudio.authorizeExport");
  const canExport = mockCanManage !== undefined ? mockCanManage : (canManage && exportPerm.allowed);

  // تحديد التبويب الابتدائي وفق الصلاحيات الفعلية
  const requestedTab = propInitialTab ?? urlTab ?? "workflow";
  const [activeTab, setActiveTab] = useState<string>(() => {
    if (requestedTab === "review" && canManage) return "review";
    if (requestedTab === "library" && canManage) return "library";
    if (requestedTab === "export" && canExport) return "export";
    return "workflow";
  });

  // إعادة التوجيه للتبويب الأول إذا طلب غير المخوّل تبويباً إدارياً، ومزامنة التبويب المطلوب
  useEffect(() => {
    if (propInitialTab) {
      if (propInitialTab === "review" && canManage) {
        setActiveTab("review");
      } else if (propInitialTab === "library" && canManage) {
        setActiveTab("library");
      } else if (propInitialTab === "export" && canExport) {
        setActiveTab("export");
      } else {
        setActiveTab("workflow");
      }
    } else if (
      (activeTab === "review" && !canManage) ||
      (activeTab === "library" && !canManage) ||
      (activeTab === "export" && !canExport)
    ) {
      setActiveTab("workflow");
    }
  }, [propInitialTab, activeTab, canManage, canExport]);

  if (me.isLoading && mockCanManage === undefined) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="size-10 animate-spin text-primary" />
          <p className="text-muted-foreground animate-pulse text-sm">
            {ACTION_LABELS.loading}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-w-0 space-y-4 overflow-x-hidden p-4 md:p-6"
      data-testid="product-image-studio-page"
    >
      <PageHeader
        title="استوديو صور المنتجات"
        description="منظومة متكاملة وخفيفة لتصوير وتجهيز واعتماد صور المنتجات بالذكاء الاصطناعي"
        icon={<Camera aria-hidden className="size-6 text-primary" />}
      />

      {/* التبويبات المتجاوبة */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <div className="overflow-x-auto pb-1">
          <TabsList className="inline-flex w-auto min-w-full sm:min-w-0 h-10 p-1">
            <TabsTrigger
              value="workflow"
              data-testid="tab-trigger-workflow"
              className="flex items-center gap-2 px-3 py-1.5 text-xs sm:text-sm"
            >
              <Camera className="size-4" />
              <span>استوديو التصوير السريع</span>
            </TabsTrigger>

            {canManage && (
              <TabsTrigger
                value="review"
                data-testid="tab-trigger-review"
                className="flex items-center gap-2 px-3 py-1.5 text-xs sm:text-sm"
              >
                <CheckCircle2 className="size-4" />
                <span>طابور الاعتماد والمراجعة</span>
              </TabsTrigger>
            )}

            {canManage && (
              <TabsTrigger
                value="library"
                data-testid="tab-trigger-library"
                className="flex items-center gap-2 px-3 py-1.5 text-xs sm:text-sm"
              >
                <Library className="size-4" />
                <span>مكتبة الصور</span>
              </TabsTrigger>
            )}

            {canExport && (
              <TabsTrigger
                value="export"
                data-testid="tab-trigger-export"
                className="flex items-center gap-2 px-3 py-1.5 text-xs sm:text-sm"
              >
                <Download className="size-4" />
                <span>تصدير الصور</span>
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        {/* التبويب الأول: مسار التصوير السريع المستمر */}
        <TabsContent
          value="workflow"
          data-testid="tab-content-workflow"
          className="space-y-4"
        >
          <StudioContinuousWorkflow
            initialBarcode={barcodeParam}
            initialProductId={productIdParam}
          />
        </TabsContent>

        {/* التبويب الثاني: طابور الاعتماد والمراجعة (خاص بالإدارة) */}
        {canManage && (
          <TabsContent
            value="review"
            data-testid="tab-content-review"
            className="space-y-4"
          >
            <StudioAdminReviewPanel />
            <StudioTempPhotographerCard />
          </TabsContent>
        )}

        {/* التبويب الثالث: مكتبة الصور (خاص بالإدارة) */}
        {canManage && (
          <TabsContent
            value="library"
            data-testid="tab-content-library"
            className="space-y-4"
          >
            <StudioStandaloneImageManagerCard />
          </TabsContent>
        )}

        {/* التبويب الرابع: تصدير الصور (خاص بالمخولين بالتصدير) */}
        {canExport && (
          <TabsContent
            value="export"
            data-testid="tab-content-export"
            className="space-y-4"
          >
            <StudioImageExportPanel categories={categoriesQ.data ?? []} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
