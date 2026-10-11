import { lazyWithRetry as lazy } from "@/lib/lazyWithRetry";
import { type HubTab } from "@/components/PageTabs";
import { useLocation, useSearch } from "wouter";
import { useMemo, useState, useRef, useEffect, Suspense } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { canSeeGate } from "@/lib/navVisibility";
import { cn } from "@/lib/utils";
import {
  HeartHandshake,
  TrendingUp,
  Megaphone,
  Wallet,
  LayoutDashboard,
  Star,
  CheckCircle2,
  Clock,
  User,
  Phone,
  MessageSquare,
  AlertCircle,
  Plus,
  Gift,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { FeedbackModal } from "@/components/crm/FeedbackModal";
import { CustomerDossierDrawer } from "@/components/crm/CustomerDossierDrawer";
import { InstantGiftModal } from "@/components/crm/InstantGiftModal";
import { openWhatsApp, buildGoogleReviewInviteWhatsAppMessage } from "@/lib/whatsapp";
import { notify } from "@/lib/notify";
import {
  FEEDBACK_CATEGORY_LABELS,
  ROOT_CAUSE_STATION_LABELS,
  ISSUE_STATUS_LABELS,
  type FeedbackCategory,
  type RootCauseStation,
  type IssueStatus,
} from "@shared/customerFeedback";
import { ACTION_LABELS } from "@shared/actionLabels";

const CrmOverview = lazy(() => import("@/pages/CrmOverview"));
const Customers = lazy(() => import("@/pages/Customers"));
const CustomerNotes = lazy(() => import("@/pages/CustomerNotes"));
const Inbox = lazy(() => import("@/pages/Inbox"));
const ContactsBank = lazy(() => import("@/pages/ContactsBank"));
const Quotations = lazy(() => import("@/pages/Quotations"));
const Campaigns = lazy(() => import("@/pages/Campaigns"));
const WaBroadcasts = lazy(() => import("@/pages/WaBroadcasts"));
const Offers = lazy(() => import("@/pages/Offers"));
const Coupons = lazy(() => import("@/pages/Coupons"));
const ARReminders = lazy(() => import("@/pages/ARReminders"));
const CustomerStatement = lazy(() => import("@/pages/CustomerStatement"));
const ARAging = lazy(() => import("@/pages/ARAging"));
const InstallmentPlans = lazy(() => import("@/pages/InstallmentPlans"));
const ContractPrices = lazy(() => import("@/pages/ContractPrices"));
const SalesPipeline = lazy(() => import("@/pages/SalesPipeline"));

const PRINTING_STATIONS: Array<{
  id: string;
  label: string;
  stations: readonly string[];
}> = [
  { id: "ALL", label: "كافة المحطات", stations: [] },
  { id: "PREPRESS", label: "ما قبل الطباعة (Pre-press)", stations: ["DESIGN"] },
  { id: "PRINTING", label: "الطباعة (Printing)", stations: ["PRINTING"] },
  { id: "BINDING_LAMINATION", label: "التجليد والسلفنة (Binding & Lamination)", stations: ["LAMINATION", "CUTTING"] },
  { id: "DELIVERY", label: "الشحن والتسليم (Shipping & Delivery)", stations: ["DELIVERY"] },
  { id: "OTHER", label: "أخرى واستقبال", stations: ["RECEPTION", "OTHER"] },
];

function getStationBadgeInfo(station: string | null | undefined): { label: string; className: string } {
  if (!station) return { label: "محطة غير محددة", className: "bg-muted text-muted-foreground" };
  if (station === "DESIGN") {
    return {
      label: "ما قبل الطباعة (Pre-press)",
      className: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20",
    };
  }
  if (station === "PRINTING") {
    return {
      label: "الطباعة (Printing)",
      className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20",
    };
  }
  if (station === "LAMINATION" || station === "CUTTING") {
    return {
      label: "التجليد والسلفنة (Binding & Lamination)",
      className: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border border-[var(--sem-warn)]/20",
    };
  }
  if (station === "DELIVERY") {
    return {
      label: "الشحن والتسليم (Shipping & Delivery)",
      className: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border border-[var(--sem-pos)]/20",
    };
  }
  return {
    label: ROOT_CAUSE_STATION_LABELS[station as RootCauseStation] ?? station,
    className: "bg-accent text-muted-foreground",
  };
}

/**
 * مكون استعراض وإدارة الشكاوى ورضا الزبائن في جناح خدمة ورعاية الزبائن.
 */
function CustomerComplaintsView() {
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [stationFilter, setStationFilter] = useState<string>("ALL");
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [editingFeedback, setEditingFeedback] = useState<any>(null);
  const [dossierCustomerId, setDossierCustomerId] = useState<number | null>(null);
  const [giftCustomer, setGiftCustomer] = useState<{
    customerId: number;
    customerName: string;
    feedbackId?: number;
  } | null>(null);

  const feedbackQuery = trpc.customers.feedbackList.useQuery({ limit: 100 });
  const markGoogleInviteMut = trpc.customers.markGoogleReviewInviteSent.useMutation();
  const items = feedbackQuery.data ?? [];

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (statusFilter !== "ALL" && item.issueStatus !== statusFilter) {
        return false;
      }
      if (stationFilter !== "ALL") {
        const conf = PRINTING_STATIONS.find((s) => s.id === stationFilter);
        if (conf && conf.stations.length > 0) {
          if (
            !item.rootCauseStation ||
            !conf.stations.includes(item.rootCauseStation)
          ) {
            return false;
          }
        }
      }
      return true;
    });
  }, [items, statusFilter, stationFilter]);

  const metrics = useMemo(() => {
    if (items.length === 0) {
      return { total: 0, avgRating: "0.0", openCount: 0, resolvedCount: 0 };
    }
    const total = items.length;
    const sumRating = items.reduce((acc, curr) => acc + (curr.rating || 0), 0);
    const avgRating = (sumRating / total).toFixed(1);
    const openCount = items.filter(
      (i) => i.issueStatus === "NEW" || i.issueStatus === "IN_PROGRESS",
    ).length;
    const resolvedCount = items.filter(
      (i) => i.issueStatus === "RESOLVED" || i.issueStatus === "CLOSED",
    ).length;
    return { total, avgRating, openCount, resolvedCount };
  }, [items]);

  function handleSendGoogleReviewInvite(item: (typeof items)[number]) {
    const message = buildGoogleReviewInviteWhatsAppMessage({
      customerName: `زبون #${item.customerId}`,
    });
    openWhatsApp(null, message);
    markGoogleInviteMut.mutate(
      { customerId: item.customerId, feedbackId: item.id },
      {
        onSuccess: () => {
          notify.ok("تم فتح المحادثة وتسجيل إرسال دعوة التقييم بنجاح");
          feedbackQuery.refetch();
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-8">
      <PageHeader
        title="الشكاوى ومستوى رضا الزبائن"
        description="متابعة جودة الخدمة ورضا الزبائن ومعالجة الشكاوى التشغيلية المرتبطة بمحطات العمل والطباعة."
        actions={
          <Button
            type="button"
            onClick={() => {
              setEditingFeedback(null);
              setFeedbackModalOpen(true);
            }}
            className="flex items-center gap-2"
          >
            <Plus className="size-4" aria-hidden />
            <span>تسجيل تقييم أو شكوى</span>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="rounded-xl border border-border/80 shadow-xs">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Star className="size-5 fill-current" aria-hidden />
            </div>
            <div>
              <div className="text-xs text-muted-foreground">متوسط التقييم العام</div>
              <div className="text-2xl font-black">{metrics.avgRating} <span className="text-xs font-normal text-muted-foreground">/ 5</span></div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-border/80 shadow-xs">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <MessageSquare className="size-5" aria-hidden />
            </div>
            <div>
              <div className="text-xs text-muted-foreground">إجمالي التقييمات والشكاوى</div>
              <div className="text-2xl font-black">{metrics.total}</div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-border/80 shadow-xs">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex size-11 items-center justify-center rounded-xl bg-[var(--sem-warn)]/10 text-[var(--sem-warn)]">
              <Clock className="size-5" aria-hidden />
            </div>
            <div>
              <div className="text-xs text-muted-foreground">شكاوى قيد المتابعة</div>
              <div className="text-2xl font-black">{metrics.openCount}</div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl border border-border/80 shadow-xs">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex size-11 items-center justify-center rounded-xl bg-[var(--sem-pos)]/10 text-[var(--sem-pos)]">
              <CheckCircle2 className="size-5" aria-hidden />
            </div>
            <div>
              <div className="text-xs text-muted-foreground">شكاوى تم حلها بنجاح</div>
              <div className="text-2xl font-black">{metrics.resolvedCount}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* شريط الفلاتر: فلاتر محطات الطباعة وفلاتر حالات الشكاوى */}
      <Card className="border-border/70 shadow-xs">
        <CardContent className="space-y-3 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">محطة الطباعة والعمل:</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {PRINTING_STATIONS.map((station) => (
                  <Button
                    key={station.id}
                    type="button"
                    variant={stationFilter === station.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => setStationFilter(station.id)}
                    className="text-xs h-8"
                  >
                    {station.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">حالة الشكوى:</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { id: "ALL", label: "كافة الحالات" },
                  { id: "NEW", label: "جديدة" },
                  { id: "IN_PROGRESS", label: "قيد المعالجة" },
                  { id: "RESOLVED", label: "تم الحل والتعويض" },
                  { id: "CLOSED", label: "مغلقة" },
                ].map((status) => (
                  <Button
                    key={status.id}
                    type="button"
                    variant={statusFilter === status.id ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setStatusFilter(status.id)}
                    className="text-xs h-7"
                  >
                    {status.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              عدد السجلات المعروضة: {filteredItems.length}
            </div>
          </div>
        </CardContent>
      </Card>

      {feedbackQuery.isLoading ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          جارٍ تحميل سجلات الشكاوى والتقييمات...
        </div>
      ) : filteredItems.length === 0 ? (
        <Card className="rounded-xl border border-dashed p-10 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground mb-3">
            <CheckCircle2 className="size-6" aria-hidden />
          </div>
          <div className="text-sm font-semibold">لا توجد شكاوى أو تقييمات مطابقة</div>
          <p className="text-xs text-muted-foreground mt-1">
            كافة تعاملات الزبائن مستقرة أو لم يتم تسجيل ملاحظات في هذا التصنيف.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredItems.map((item) => {
            const categoryLabel =
              FEEDBACK_CATEGORY_LABELS[item.category as FeedbackCategory] ?? item.category;
            const stationBadge = getStationBadgeInfo(item.rootCauseStation);
            const statusLabel =
              ISSUE_STATUS_LABELS[item.issueStatus as IssueStatus] ?? item.issueStatus;
            const isSatisfied = item.rating >= 4;

            return (
              <Card key={item.id} className="rounded-xl border border-border/80 shadow-xs transition hover:border-primary/40 flex flex-col justify-between">
                <CardContent className="p-4 space-y-3 flex-1 flex flex-col justify-between">
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Star
                            key={i}
                            className={cn(
                              "size-3.5",
                              i < item.rating
                                ? "fill-primary text-primary"
                                : "text-muted-foreground/30",
                            )}
                            aria-hidden
                          />
                        ))}
                      </div>
                      <Badge
                        variant={
                          item.issueStatus === "NEW"
                            ? "destructive"
                            : item.issueStatus === "IN_PROGRESS"
                              ? "secondary"
                              : "outline"
                        }
                        className="text-[10px]"
                      >
                        {statusLabel}
                      </Badge>
                    </div>

                    <div>
                      <div className="font-semibold text-sm truncate">
                        زبون #{item.customerId}
                        {item.workOrderNumber ? ` • أمر شغل #${item.workOrderNumber}` : ""}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <span className="rounded-md bg-accent px-2 py-0.5 text-muted-foreground">
                        {categoryLabel}
                      </span>
                      <span className={cn("rounded-md px-2 py-0.5 font-medium", stationBadge.className)}>
                        {stationBadge.label}
                      </span>
                    </div>

                    {item.comment && (
                      <p className="text-xs text-muted-foreground line-clamp-2 bg-muted/40 p-2 rounded-lg">
                        {item.comment}
                      </p>
                    )}

                    {/* شارات إضافية: كوبون الترضية أو دعوة تقييم خرائط Google */}
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {item.giftCouponCode && (
                        <Badge variant="outline" className="text-[10px] text-[var(--sem-warn)] border-[var(--sem-warn)]/30 gap-1 bg-[var(--sem-warn-bg)]">
                          <Gift className="size-3" aria-hidden />
                          <span>كوبون ترضية: #{item.giftCouponCode}</span>
                        </Badge>
                      )}
                      {item.googleReviewInviteSent && (
                        <Badge variant="outline" className="text-[10px] text-[var(--sem-pos)] border-[var(--sem-pos)]/30 gap-1 bg-[var(--sem-pos-bg)]">
                          <CheckCircle2 className="size-3" aria-hidden />
                          <span>تم إرسال دعوة Google</span>
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* الإجراءات التشغيلية المباشرة */}
                  <div className="flex flex-wrap items-center justify-between gap-1 border-t border-border/60 pt-2.5 mt-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDossierCustomerId(item.customerId)}
                      className="h-8 text-xs text-primary"
                    >
                      <User className="size-3.5 me-1" aria-hidden />
                      <span>الملف الشامل 360°</span>
                    </Button>

                    <div className="flex items-center gap-1">
                      {/* إجراء سريع: دعوة Google للزبون الراضي */}
                      {isSatisfied && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleSendGoogleReviewInvite(item)}
                          className="h-8 text-xs gap-1 border-[var(--sem-pos)]/40 text-[var(--sem-pos)] hover:bg-accent"
                          title="إرسال دعوة تقييم Google عبر واتساب"
                        >
                          <MessageSquare className="size-3.5" aria-hidden />
                          <span>دعوة Google</span>
                        </Button>
                      )}

                      {/* إجراء سريع: كوبون ترضية فوري في حالات الشكاوى أو التقييم المنخفض */}
                      {!isSatisfied && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setGiftCustomer({
                              customerId: item.customerId,
                              customerName: `زبون #${item.customerId}`,
                              feedbackId: item.id,
                            });
                          }}
                          className="h-8 text-xs gap-1 border-[var(--sem-warn)]/40 text-[var(--sem-warn)] hover:bg-accent"
                          title="إصدار قسيمة هدية فورية للترضية"
                        >
                          <Gift className="size-3.5" aria-hidden />
                          <span>{item.giftCouponCode ? "قسيمة إضافية" : "إهداء كوبون"}</span>
                        </Button>
                      )}

                      {/* متابعة أو تحديث حالة الشكوى */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingFeedback(item);
                          setFeedbackModalOpen(true);
                        }}
                        className="h-8 text-xs text-muted-foreground hover:text-foreground"
                        title="معالجة وتحديث حالة الشكوى"
                      >
                        <Clock className="size-3.5 me-1" aria-hidden />
                        <span>معالجة</span>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <FeedbackModal
        open={feedbackModalOpen}
        onClose={() => {
          setFeedbackModalOpen(false);
          setEditingFeedback(null);
        }}
        customerId={editingFeedback?.customerId ?? dossierCustomerId ?? 1}
        customerName={editingFeedback ? `زبون #${editingFeedback.customerId}` : "زبون"}
        existingFeedback={
          editingFeedback
            ? {
                id: editingFeedback.id,
                rating: editingFeedback.rating,
                category: editingFeedback.category,
                comment: editingFeedback.comment,
                issueStatus: editingFeedback.issueStatus,
                rootCauseStation: editingFeedback.rootCauseStation,
                resolutionAction: editingFeedback.resolutionAction,
              }
            : null
        }
        onSuccess={() => {
          feedbackQuery.refetch();
          setFeedbackModalOpen(false);
          setEditingFeedback(null);
        }}
      />

      {giftCustomer && (
        <InstantGiftModal
          open={Boolean(giftCustomer)}
          onClose={() => setGiftCustomer(null)}
          customerId={giftCustomer.customerId}
          customerName={giftCustomer.customerName}
          feedbackId={giftCustomer.feedbackId}
          onSuccess={() => {
            feedbackQuery.refetch();
            setGiftCustomer(null);
          }}
        />
      )}

      {dossierCustomerId && (
        <CustomerDossierDrawer
          customerId={dossierCustomerId}
          open={Boolean(dossierCustomerId)}
          onClose={() => setDossierCustomerId(null)}
        />
      )}
    </div>
  );
}

// مرآة reportViewerProcedure: الدور خارج القائمة يحتاج منح reports صريحاً، لا قالباً افتراضياً.
const REPORT_VIEWER_GATE: NonNullable<HubTab["gate"]> = {
  roles: ["manager", "accountant", "auditor"],
  module: "reports",
  level: "READ",
};

// 1. جناح خدمة ورعاية الزبائن (Care)
const CARE_TABS: HubTab[] = [
  { value: "customers", label: "قائمة الزبائن", gate: { module: "crm", level: "READ" }, Component: Customers },
  { value: "complaints", label: "الشكاوى ورضا الزبائن", gate: { module: "crm", level: "READ" }, Component: CustomerComplaintsView },
  { value: "followups", label: "الملاحظات والمتابعات", gate: { module: "crm", level: "READ" }, Component: CustomerNotes },
  { value: "contacts", label: "دليل أرقام وهواتف الزبائن", gate: { module: "crm", level: "READ" }, Component: ContactsBank },
  { value: "inbox", label: "التواصل والوارد", gate: { module: "channels", level: "READ" }, Component: Inbox },
];

// 2. جناح المبيعات وعروض الأسعار (Sales)
const SALES_TABS: HubTab[] = [
  { value: "quotations", label: "عروض الأسعار والمقايسات", gate: { module: "sales", level: "READ" }, Component: Quotations },
  { value: "pipeline", label: "متابعة الصفقات والطلبات", gate: { module: "crm", level: "READ" }, Component: SalesPipeline },
  { value: "contracts", label: "أسعار خاصة وعقود الشركات", gate: { managerOnly: true }, Component: ContractPrices },
];

// 3. جناح التسويق والكوبونات والولاء (Marketing)
const MARKETING_TABS: HubTab[] = [
  { value: "campaigns", label: "الحملات الإعلانية", gate: { module: "campaigns", level: "READ" }, Component: Campaigns },
  { value: "broadcasts", label: "رسائل الواتساب الجماعية", gate: { module: "campaigns", level: "READ" }, Component: WaBroadcasts },
  { value: "offers", label: "العروض والتخفيضات", gate: { module: "campaigns", level: "READ" }, Component: Offers },
  { value: "coupons", label: "الكوبونات وقسائم الهدايا", gate: { module: "campaigns", level: "READ" }, Component: Coupons },
];

// 4. جناح الحسابات والديون والتحصيل (Finance)
const FINANCE_TABS: HubTab[] = [
  { value: "statement", label: "كشف حساب الزبون", gate: REPORT_VIEWER_GATE, Component: CustomerStatement },
  { value: "collections", label: "تذكيرات سداد الديون", gate: { module: "collections", level: "FULL" }, Component: ARReminders },
  { value: "aging", label: "متابعة الديون المتأخرة", gate: REPORT_VIEWER_GATE, Component: ARAging },
  { value: "installments", label: "الأقساط الشهرية", gate: { module: "treasury", level: "READ" }, Component: InstallmentPlans },
];

// 5. لوحة المتابعة العامة (Overview)
const OVERVIEW_TABS: HubTab[] = [
  { value: "overview", label: "لوحة المتابعة العامة", gate: { module: "campaigns", level: "READ" }, Component: CrmOverview },
];

// المصفوفة الكلية لحفظ عقود الاختبارات والرجوع
const TABS: HubTab[] = [
  ...OVERVIEW_TABS,
  ...CARE_TABS,
  ...SALES_TABS,
  ...MARKETING_TABS,
  ...FINANCE_TABS,
];

export type CrmWingId = "care" | "sales" | "marketing" | "finance" | "overview";

const WING_CONFIGS: readonly {
  id: CrmWingId;
  label: string;
  defaultTab: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "care", label: "خدمة ورعاية الزبائن", defaultTab: "customers", icon: HeartHandshake },
  { id: "sales", label: "المبيعات وعروض الأسعار", defaultTab: "quotations", icon: TrendingUp },
  { id: "marketing", label: "التسويق والكوبونات والولاء", defaultTab: "campaigns", icon: Megaphone },
  { id: "finance", label: "الحسابات والديون والتحصيل", defaultTab: "statement", icon: Wallet },
  { id: "overview", label: "لوحة المتابعة", defaultTab: "overview", icon: LayoutDashboard },
] as const;

const TAB_TO_WING: Record<string, CrmWingId> = {
  customers: "care",
  complaints: "care",
  followups: "care",
  contacts: "care",
  inbox: "care",
  quotations: "sales",
  pipeline: "sales",
  contracts: "sales",
  campaigns: "marketing",
  broadcasts: "marketing",
  offers: "marketing",
  coupons: "marketing",
  statement: "finance",
  collections: "finance",
  aging: "finance",
  installments: "finance",
  overview: "overview",
};

function TabFallback() {
  return <div className="p-10 text-center text-muted-foreground">{ACTION_LABELS.loading}</div>;
}

const tabClass = cn(
  "inline-flex h-11 shrink-0 cursor-pointer select-none items-center gap-2 rounded-xl border px-4",
  "text-sm font-semibold whitespace-nowrap outline-none transition-all duration-200 ease-out",
  "border-border bg-card text-muted-foreground shadow-xs",
  "hover:border-primary/40 hover:bg-accent hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  "active:scale-[0.97]",
  "data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm data-[state=active]:hover:bg-primary",
);

function CrmWingTabs({
  tabs,
  ariaLabel,
  activeWing,
  activeWingLabel,
  currentTab,
  onSelectWing,
  onSelectTab,
}: {
  tabs: HubTab[];
  ariaLabel?: string;
  activeWing: CrmWingId;
  activeWingLabel: string;
  currentTab: string | null;
  onSelectWing: (wing: CrmWingId) => void;
  onSelectTab: (tab: string) => void;
}) {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role;
  const permsOverride = (me.data?.permissionsOverride ?? null) as
    | import("@shared/permissions").PermissionMap
    | null;

  const visible = tabs.filter((t) => canSeeGate(t.gate, role, permsOverride));
  const active = visible.find((t) => t.value === currentTab) ?? visible[0];
  const activeTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      activeTriggerRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active?.value]);

  if (visible.length === 0) {
    return (
      <Card className="mx-auto max-w-2xl rounded-2xl border border-dashed border-border/80 bg-card/60 p-8 text-center shadow-xs">
        <CardContent className="flex flex-col items-center gap-4 p-0">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground shadow-xs">
            <AlertCircle className="size-7" aria-hidden />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-base font-bold text-foreground">
              لا تتوفر صلاحيات لعرض هذا القسم
            </h3>
            <p className="max-w-md text-xs sm:text-sm text-muted-foreground leading-relaxed">
              يتطلب قسم «{activeWingLabel}» صلاحيات وصول غير مفعّلة لحسابك الحالي. يمكنك الانتقال إلى الأقسام المتاحة أو العودة للوحة المتابعة.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <Button
              type="button"
              variant="default"
              onClick={() => onSelectWing("care")}
              className="flex items-center gap-2 text-xs"
            >
              <HeartHandshake className="size-3.5" aria-hidden />
              <span>خدمة ورعاية الزبائن</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onSelectWing("overview")}
              className="flex items-center gap-2 text-xs"
            >
              <LayoutDashboard className="size-3.5" aria-hidden />
              <span>لوحة المتابعة</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <TabsPrimitive.Root
      value={active.value}
      onValueChange={onSelectTab}
      dir="rtl"
      className="min-w-0 max-w-full space-y-4 overflow-x-hidden"
    >
      <div className="flex items-start gap-3">
        <TabsPrimitive.List
          aria-label={ariaLabel}
          className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto px-1 pb-1.5 scroll-px-1 [scrollbar-width:none] md:flex-wrap md:overflow-x-visible [&::-webkit-scrollbar]:hidden"
        >
          {visible.map((t) => (
            <TabsPrimitive.Trigger
              key={t.value}
              ref={t.value === active.value ? activeTriggerRef : undefined}
              value={t.value}
              className={tabClass}
            >
              {t.label}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
      </div>
      {visible.map((t) => {
        const Active = t.Component;
        return (
          <TabsPrimitive.Content key={t.value} value={t.value} className="outline-none">
            <Suspense fallback={<TabFallback />}>
              <Active />
            </Suspense>
          </TabsPrimitive.Content>
        );
      })}
    </TabsPrimitive.Root>
  );
}

export default function CrmHub() {
  const [loc, navigate] = useLocation();
  const search = useSearch();

  const queryParams = useMemo(() => new URLSearchParams(search), [search]);
  const rawWing = queryParams.get("wing") as CrmWingId | null;
  const rawTab = queryParams.get("tab");

  // حل الجناح التلقائي: التبويب المحدد يغلب إذا كان ينتمي لجناح معروف، لتصحيح التضارب تلقائياً
  const activeWing: CrmWingId = useMemo(() => {
    if (rawTab && TAB_TO_WING[rawTab]) {
      return TAB_TO_WING[rawTab];
    }
    if (rawWing && (WING_CONFIGS.some((w) => w.id === rawWing))) {
      return rawWing;
    }
    return "overview";
  }, [rawWing, rawTab]);

  const activeWingConfig =
    WING_CONFIGS.find((w) => w.id === activeWing) ?? WING_CONFIGS[0];

  const handleSelectWing = (wingId: CrmWingId) => {
    const params = new URLSearchParams(search);
    params.set("wing", wingId);
    const targetConfig = WING_CONFIGS.find((w) => w.id === wingId);
    if (wingId === "overview") {
      params.delete("tab");
    } else if (targetConfig) {
      params.set("tab", targetConfig.defaultTab);
    }
    const qs = params.toString();
    navigate(qs ? `${loc}?${qs}` : loc);
  };

  const handleSelectTab = (tabValue: string) => {
    const params = new URLSearchParams(search);
    params.set("wing", activeWing);
    params.set("tab", tabValue);
    const qs = params.toString();
    navigate(qs ? `${loc}?${qs}` : loc);
  };

  const activeWingTabs = useMemo(() => {
    switch (activeWing) {
      case "care":
        return CARE_TABS;
      case "sales":
        return SALES_TABS;
      case "marketing":
        return MARKETING_TABS;
      case "finance":
        return FINANCE_TABS;
      default:
        return OVERVIEW_TABS;
    }
  }, [activeWing]);

  return (
    <div className="space-y-4">
      {/* المستوى الأول: مبدل الأجنحة الوظيفية الأربعة + لوحة المتابعة */}
      <div className="mx-auto max-w-7xl px-2 sm:px-4">
        <div
          role="tablist"
          aria-label="أجنحة إدارة العملاء والعمليات"
          className="flex flex-wrap items-center gap-1.5 sm:gap-2 rounded-2xl border border-border/70 bg-card/60 p-1.5 sm:p-2 shadow-xs backdrop-blur-sm"
        >
          {WING_CONFIGS.map((wing) => {
            const WingIcon = wing.icon;
            const isSelected = activeWing === wing.id;
            return (
              <button
                key={wing.id}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => handleSelectWing(wing.id)}
                className={cn(
                  "inline-flex h-11 flex-1 min-w-[130px] sm:min-w-[150px] items-center justify-center gap-2 rounded-xl px-3 text-xs sm:text-sm font-semibold transition-all duration-200 select-none cursor-pointer outline-none",
                  isSelected
                    ? "border border-primary bg-primary text-primary-foreground shadow-sm"
                    : "border border-transparent bg-transparent text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                )}
              >
                <WingIcon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{wing.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* المستوى الثاني: التبويبات المتخصصة الحصرية للجناح المختار */}
      {activeWing === "overview" ? (
        <CrmOverview />
      ) : (
        <CrmWingTabs
          key={activeWing}
          tabs={activeWingTabs}
          ariaLabel={`أقسام ${activeWingConfig.label}`}
          activeWing={activeWing}
          activeWingLabel={activeWingConfig.label}
          currentTab={rawTab}
          onSelectWing={handleSelectWing}
          onSelectTab={handleSelectTab}
        />
      )}
    </div>
  );
}
