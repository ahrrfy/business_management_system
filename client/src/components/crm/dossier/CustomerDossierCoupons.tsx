import { canPrintFixedCoupon, couponDiscountLabel } from "../customerCoupon";
import { TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmtDate } from "@/lib/date";
import { MessageSquare, Gift, Printer } from "lucide-react";
import type { CustomerDossierModel } from "./useCustomerDossier";

export function CustomerDossierCoupons({
  model,
}: {
  model: CustomerDossierModel;
}) {
  const {
    can,
    setGiftModalOpen,
    setTargetFeedbackId,
    handlePrintCoupon,
    handleSendCouponWhatsApp,
  } = model;
  const dossier = model.dossier!;
  const customer = dossier.customer;
  const metrics = dossier.metrics;
  return (
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
          disabled={!can("customers.issueInstantGift")}
        >
          <Gift aria-hidden className="size-3.5 text-amber-600" />
          <span>إصدار قسيمة جديدة</span>
        </Button>
      </div>

      {dossier.recentCoupons.length === 0 ? (
        <div className="p-6 rounded-md border border-dashed text-center text-xs text-muted-foreground space-y-2">
          <Gift aria-hidden className="size-6 mx-auto text-amber-500" />
          <p>لم يتم إصدار قسائم هدايا أو ترضية لهذا العميل من قبل.</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setTargetFeedbackId(undefined);
              setGiftModalOpen(true);
            }}
            disabled={!can("customers.issueInstantGift")}
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
                      coupon.status === "ACTIVE" ? "default" : "secondary"
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
                  <Badge variant="outline" className="text-[10px] py-0">
                    {couponDiscountLabel(coupon)}
                  </Badge>
                  <span>· تاريخ الإصدار: {fmtDate(coupon.issuedAt)}</span>
                  {coupon.validTo && (
                    <span>· صالحة لغاية: {fmtDate(coupon.validTo)}</span>
                  )}
                </div>
                {!canPrintFixedCoupon(coupon) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    إيصال الهدية والمشاركة النقدية يتطلبان قسيمة بمبلغ ثابت.
                    تظهر قيمة الخصم الفعلية أعلاه.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1 px-2.5"
                  disabled={!canPrintFixedCoupon(coupon)}
                  title={
                    !canPrintFixedCoupon(coupon)
                      ? "قسيمة نسبة: لا يدعم إيصال الهدية النقدي طباعتها أو مشاركتها"
                      : undefined
                  }
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
                  disabled={!canPrintFixedCoupon(coupon)}
                  title={
                    !canPrintFixedCoupon(coupon)
                      ? "قسيمة نسبة: لا يدعم إيصال الهدية النقدي طباعتها أو مشاركتها"
                      : undefined
                  }
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
  );
}
