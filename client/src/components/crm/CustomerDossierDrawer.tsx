/**
 * الملف الشامل للعميل 360° (Customer 360° Dossier Drawer)
 * يعرض بطاقة الاتصال، المؤشرات المالية، مؤشرات الجودة والرضا،
 * والتغذية العكسية، والكوبونات، والخط الزمني للمعاملات، مع إرشادات الذكاء التشغيلي.
 *
 * صفر إيموجي — يعتمد أيقونات lucide-react حصراً (حارس check:emoji).
 */

import { useState } from "react";
import { Link } from "wouter";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { fmtAr as fmt } from "@/lib/money";
import { fmtDate } from "@/lib/date";
import { notify } from "@/lib/notify";
import {
  openWhatsApp,
  preferredWhatsAppPhone,
  buildGoogleReviewInviteWhatsAppMessage,
  buildInstantGiftWhatsAppMessage,
} from "@/lib/whatsapp";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { workOrderStatusLabel } from "@shared/workOrderStatus";
import { printGiftVoucherDoc } from "@/lib/printing/giftVoucherPrint";
import { CustomerRadarBadges } from "./CustomerRadarBadges";
import { InstantGiftModal } from "./InstantGiftModal";
import { FeedbackModal } from "./FeedbackModal";
import {
  Phone,
  PhoneCall,
  MessageSquare,
  MessageSquarePlus,
  Gift,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Printer,
  Star,
  FileText,
  ExternalLink,
  Share2,
  Receipt,
  Calendar,
  Sparkles,
  MapPin,
  RotateCcw,
  Check,
  Building2,
  Loader2,
  AlertCircle,
} from "lucide-react";

import {
  FEEDBACK_CATEGORY_LABELS,
  type FeedbackCategory,
  ISSUE_STATUS_LABELS,
  type IssueStatus,
  ROOT_CAUSE_STATION_LABELS,
  type RootCauseStation,
} from "@shared/customerFeedback";
import {
  hasModuleAccess,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";

export interface CustomerDossierDrawerProps {
  customerId: number | null;
  open: boolean;
  onClose: () => void;
}

const STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  NEW: "destructive",
  IN_PROGRESS: "secondary",
  RESOLVED: "default",
  CLOSED: "outline",
};

export function CustomerDossierDrawer({
  customerId,
  open,
  onClose,
}: CustomerDossierDrawerProps) {
  const [giftModalOpen, setGiftModalOpen] = useState(false);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [targetFeedbackId, setTargetFeedbackId] = useState<number | undefined>(
    undefined,
  );
  const [targetWorkOrderId, setTargetWorkOrderId] = useState<
    number | undefined
  >(undefined);
  const [targetWorkOrderNumber, setTargetWorkOrderNumber] = useState<
    string | undefined
  >(undefined);

  const utils = trpc.useUtils();

  const dossierQuery = trpc.customers.dossier360.useQuery(
    { customerId: customerId! },
    { enabled: open && customerId != null && customerId > 0 },
  );

  const updateStatusMutation = trpc.customers.updateFeedbackStatus.useMutation({
    onSuccess: () => {
      notify.ok("تم تحديث حالة الشكوى بنجاح");
      utils.customers.dossier360.invalidate({ customerId: customerId! });
      utils.customers.feedbackList.invalidate();
    },
    onError: (err) => {
      notify.err(err.message || "فشل تحديث حالة الشكوى");
    },
  });

  const markGoogleReviewMutation =
    trpc.customers.markGoogleReviewInviteSent.useMutation({
      onSuccess: () => {
        notify.ok("تم تسجيل إرسال دعوة التقييم عبر واتساب");
        utils.customers.dossier360.invalidate({ customerId: customerId! });
      },
    });

  const me = trpc.auth.me.useQuery();
  const role = me.data?.role as RoleKey | undefined;
  const override = (me.data?.permissionsOverride ??
    null) as PermissionMap | null;
  const canReadReports =
    !!role &&
    (role === "admin" || hasModuleAccess(role, override, "reports", "READ"));

  const dossier = dossierQuery.data;
  const customer = dossier?.customer;
  const metrics = dossier?.metrics;

  const latestFiveStarFeedback =
    dossier?.recentFeedback?.find(
      (f) => f.rating === 5 && !f.googleReviewInviteSent,
    ) || dossier?.recentFeedback?.find((f) => f.rating === 5);

  const handleSendGoogleReviewInvite = (feedbackId?: number) => {
    if (!customer) return;
    const phone = preferredWhatsAppPhone(customer.whatsapp, customer.phone);
    if (!phone) {
      notify.err("لا يوجد رقم هاتف أو واتساب مسجل لهذا الزبون");
      return;
    }

    const message = buildGoogleReviewInviteWhatsAppMessage({
      customerName: customer.name,
    });

    openWhatsApp(phone, message);

    markGoogleReviewMutation.mutate({
      customerId: customer.id,
      feedbackId,
    });
  };

  const handlePrintCoupon = async (coupon: {
    code: string;
    discountAmount?: string | number | null;
    programName?: string | null;
    validTo?: string | Date | null;
  }) => {
    if (!customer) return;
    try {
      const res = await printGiftVoucherDoc({
        couponCode: coupon.code,
        amount:
          coupon.discountAmount != null && coupon.discountAmount !== ""
            ? String(coupon.discountAmount)
            : "10000",
        customerName: customer.name,
        customerPhone:
          preferredWhatsAppPhone(customer.whatsapp, customer.phone) ||
          customer.phone ||
          customer.whatsapp,
        reason: coupon.programName || undefined,
        validUntil: coupon.validTo ? fmtDate(coupon.validTo) : undefined,
        terms: "تُخصم لمرة واحدة على أي فاتورة مبيعات أو أمر شغل داخل فروعنا.",
      });
      if (res && !res.ok) {
        if (res.reason === "popup-blocked") {
          notify.err("تم حظر نافذة الطباعة من قبل المتصفح، يرجى السماح بالنوافذ المنبثقة للموقع");
        } else {
          notify.err("تعذر إرسال القسيمة إلى الطابعة");
        }
        return;
      }
      notify.ok("تم إرسال قسيمة الهدية للطباعة");
    } catch {
      notify.err("تعذر إرسال القسيمة إلى الطابعة");
    }
  };

  const handleSendCouponWhatsApp = (coupon: {
    code: string;
    discountAmount?: string | number | null;
    programName?: string | null;
    validTo?: string | Date | null;
  }) => {
    if (!customer) return;
    const phone = preferredWhatsAppPhone(customer.whatsapp, customer.phone);
    if (!phone) {
      notify.err("لا يوجد رقم هاتف أو واتساب مسجل لهذا الزبون");
      return;
    }
    const message = buildInstantGiftWhatsAppMessage({
      customerName: customer.name,
      code: coupon.code,
      amount:
        coupon.discountAmount != null && coupon.discountAmount !== ""
          ? String(coupon.discountAmount)
          : "10000",
      reason: coupon.programName || undefined,
      validUntil: coupon.validTo ? fmtDate(coupon.validTo) : undefined,
    });
    openWhatsApp(phone, message);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
        <SheetContent
          side="right"
          dir="rtl"
          className="w-full sm:max-w-2xl overflow-y-auto p-4 sm:p-6"
        >
          <SheetHeader className="pb-3 border-b space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <SheetTitle className="text-xl font-bold flex items-center gap-2">
                  <Building2 aria-hidden className="size-5 text-primary" />
                  <span>{customer?.name || "الملف الشامل 360°"}</span>
                </SheetTitle>
                <SheetDescription className="text-xs text-muted-foreground mt-0.5">
                  رقم الزبون: #{customerId} · {customer?.customerType || "عميل"}{" "}
                  {customer?.defaultPriceTier
                    ? `(${customer.defaultPriceTier})`
                    : ""}
                </SheetDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs"
                  onClick={() => dossierQuery.refetch()}
                  disabled={dossierQuery.isFetching}
                >
                  <RotateCcw
                    aria-hidden
                    className={`size-3.5 ${dossierQuery.isFetching ? "animate-spin" : ""}`}
                  />
                  <span>تحديث</span>
                </Button>
              </div>
            </div>

            {/* شارات الرادار */}
            {metrics?.badges && (
              <div className="pt-1">
                <CustomerRadarBadges badges={metrics.badges} />
              </div>
            )}
          </SheetHeader>

          {dossierQuery.isLoading && (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
              <Loader2
                aria-hidden
                className="size-8 animate-spin text-primary"
              />
              <span className="text-sm">
                جاري تحميل بيانات الملف الشامل 360°...
              </span>
            </div>
          )}

          {dossierQuery.isError && (
            <div className="p-6 text-center text-destructive space-y-3">
              <AlertCircle aria-hidden className="size-8 mx-auto" />
              <p className="text-sm font-medium">تعذر تحميل بيانات العميل</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => dossierQuery.refetch()}
              >
                إعادة المحاولة
              </Button>
            </div>
          )}

          {customer && metrics && (
            <div className="mt-4 space-y-5">
              {/* شريط الإرشاد الذكي من Gemini / المحرك التشغيلي */}
              {dossier?.smartGuidance && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3.5 flex items-start gap-3">
                  <div className="p-1.5 rounded-md bg-primary/10 text-primary shrink-0 mt-0.5">
                    <Sparkles aria-hidden className="size-4" />
                  </div>
                  <div className="space-y-1 text-xs leading-relaxed">
                    <div className="font-semibold text-primary">
                      إرشاد الذكاء التشغيلي الموصى به:
                    </div>
                    <div className="text-foreground/90">
                      {dossier.smartGuidance}
                    </div>
                  </div>
                </div>
              )}

              {/* أزرار الإجراءات الفورية السريعة */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs justify-start border-amber-300 dark:border-amber-700/50 bg-amber-500/10 text-amber-900 dark:text-amber-300 hover:bg-amber-500/20"
                  onClick={() => {
                    setTargetFeedbackId(undefined);
                    setGiftModalOpen(true);
                  }}
                >
                  <Gift
                    aria-hidden
                    className="size-3.5 text-amber-600 shrink-0"
                  />
                  <span>إهداء فوري</span>
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs justify-start border-rose-300 dark:border-rose-700/50 bg-rose-500/10 text-rose-900 dark:text-rose-300 hover:bg-rose-500/20"
                  onClick={() => {
                    setTargetFeedbackId(undefined);
                    setTargetWorkOrderId(undefined);
                    setFeedbackModalOpen(true);
                  }}
                >
                  <AlertTriangle
                    aria-hidden
                    className="size-3.5 text-rose-600 shrink-0"
                  />
                  <span>تسجيل تقييم</span>
                </Button>

                {canReadReports ? (
                  <Link href={`/customers-statement?id=${customer.id}`}>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full gap-1.5 text-xs justify-start"
                    >
                      <FileText
                        aria-hidden
                        className="size-3.5 text-blue-600 shrink-0"
                      />
                      <span>كشف الحساب</span>
                    </Button>
                  </Link>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled
                    title="كشف الحساب يتطلب صلاحية التقارير"
                    className="w-full gap-1.5 text-xs justify-start opacity-50 cursor-not-allowed"
                  >
                    <FileText
                      aria-hidden
                      className="size-3.5 text-muted-foreground shrink-0"
                    />
                    <span>كشف الحساب</span>
                  </Button>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs justify-start border-emerald-300 dark:border-emerald-700/50 bg-emerald-500/10 text-emerald-900 dark:text-emerald-300 hover:bg-emerald-500/20"
                  onClick={() =>
                    handleSendGoogleReviewInvite(latestFiveStarFeedback?.id)
                  }
                  disabled={markGoogleReviewMutation.isPending}
                >
                  <Star
                    aria-hidden
                    className="size-3.5 text-emerald-600 fill-emerald-500 shrink-0"
                  />
                  <span>دعوة Google</span>
                </Button>
              </div>

              {/* بطاقة الاتصال والبيانات الأساسية */}
              <Card className="border shadow-none">
                <CardHeader className="py-2.5 px-3 border-b bg-muted/30">
                  <CardTitle className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
                    <span>بيانات الاتصال والعناوين</span>
                    <span className="text-[11px] font-normal">
                      {customer.city || "بغداد"}{" "}
                      {customer.district ? `· ${customer.district}` : ""}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 text-xs space-y-2">
                  <div className="flex flex-wrap items-center gap-3">
                    {customer.phone && (
                      <div className="flex items-center gap-1.5">
                        <Phone
                          aria-hidden
                          className="size-3.5 text-muted-foreground"
                        />
                        <span className="font-mono text-xs">
                          {customer.phone}
                        </span>
                        <div className="flex items-center gap-1 mr-1">
                          <a
                            href={`tel:${customer.phone}`}
                            className="p-1 rounded hover:bg-muted text-primary"
                            title="اتصال هاتفي"
                          >
                            <PhoneCall
                              aria-hidden="true"
                              className="size-3.5"
                            />
                          </a>
                          <button
                            type="button"
                            onClick={() => openWhatsApp(customer.phone, "")}
                            className="p-1 rounded hover:bg-emerald-500/10 text-emerald-600"
                            title="مراسلة عبر واتساب"
                          >
                            <MessageSquare
                              aria-hidden="true"
                              className="size-3.5"
                            />
                          </button>
                        </div>
                      </div>
                    )}

                    {customer.phone2 && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground text-[11px]">
                          هاتف إضافي:
                        </span>
                        <span className="font-mono text-xs">
                          {customer.phone2}
                        </span>
                        <a
                          href={`tel:${customer.phone2}`}
                          className="p-1 rounded hover:bg-muted text-primary"
                        >
                          <PhoneCall aria-hidden="true" className="size-3.5" />
                        </a>
                      </div>
                    )}

                    {customer.whatsapp &&
                      customer.whatsapp !== customer.phone && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground text-[11px]">
                            واتساب مخصص:
                          </span>
                          <span className="font-mono text-xs">
                            {customer.whatsapp}
                          </span>
                          <button
                            type="button"
                            onClick={() => openWhatsApp(customer.whatsapp!, "")}
                            className="p-1 rounded hover:bg-emerald-500/10 text-emerald-600"
                          >
                            <MessageSquare
                              aria-hidden="true"
                              className="size-3.5"
                            />
                          </button>
                        </div>
                      )}
                  </div>

                  {customer.address && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <MapPin aria-hidden className="size-3.5 shrink-0" />
                      <span>{customer.address}</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* بطاقات المؤشرات المالية والنشاط الكلي */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <Card className="border shadow-none p-3 space-y-1">
                  <div className="text-[11px] text-muted-foreground flex items-center justify-between">
                    <span>القيمة الدائمة (LTV)</span>
                    <Receipt aria-hidden className="size-3.5 text-primary" />
                  </div>
                  <div className="text-sm font-bold tabular-nums text-foreground">
                    {metrics.lifetimeValue != null
                      ? `${fmt(metrics.lifetimeValue)} د.ع`
                      : "—"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {metrics.completedInvoicesCount} فاتورة مكتملة
                  </div>
                </Card>

                <Card className="border shadow-none p-3 space-y-1">
                  <div className="text-[11px] text-muted-foreground flex items-center justify-between">
                    <span>الرصيد المالي الحالي</span>
                    <AlertCircle
                      aria-hidden
                      className="size-3.5 text-amber-500"
                    />
                  </div>
                  <div
                    className={`text-sm font-bold tabular-nums ${
                      metrics.balance != null
                        ? Number(metrics.balance) > 0
                          ? "text-rose-600 dark:text-rose-400"
                          : "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground"
                    }`}
                  >
                    {metrics.balance != null
                      ? `${fmt(metrics.balance)} د.ع`
                      : "محجوب"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {metrics.balance != null
                      ? Number(metrics.balance) > 0
                        ? "مستحق على العميل"
                        : "رصيد دائن / مسوّى"
                      : metrics.creditStatus || "نقدي / آجل"}
                  </div>
                </Card>

                <Card className="border shadow-none p-3 space-y-1">
                  <div className="text-[11px] text-muted-foreground flex items-center justify-between">
                    <span>سقف الائتمان</span>
                    <CheckCircle2
                      aria-hidden
                      className="size-3.5 text-blue-500"
                    />
                  </div>
                  <div className="text-sm font-bold tabular-nums">
                    {metrics.creditLimit != null
                      ? `${fmt(metrics.creditLimit)} د.ع`
                      : metrics.creditStatus || "مسموح بالآجل"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {metrics.creditLimit != null
                      ? `استهلاك ${metrics.creditUsagePercent}%`
                      : "شارة الائتمان"}
                  </div>
                </Card>

                <Card className="border shadow-none p-3 space-y-1">
                  <div className="text-[11px] text-muted-foreground flex items-center justify-between">
                    <span>أوامر الشغل الإجمالية</span>
                    <Clock aria-hidden className="size-3.5 text-purple-500" />
                  </div>
                  <div className="text-sm font-bold tabular-nums">
                    {metrics.workOrdersCount} طلب
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {metrics.avgInvoiceValue != null
                      ? `معدل الفاتورة: ${fmt(metrics.avgInvoiceValue)} د.ع`
                      : "نشاط مستمر"}
                  </div>
                </Card>
              </div>

              {/* التبويبات التفصيلية */}
              <Tabs defaultValue="timeline" className="w-full">
                <TabsList className="grid grid-cols-3 w-full">
                  <TabsTrigger value="timeline" className="text-xs">
                    الخط الزمني والمعاملات
                  </TabsTrigger>
                  <TabsTrigger value="feedback" className="text-xs">
                    الجودة والشكاوى (
                    {metrics.feedbackSummary.openComplaintsCount
                      ? `+${metrics.feedbackSummary.openComplaintsCount}`
                      : metrics.feedbackSummary.totalReviews}
                    )
                  </TabsTrigger>
                  <TabsTrigger value="coupons" className="text-xs">
                    الكوبونات والهدايا ({dossier.recentCoupons.length})
                  </TabsTrigger>
                </TabsList>

                {/* التبويب 1: المعاملات الأخيرة */}
                <TabsContent value="timeline" className="space-y-4 pt-3">
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
                      <span>آخر فواتير المبيعات</span>
                      <Link
                        href={`/invoices?customerId=${customer.id}`}
                        className="text-primary hover:underline text-[11px] flex items-center gap-1"
                      >
                        <span>عرض الكل</span>
                        <ExternalLink aria-hidden className="size-3" />
                      </Link>
                    </div>

                    {dossier.recentInvoices.length === 0 ? (
                      <div className="p-4 rounded-md border border-dashed text-center text-xs text-muted-foreground">
                        لا توجد فواتير مبيعات مسجلة لهذا العميل حتى الآن.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {dossier.recentInvoices.map((inv) => (
                          <div
                            key={inv.id}
                            className="p-2.5 rounded-md border bg-card flex items-center justify-between gap-2 text-xs"
                          >
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1.5 font-medium">
                                <Link
                                  href={`/invoices/${inv.id}`}
                                  className="hover:underline text-primary"
                                >
                                  #{inv.invoiceNumber}
                                </Link>
                                <Badge
                                  variant="outline"
                                  className="text-[10px] py-0"
                                >
                                  {invoiceStatusLabel(inv.status)}
                                </Badge>
                              </div>
                              <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                                <Calendar aria-hidden className="size-3" />
                                <span>{fmtDate(inv.invoiceDate)}</span>
                              </div>
                            </div>
                            <div className="text-left font-bold tabular-nums">
                              {fmt(inv.total)} د.ع
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 pt-2">
                    <div className="text-xs font-semibold text-muted-foreground flex items-center justify-between">
                      <span>آخر أوامر الشغل والإنتاج</span>
                      <Link
                        href={`/work-orders?customerId=${customer.id}`}
                        className="text-primary hover:underline text-[11px] flex items-center gap-1"
                      >
                        <span>عرض الكل</span>
                        <ExternalLink aria-hidden className="size-3" />
                      </Link>
                    </div>

                    {dossier.recentWorkOrders.length === 0 ? (
                      <div className="p-4 rounded-md border border-dashed text-center text-xs text-muted-foreground">
                        لا توجد أوامر شغل مسجلة لهذا العميل حتى الآن.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {dossier.recentWorkOrders.map((wo) => (
                          <div
                            key={wo.id}
                            className="p-2.5 rounded-md border bg-card flex flex-wrap items-center justify-between gap-2 text-xs"
                          >
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1.5 font-medium">
                                <Link
                                  href={`/work-orders/${wo.id}`}
                                  className="hover:underline text-primary"
                                >
                                  #{wo.orderNumber}
                                </Link>
                                <span className="text-foreground/80 truncate max-w-[200px]">
                                  {wo.title}
                                </span>
                              </div>
                              <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] py-0"
                                >
                                  {workOrderStatusLabel(wo.status)}
                                </Badge>
                                <span>· {fmtDate(wo.createdAt)}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="text-left font-bold tabular-nums">
                                {fmt(wo.totalAmount)} د.ع
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 text-[10px] gap-1 px-2 text-rose-700 border-rose-300 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/40"
                                onClick={() => {
                                  setTargetFeedbackId(undefined);
                                  setTargetWorkOrderId(wo.id);
                                  setTargetWorkOrderNumber(wo.orderNumber);
                                  setFeedbackModalOpen(true);
                                }}
                              >
                                <MessageSquarePlus
                                  aria-hidden
                                  className="size-3 text-rose-600"
                                />
                                <span>تسجيل شكوى/ملاحظة</span>
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* التبويب 2: الجودة والشكاوى والتقييمات */}
                <TabsContent value="feedback" className="space-y-4 pt-3">
                  {/* ملخص رضا العميل */}
                  <div className="grid grid-cols-3 gap-2 p-3 rounded-lg border bg-muted/20">
                    <div className="text-center space-y-0.5">
                      <div className="text-[11px] text-muted-foreground">
                        متوسط التقييم
                      </div>
                      <div className="text-base font-bold flex items-center justify-center gap-1 text-amber-500">
                        <Star aria-hidden className="size-4 fill-amber-500" />
                        <span>{metrics.feedbackSummary.averageRating} / 5</span>
                      </div>
                    </div>

                    <div className="text-center space-y-0.5 border-x">
                      <div className="text-[11px] text-muted-foreground">
                        شكاوى مفتوحة
                      </div>
                      <div
                        className={`text-base font-bold ${metrics.feedbackSummary.openComplaintsCount > 0 ? "text-rose-600 animate-pulse" : "text-foreground"}`}
                      >
                        {metrics.feedbackSummary.openComplaintsCount}
                      </div>
                    </div>

                    <div className="text-center space-y-0.5">
                      <div className="text-[11px] text-muted-foreground">
                        تم حلها بنجاح
                      </div>
                      <div className="text-base font-bold text-emerald-600">
                        {metrics.feedbackSummary.resolvedComplaintsCount}
                      </div>
                    </div>
                  </div>

                  {/* قائمة التقييمات والشكاوى */}
                  <div className="space-y-2.5">
                    {dossier.recentFeedback.length === 0 ? (
                      <div className="p-6 rounded-md border border-dashed text-center text-xs text-muted-foreground space-y-2">
                        <CheckCircle2
                          aria-hidden
                          className="size-6 mx-auto text-emerald-500"
                        />
                        <p>
                          لا توجد أي شكاوى أو عتب مسجل لهذا العميل حتى الآن.
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setTargetFeedbackId(undefined);
                            setTargetWorkOrderId(undefined);
                            setFeedbackModalOpen(true);
                          }}
                        >
                          تسجيل تقييم جديد
                        </Button>
                      </div>
                    ) : (
                      dossier.recentFeedback.map((fb) => (
                        <Card key={fb.id} className="border shadow-none">
                          <CardContent className="p-3 text-xs space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-1.5">
                              <div className="flex items-center gap-2">
                                <div className="flex items-center text-amber-500">
                                  {Array.from({ length: 5 }).map((_, i) => (
                                    <Star
                                      key={i}
                                      aria-hidden
                                      className={`size-3.5 ${i < fb.rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
                                    />
                                  ))}
                                </div>
                                <span className="font-semibold">
                                  {FEEDBACK_CATEGORY_LABELS[
                                    fb.category as FeedbackCategory
                                  ] || fb.category}
                                </span>
                              </div>

                              <div className="flex items-center gap-1.5">
                                <Badge
                                  variant={
                                    STATUS_VARIANTS[fb.issueStatus] ??
                                    "secondary"
                                  }
                                  className="text-[10px]"
                                >
                                  {ISSUE_STATUS_LABELS[
                                    fb.issueStatus as IssueStatus
                                  ] || fb.issueStatus}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground">
                                  {fmtDate(fb.createdAt)}
                                </span>
                              </div>
                            </div>

                            {fb.comment && (
                              <p className="text-foreground/90 bg-muted/40 p-2 rounded text-[11px] leading-relaxed">
                                &quot;{fb.comment}&quot;
                              </p>
                            )}

                            {fb.smartGuidance && (
                              <div className="text-[11px] text-primary bg-primary/5 p-2 rounded flex items-start gap-1.5">
                                <Sparkles
                                  aria-hidden
                                  className="size-3.5 shrink-0 mt-0.5"
                                />
                                <span>{fb.smartGuidance}</span>
                              </div>
                            )}

                            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t text-[11px] text-muted-foreground">
                              <div>
                                {fb.rootCauseStation && (
                                  <span>
                                    محطة الخلل:{" "}
                                    <strong className="text-foreground">
                                      {ROOT_CAUSE_STATION_LABELS[
                                        fb.rootCauseStation as RootCauseStation
                                      ] || fb.rootCauseStation}
                                    </strong>
                                  </span>
                                )}
                                {fb.workOrderId && (
                                  <span className="mr-2">
                                    أمر الشغل:{" "}
                                    <Link
                                      href={`/work-orders/${fb.workOrderId}`}
                                      className="font-mono text-primary hover:underline font-bold"
                                    >
                                      #{fb.workOrderNumber || fb.workOrderId}
                                    </Link>
                                  </span>
                                )}
                                {fb.giftCouponCode && (
                                  <span className="mr-2 text-emerald-600 font-mono">
                                    كوبون تعويض: {fb.giftCouponCode}
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-1.5">
                                {fb.rating === 5 &&
                                  !fb.googleReviewInviteSent && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 text-[10px] text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50 gap-1 px-2"
                                      onClick={() =>
                                        handleSendGoogleReviewInvite(fb.id)
                                      }
                                    >
                                      <Star
                                        aria-hidden
                                        className="size-3 fill-emerald-600 text-emerald-600"
                                      />
                                      <span>دعوة لخرائط Google</span>
                                    </Button>
                                  )}

                                {fb.issueStatus !== "RESOLVED" &&
                                  fb.issueStatus !== "CLOSED" && (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-6 text-[10px] gap-1 px-2 text-amber-700 border-amber-300 hover:bg-amber-50 dark:border-amber-700/50 dark:text-amber-400"
                                        onClick={() => {
                                          setTargetFeedbackId(fb.id);
                                          setGiftModalOpen(true);
                                        }}
                                      >
                                        <Gift
                                          aria-hidden
                                          className="size-3.5 text-amber-600"
                                        />
                                        <span>إهداء ترضية</span>
                                      </Button>

                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-6 text-[10px] gap-1 px-2 text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                                        disabled={
                                          updateStatusMutation.isPending
                                        }
                                        onClick={() =>
                                          updateStatusMutation.mutate({
                                            feedbackId: fb.id,
                                            customerId: customer.id,
                                            issueStatus: "RESOLVED",
                                            resolutionAction:
                                              "تمت معالجة الشكوى وتعويض الزبون برضاه الكامل",
                                          })
                                        }
                                      >
                                        <Check aria-hidden className="size-3" />
                                        <span>إغلاق وحل</span>
                                      </Button>
                                    </>
                                  )}
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))
                    )}
                  </div>
                </TabsContent>

                {/* التبويب 3: الكوبونات وقسائم الهدايا */}
                <TabsContent value="coupons" className="space-y-4 pt-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-muted-foreground">
                      قسائم الإهداء والترضية الصادرة
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs gap-1.5 h-7"
                      onClick={() => {
                        setTargetFeedbackId(undefined);
                        setGiftModalOpen(true);
                      }}
                    >
                      <Gift aria-hidden className="size-3.5 text-amber-600" />
                      <span>إصدار قسيمة جديدة</span>
                    </Button>
                  </div>

                  {dossier.recentCoupons.length === 0 ? (
                    <div className="p-6 rounded-md border border-dashed text-center text-xs text-muted-foreground space-y-2">
                      <Gift
                        aria-hidden
                        className="size-6 mx-auto text-amber-500"
                      />
                      <p>
                        لم يتم إصدار قسائم هدايا أو ترضية لهذا العميل من قبل.
                      </p>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setTargetFeedbackId(undefined);
                          setGiftModalOpen(true);
                        }}
                      >
                        إصدار قسيمة هدية الآن
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {dossier.recentCoupons.map((coupon) => (
                        <div
                          key={coupon.id}
                          className="p-3 rounded-md border bg-card flex flex-wrap items-center justify-between gap-2 text-xs"
                        >
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-sm tracking-wider text-primary">
                                {coupon.code}
                              </span>
                              <Badge
                                variant={
                                  coupon.status === "ACTIVE"
                                    ? "default"
                                    : "secondary"
                                }
                                className="text-[10px] py-0"
                              >
                                {coupon.status === "ACTIVE"
                                  ? "صالحة للاستخدام"
                                  : coupon.status === "REDEEMED"
                                    ? "تم الاستخدام"
                                    : "ملغاة"}
                              </Badge>
                            </div>
                            <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-1.5">
                              <span>{coupon.programName}</span>
                              {coupon.discountAmount ? (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] py-0 text-emerald-700 dark:text-emerald-400 font-bold border-emerald-300"
                                >
                                  {fmt(coupon.discountAmount)} د.ع
                                </Badge>
                              ) : coupon.discountPercent ? (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] py-0 text-emerald-700 dark:text-emerald-400 font-bold border-emerald-300"
                                >
                                  %{coupon.discountPercent}
                                </Badge>
                              ) : null}
                              <span>
                                · تاريخ الإصدار: {fmtDate(coupon.issuedAt)}
                              </span>
                              {coupon.validTo && (
                                <span>
                                  · صالحة لغاية: {fmtDate(coupon.validTo)}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1 px-2.5"
                              onClick={() => handleSendCouponWhatsApp(coupon)}
                            >
                              <MessageSquare
                                aria-hidden
                                className="size-3.5 text-emerald-600"
                              />
                              <span>إرسال بالواتساب</span>
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1 px-2.5"
                              onClick={() => handlePrintCoupon(coupon)}
                            >
                              <Printer aria-hidden className="size-3.5" />
                              <span>طباعة إيصال 80mm</span>
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* المودال الفرعي لإصدار القسيمة الفورية */}
      {customer && (
        <InstantGiftModal
          open={giftModalOpen}
          onClose={() => {
            setGiftModalOpen(false);
            setTargetFeedbackId(undefined);
          }}
          customerId={customer.id}
          customerName={customer.name}
          customerPhone={
            preferredWhatsAppPhone(customer.whatsapp, customer.phone) ||
            customer.phone ||
            customer.whatsapp
          }
          feedbackId={targetFeedbackId}
          onSuccess={() => {
            utils.customers.dossier360.invalidate({ customerId: customer.id });
          }}
        />
      )}

      {/* المودال الفرعي لتسجيل تقييم أو شكوى */}
      {customer && (
        <FeedbackModal
          open={feedbackModalOpen}
          onClose={() => {
            setFeedbackModalOpen(false);
            setTargetWorkOrderId(undefined);
            setTargetWorkOrderNumber(undefined);
          }}
          customerId={customer.id}
          customerName={customer.name}
          customerPhone={
            preferredWhatsAppPhone(customer.whatsapp, customer.phone) ||
            customer.phone ||
            customer.whatsapp
          }
          workOrderId={targetWorkOrderId}
          workOrderNumber={targetWorkOrderNumber}
          onSuccess={() => {
            utils.customers.dossier360.invalidate({ customerId: customer.id });
            utils.customers.feedbackList.invalidate();
          }}
        />
      )}
    </>
  );
}
