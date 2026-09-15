import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { RefreshCw, Image as ImageIcon, AlertTriangle, Search, FolderKanban, Library } from "lucide-react";
import { StudioImageExportPanel } from "@/components/product-studio/StudioImageExportPanel";
import { StudioStandaloneImageManagerCard } from "@/components/product-studio/StudioStandaloneImageManagerCard";
import { StudioImageDiscoveryPanel } from "@/components/product-studio/StudioImageDiscoveryPanel";
import { StudioCampaignsPanel } from "@/components/product-studio/StudioCampaignsPanel";
import { StudioManualTaskCreator } from "@/components/product-studio/StudioManualTaskCreator";
import { StudioTaskQueue } from "@/components/product-studio/StudioTaskQueue";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { STUDIO_STORAGE_DISABLED_MESSAGE } from "@/pages/ProductImageStudio";
import { studioOfflineCapabilities } from "@/lib/productStudio/coldOfflinePolicy";
import { useState } from "react";

export default function StudioManagerDashboard({
  offline,
  dashboardData,
}: {
  offline: boolean;
  dashboardData: any;
}) {
  const utils = trpc.useUtils();
  const [prefilledProductIds, setPrefilledProductIds] = useState<number[]>([]);
  const [prefilledCategoryId, setPrefilledCategoryId] = useState<number | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState("overview");

  const capabilities = studioOfflineCapabilities({
    offline,
    storageReady: dashboardData?.storageReady,
  });
  
  const storageActionsDisabled = !capabilities.canUseProviderOrStorage;
  const counts = dashboardData?.counts;

  return (
    <div className="min-w-0 space-y-4 overflow-x-hidden p-4 md:p-6">
      <PageHeader
        title="استوديو المنتجات (الإدارة)"
        description="مركز مستقل للصور والمحتوى: إسناد، تنفيذ، مراجعة، واعتماد."
        icon={<ImageIcon aria-hidden className="size-6" />}
        actions={
          <Button variant="outline" size="sm" disabled={!capabilities.canCallServer} onClick={() => utils.productStudio.invalidate()}>
            <RefreshCw aria-hidden className="size-4" /> تحديث
          </Button>
        }
      />

      {storageActionsDisabled && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] p-3 text-sm text-[var(--sem-warn)]">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{STUDIO_STORAGE_DISABLED_MESSAGE}</span>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 lg:w-[600px]">
          <TabsTrigger value="overview" className="flex items-center gap-2">
            <Search className="size-4" />
            <span className="hidden sm:inline">الكشف الذكي والمؤشرات</span>
            <span className="sm:hidden">الكشف</span>
          </TabsTrigger>
          <TabsTrigger value="campaigns" className="flex items-center gap-2">
            <FolderKanban className="size-4" />
            <span className="hidden sm:inline">إدارة الحملات والمهام</span>
            <span className="sm:hidden">الحملات</span>
          </TabsTrigger>
          <TabsTrigger value="library" className="flex items-center gap-2">
            <Library className="size-4" />
            <span className="hidden sm:inline">المكتبة والتصدير</span>
            <span className="sm:hidden">المكتبة</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">المهام النشطة</div>
                <div className="mt-0.5 text-xl font-bold">{dashboardData?.active ?? 0}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">قيد العمل</div>
                <div className="mt-0.5 text-xl font-bold">{dashboardData?.inProgress ?? 0}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">بانتظار المراجعة</div>
                <div className="mt-0.5 text-xl font-bold">{counts?.PENDING_REVIEW ?? 0}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <div className="text-xs text-muted-foreground">المعتمدة</div>
                <div className="mt-0.5 text-xl font-bold">{counts?.APPROVED ?? 0}</div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-1 pt-3">
              <CardTitle className="text-xs font-medium text-muted-foreground">صحّة الطابور الإدارية</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 pb-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["غير المسندة", dashboardData?.unassigned ?? "—"],
                ["المتأخرة", dashboardData?.overdue ?? 0],
                ["منها بلا منفّذ", dashboardData?.overdueUnassigned ?? "—"],
                ["مرفوضة (تنتظر التصحيح)", dashboardData?.rejected ?? 0],
                ["المنجزة اليوم", dashboardData?.completedToday ?? 0],
                [`وسيط زمن الدورة (${dashboardData?.medianCycleWindowDays ?? 0} يوماً)`, dashboardData?.medianCycleMinutes == null ? "—" : `${dashboardData.medianCycleMinutes} د`],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-md border bg-muted/20 p-2">
                  <div className="truncate text-[11px] text-muted-foreground">{label}</div>
                  <div className="mt-0.5 text-base font-bold">{value}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          {!offline && (
            <StudioImageDiscoveryPanel
              onCreateCampaignFromProducts={(productIds) => {
                setPrefilledProductIds(productIds);
                setPrefilledCategoryId(null);
                notify.ok(`تم تجهيز ${productIds.length} منتج لإنشاء الحملة.`);
                setActiveTab("campaigns");
                setTimeout(() => document.getElementById("new-campaign")?.scrollIntoView({ behavior: "smooth" }), 100);
              }}
              onCreateCampaignFromCategory={(categoryId) => {
                setPrefilledCategoryId(categoryId);
                setPrefilledProductIds([]);
                notify.ok(`تم تجهيز الفئة لإنشاء الحملة.`);
                setActiveTab("campaigns");
                setTimeout(() => document.getElementById("new-campaign")?.scrollIntoView({ behavior: "smooth" }), 100);
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="campaigns" className="space-y-4">
          <StudioCampaignsPanel
            offline={offline}
            branchId={dashboardData?.branchId}
            selectedCampaignId={selectedCampaignId}
            prefilledProductIds={prefilledProductIds}
            prefilledCategoryId={prefilledCategoryId}
            onPrefillConsumed={() => {
              setPrefilledProductIds([]);
              setPrefilledCategoryId(null);
            }}
          />
          <StudioManualTaskCreator offline={offline} storageActionsDisabled={storageActionsDisabled} />
          <StudioTaskQueue 
            offline={offline} 
            canManage={true} 
            initialSelectedCampaignId={selectedCampaignId}
            onCampaignSelect={setSelectedCampaignId}
          />
        </TabsContent>

        <TabsContent value="library" className="space-y-4">
          {!offline && <StudioStandaloneImageManagerCard />}
          {!offline && <StudioImageExportPanel categories={[]} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
