import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtAr as fmt } from "@/lib/money";
import { openWhatsApp } from "@/lib/whatsapp";
import {
  Phone,
  PhoneCall,
  MessageSquare,
  Gift,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Star,
  FileText,
  Receipt,
  Sparkles,
  MapPin,
  AlertCircle,
} from "lucide-react";
import type { CustomerDossierModel } from "./useCustomerDossier";

export function CustomerDossierOverview({
  model,
}: {
  model: CustomerDossierModel;
}) {
  const {
    can,
    setGiftModalOpen,
    setFeedbackModalOpen,
    setTargetFeedbackId,
    setTargetWorkOrderId,
    markGoogleReviewMutation,
    canReadReports,
    latestFiveStarFeedback,
    handleSendGoogleReviewInvite,
  } = model;
  const dossier = model.dossier!;
  const customer = dossier.customer;
  const metrics = dossier.metrics;
  return (
    <>
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
            <div className="text-foreground/90">{dossier.smartGuidance}</div>
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
          disabled={!can("customers.issueInstantGift")}
        >
          <Gift aria-hidden className="size-3.5 text-amber-600 shrink-0" />
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
          disabled={!can("customers.createFeedback")}
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
          disabled={
            !can("customers.markGoogleReviewInviteSent") ||
            markGoogleReviewMutation.isPending
          }
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
                <Phone aria-hidden className="size-3.5 text-muted-foreground" />
                <span className="font-mono text-xs">{customer.phone}</span>
                <div className="flex items-center gap-1 mr-1">
                  <a
                    href={`tel:${customer.phone}`}
                    className="p-1 rounded hover:bg-muted text-primary"
                    title="اتصال هاتفي"
                  >
                    <PhoneCall aria-hidden="true" className="size-3.5" />
                  </a>
                  <button
                    type="button"
                    onClick={() => openWhatsApp(customer.phone, "")}
                    className="p-1 rounded hover:bg-emerald-500/10 text-emerald-600"
                    title="مراسلة عبر واتساب"
                  >
                    <MessageSquare aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
              </div>
            )}

            {customer.phone2 && (
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground text-[11px]">
                  هاتف إضافي:
                </span>
                <span className="font-mono text-xs">{customer.phone2}</span>
                <a
                  href={`tel:${customer.phone2}`}
                  className="p-1 rounded hover:bg-muted text-primary"
                >
                  <PhoneCall aria-hidden="true" className="size-3.5" />
                </a>
              </div>
            )}

            {customer.whatsapp && customer.whatsapp !== customer.phone && (
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground text-[11px]">
                  واتساب مخصص:
                </span>
                <span className="font-mono text-xs">{customer.whatsapp}</span>
                <button
                  type="button"
                  onClick={() => openWhatsApp(customer.whatsapp!, "")}
                  className="p-1 rounded hover:bg-emerald-500/10 text-emerald-600"
                >
                  <MessageSquare aria-hidden="true" className="size-3.5" />
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
            <AlertCircle aria-hidden className="size-3.5 text-amber-500" />
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
            {metrics.balance != null ? `${fmt(metrics.balance)} د.ع` : "محجوب"}
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
            <CheckCircle2 aria-hidden className="size-3.5 text-blue-500" />
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
    </>
  );
}
