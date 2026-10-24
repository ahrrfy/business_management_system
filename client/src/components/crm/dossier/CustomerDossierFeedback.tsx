import { Link } from "wouter";
import { TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { fmtDate } from "@/lib/date";
import { Gift, CheckCircle2, Star, Sparkles, Check } from "lucide-react";
import {
  FEEDBACK_CATEGORY_LABELS,
  type FeedbackCategory,
  ISSUE_STATUS_LABELS,
  type IssueStatus,
  ROOT_CAUSE_STATION_LABELS,
  type RootCauseStation,
} from "@shared/customerFeedback";
import type { CustomerDossierModel } from "./useCustomerDossier";
const STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  NEW: "destructive",
  IN_PROGRESS: "secondary",
  RESOLVED: "default",
  CLOSED: "outline",
};

export function CustomerDossierFeedback({
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
    updateStatusMutation,
    handleSendGoogleReviewInvite,
  } = model;
  const dossier = model.dossier!;
  const customer = dossier.customer;
  const metrics = dossier.metrics;
  return (
    <TabsContent value="feedback" className="space-y-4 pt-3">
      {/* ملخص رضا العميل */}
      <div className="grid grid-cols-3 gap-2 p-3 rounded-lg border bg-muted/20">
        <div className="text-center space-y-0.5">
          <div className="text-[11px] text-muted-foreground">متوسط التقييم</div>
          <div className="text-base font-bold flex items-center justify-center gap-1 text-amber-500">
            <Star aria-hidden className="size-4 fill-amber-500" />
            <span>{metrics.feedbackSummary.averageRating} / 5</span>
          </div>
        </div>

        <div className="text-center space-y-0.5 border-x">
          <div className="text-[11px] text-muted-foreground">شكاوى مفتوحة</div>
          <div
            className={`text-base font-bold ${metrics.feedbackSummary.openComplaintsCount > 0 ? "text-rose-600 animate-pulse" : "text-foreground"}`}
          >
            {metrics.feedbackSummary.openComplaintsCount}
          </div>
        </div>

        <div className="text-center space-y-0.5">
          <div className="text-[11px] text-muted-foreground">تم حلها بنجاح</div>
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
            <p>لا توجد أي شكاوى أو عتب مسجل لهذا العميل حتى الآن.</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setTargetFeedbackId(undefined);
                setTargetWorkOrderId(undefined);
                setFeedbackModalOpen(true);
              }}
              disabled={!can("customers.createFeedback")}
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
                      variant={STATUS_VARIANTS[fb.issueStatus] ?? "secondary"}
                      className="text-[10px]"
                    >
                      {ISSUE_STATUS_LABELS[fb.issueStatus as IssueStatus] ||
                        fb.issueStatus}
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
                    {fb.rating === 5 && !fb.googleReviewInviteSent && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50 gap-1 px-2"
                        onClick={() => handleSendGoogleReviewInvite(fb.id)}
                        disabled={!can("customers.markGoogleReviewInviteSent")}
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
                            disabled={!can("customers.issueInstantGift")}
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
                              !can("customers.updateFeedbackStatus") ||
                              updateStatusMutation.isPending
                            }
                            onClick={() =>
                              updateStatusMutation.mutate({
                                feedbackId: fb.id,
                                customerId: customer.id,
                                issueStatus: "RESOLVED",
                                resolutionAction: "تمت معالجة الشكوى",
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
  );
}
