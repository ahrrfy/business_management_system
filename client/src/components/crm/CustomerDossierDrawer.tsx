import { CustomerDossierTimeline } from "./CustomerDossierTimeline";

import { useCatalogPeopleOperationAccess } from "@/lib/catalogPeopleOperationAccess";
import { priceTierLabel } from "@shared/terms";
/**
 * الملف الشامل للعميل 360° (Customer 360° Dossier Drawer)
 * يعرض بطاقة الاتصال، المؤشرات المالية، مؤشرات الجودة والرضا،
 * والتغذية العكسية، والكوبونات، والخط الزمني للمعاملات، مع إرشادات الذكاء التشغيلي.
 *
 * صفر إيموجي — يعتمد أيقونات lucide-react حصراً (حارس check:emoji).
 */

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";

import { preferredWhatsAppPhone } from "@/lib/whatsapp";

import { CustomerRadarBadges } from "./CustomerRadarBadges";
import { InstantGiftModal } from "./InstantGiftModal";
import { FeedbackModal } from "./FeedbackModal";
import { RotateCcw, Building2, Loader2, AlertCircle } from "lucide-react";

import { useCustomerDossier } from "./dossier/useCustomerDossier";
import { CustomerDossierOverview } from "./dossier/CustomerDossierOverview";
import { CustomerDossierFeedback } from "./dossier/CustomerDossierFeedback";
import { CustomerDossierCoupons } from "./dossier/CustomerDossierCoupons";
export interface CustomerDossierDrawerProps {
  customerId: number | null;
  open: boolean;
  onClose: () => void;
}

export function CustomerDossierDrawer(props: CustomerDossierDrawerProps) {
  const { can } = useCatalogPeopleOperationAccess();
  if (!props.open || !props.customerId || !can("customers.dossier360"))
    return null;
  return <CustomerDossierSession key={props.customerId} {...props} />;
}
function CustomerDossierSession({
  customerId,
  open,
  onClose,
}: CustomerDossierDrawerProps) {
  const model = useCustomerDossier({ customerId, open, onClose });
  const {
    can,
    giftModalOpen,
    setGiftModalOpen,
    feedbackModalOpen,
    setFeedbackModalOpen,
    targetFeedbackId,
    setTargetFeedbackId,
    targetWorkOrderId,
    setTargetWorkOrderId,
    targetWorkOrderNumber,
    setTargetWorkOrderNumber,
    utils,
    dossierQuery,
    markGoogleReviewMutation,
    pendingInvite,
    setPendingInvite,
    confirmInviteSent,
    isFeedbackSessionCurrent,
  } = model;
  const { dossier, customer, metrics } = model;
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
                    ? `(${priceTierLabel(customer.defaultPriceTier)})`
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

          {pendingInvite && (
            <div
              role="status"
              className="mt-3 rounded-md border p-3 space-y-2 text-sm"
            >
              <p>بعد إرسال الدعوة في واتساب، أكّد الإرسال لتسجيله في الملف.</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={
                    !can("customers.markGoogleReviewInviteSent") ||
                    markGoogleReviewMutation.isPending
                  }
                  onClick={confirmInviteSent}
                >
                  تأكيد إرسال الدعوة
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPendingInvite(null)}
                >
                  لم أرسلها
                </Button>
              </div>
            </div>
          )}
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

          {dossier && customer && metrics && (
            <div className="mt-4 space-y-5">
              <CustomerDossierOverview model={model} />
              <Tabs defaultValue="timeline" className="w-full">
                <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 [&>button]:whitespace-normal [&>button]:h-auto">
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
                <CustomerDossierTimeline
                  dossier={dossier}
                  customerId={customer.id}
                  onComplaint={(id, number) => {
                    setTargetFeedbackId(undefined);
                    setTargetWorkOrderId(id);
                    setTargetWorkOrderNumber(number);
                    setFeedbackModalOpen(true);
                  }}
                />

                {/* التبويب 2: الجودة والشكاوى والتقييمات */}
                <CustomerDossierFeedback model={model} />

                {/* التبويب 3: الكوبونات وقسائم الهدايا */}
                <CustomerDossierCoupons model={model} />
              </Tabs>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* المودال الفرعي لإصدار القسيمة الفورية */}
      {customer && giftModalOpen && (
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
      {customer && feedbackModalOpen && (
        <FeedbackModal
          open={feedbackModalOpen}
          onClose={() => {
            if (!isFeedbackSessionCurrent()) return;
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
