/**
 * CancelAssignmentOrderCard - بطاقة تفاصيل الطلب والإرسالية وإلغاء الإسناد والتحويل الذكي
 */
import React, { useState } from "react";
import {
  AlertTriangle,
  Ban,
  Building2,
  FileText,
  Info,
  Package,
  Truck,
  User,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { fmt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ACTION_LABELS as L } from "@shared/actionLabels";
import { invoiceStatusBadgeVariant, invoiceStatusLabel } from "@shared/invoiceStatus";
import { workOrderStatusBadgeCls, workOrderStatusLabel } from "@shared/workOrderStatus";
import type { ScannedOrderForCancellation } from "./CancelDeliveryAssignmentSection";
import {
  DeliveryPartyExposureBadge,
  type DeliveryPartySummary,
} from "./DeliveryPartyExposureBadge";

const PRESET_CANCEL_REASONS = [
  "استلام الزبون من الفرع",
  "تغيير المندوب / شركة التوصيل",
  "طلب الزبون تأجيل التسليم",
  "تعديل في بنود الطلب",
  "تعذر التواصل مع العميل",
] as const;

interface Props {
  scannedOrder: ScannedOrderForCancellation;
  branchId?: number | null;
  allParties?: DeliveryPartySummary[];
  reason: string;
  onReasonChange: (reason: string) => void;
  onConfirmCancel: () => void;
  onConfirmReassign?: (targetPartyId: number) => void;
  onReset: () => void;
  onNavigateToDispatch?: (order: ScannedOrderForCancellation) => void;
  isPending: boolean;
}

export function CancelAssignmentOrderCard({
  scannedOrder,
  branchId,
  allParties = [],
  reason,
  onReasonChange,
  onConfirmCancel,
  onConfirmReassign,
  onReset,
  onNavigateToDispatch,
  isPending,
}: Props) {
  const [actionType, setActionType] = useState<"cancel" | "reassign">("cancel");
  const [targetPartyId, setTargetPartyId] = useState<number | null>(null);

  const docLabel =
    scannedOrder.kind === "onlineOrder"
      ? "طلب متجر"
      : scannedOrder.kind === "invoice"
      ? "فاتورة بيع"
      : "أمر شغل";

  const activeCn = scannedOrder.activeConsignment;
  const isCancellableParcelStatus =
    activeCn?.parcelStatus === "ASSIGNED" ||
    activeCn?.parcelStatus === "OUT_FOR_DELIVERY" ||
    activeCn?.parcelStatus === "FAILED";
  const hasCollections = Number(activeCn?.collectedAmount ?? "0") > 0;
  const isMoneySettled =
    activeCn?.moneyStatus === "COLLECTED" ||
    activeCn?.moneyStatus === "REMITTED" ||
    activeCn?.moneyStatus === "SETTLED";
  const canCancel = isCancellableParcelStatus && !hasCollections && !isMoneySettled;

  const currentParty = allParties.find((p) => p.id === activeCn?.partyId);
  const targetParty = allParties.find((p) => p.id === targetPartyId);
  const availableParties = allParties.filter((p) => p.id !== activeCn?.partyId);

  return (
    <Card className="overflow-hidden gap-0 py-0 shadow-sm border-destructive/30">
      {/* شريط رأس الطلب المفحوص */}
      <div className="flex items-start justify-between border-b bg-muted/40 p-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            {scannedOrder.kind === "invoice" ? (
              <FileText aria-hidden className="size-5 text-primary" />
            ) : (
              <Package aria-hidden className="size-5 text-primary" />
            )}
            <span className="text-lg font-extrabold font-mono">#{scannedOrder.orderNumber}</span>
            <Badge variant="outline" className="font-bold">{docLabel}</Badge>
            {scannedOrder.status && (
              <Badge
                variant={scannedOrder.kind === "invoice" ? invoiceStatusBadgeVariant(scannedOrder.status) : "secondary"}
                className={scannedOrder.kind === "workOrder" ? workOrderStatusBadgeCls(scannedOrder.status) : "font-bold"}
              >
                {scannedOrder.kind === "invoice"
                  ? invoiceStatusLabel(scannedOrder.status)
                  : scannedOrder.kind === "workOrder"
                  ? workOrderStatusLabel(scannedOrder.status)
                  : scannedOrder.status}
              </Badge>
            )}
            {scannedOrder.branchId && branchId && scannedOrder.branchId !== branchId && (
              <Badge variant="outline" className="border-primary text-primary font-bold">
                فرع #{scannedOrder.branchId}
              </Badge>
            )}
          </div>
          {scannedOrder.title && <p className="mt-1 text-sm text-muted-foreground">{scannedOrder.title}</p>}
        </div>
        <Button variant="ghost" size="sm" onClick={onReset}>مسح طلب آخر</Button>
      </div>

      {/* محتوى الإسناد أو عدم الإسناد */}
      <div className="space-y-4 p-4">
        {activeCn ? (
          <div className="space-y-3.5">
            {/* بطاقة تفاصيل الإرسالية المسندة */}
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 space-y-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-destructive font-extrabold text-sm">
                  <Truck className="size-4 shrink-0" />
                  <span>إرسالية توصيل نشطة: #{activeCn.consignmentNumber}</span>
                </div>
                <Badge variant="outline" className="border-destructive text-destructive font-bold">
                  {activeCn.partyType === "COMPANY" ? "شركة توصيل خارجية" : "مندوب داخلي"}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>جهة التوصيل: <strong className="text-foreground">{activeCn.partyName ?? "غير محدد"}</strong></span>
                <span>حالة الطرد: <strong className="text-foreground">{activeCn.parcelStatus}</strong></span>
                <span>حالة الذمة: <strong className="text-foreground">{activeCn.moneyStatus}</strong></span>
              </div>

              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 pt-1 text-xs">
                <div className="rounded-lg bg-background p-2.5 border">
                  <span className="text-muted-foreground block">قيمة الطلب:</span>
                  <strong className="text-sm font-bold text-foreground">{fmt(scannedOrder.salePrice)} د.ع</strong>
                </div>
                <div className="rounded-lg bg-background p-2.5 border">
                  <span className="text-muted-foreground block">المسدد / العربون:</span>
                  <strong className="text-sm font-bold text-foreground">{fmt(scannedOrder.deposit ?? "0")} د.ع</strong>
                </div>
                <div className="rounded-lg bg-background p-2.5 border">
                  <span className="text-muted-foreground block">المطلوب تحصيله (COD):</span>
                  <strong className="text-sm font-bold text-foreground">{fmt(activeCn.codAmount)} د.ع</strong>
                </div>
                <div className="rounded-lg bg-background p-2.5 border">
                  <span className="text-muted-foreground block">المبلغ المحصّل:</span>
                  <strong className="text-sm font-bold text-foreground">{fmt(activeCn.collectedAmount)} د.ع</strong>
                </div>
              </div>

              <DeliveryPartyExposureBadge party={currentParty} />
            </div>

            {/* تفاصيل العميل والعنوان */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center gap-2 rounded-xl border bg-background p-3">
                <User aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <div className="text-xs">
                  <p className="text-muted-foreground">العميل</p>
                  <p className="font-bold text-sm">{scannedOrder.customerName ?? "زبون نقدي"}</p>
                  {scannedOrder.customerPhone && (
                    <p className="text-muted-foreground font-mono" dir="ltr">{scannedOrder.customerPhone}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-xl border bg-background p-3">
                <Building2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <div className="text-xs">
                  <p className="text-muted-foreground">عنوان التسليم</p>
                  <p className="font-bold text-sm">{scannedOrder.deliveryAddress || "غير محدد"}</p>
                </div>
              </div>
            </div>

            {/* إجراءات الإلغاء أو التحويل الذكي */}
            {canCancel ? (
              <div className="space-y-3 pt-1">
                {availableParties.length > 0 && onConfirmReassign && (
                  <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-muted/60 border text-xs">
                    <button
                      type="button"
                      onClick={() => setActionType("cancel")}
                      className={cn(
                        "flex items-center justify-center gap-1.5 py-2 font-extrabold rounded-lg transition-all",
                        actionType === "cancel" ? "bg-destructive text-destructive-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Ban aria-hidden className="size-3.5" />
                      <span>إلغاء الإسناد فقط</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActionType("reassign")}
                      className={cn(
                        "flex items-center justify-center gap-1.5 py-2 font-extrabold rounded-lg transition-all",
                        actionType === "reassign" ? "bg-primary text-primary-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Truck aria-hidden className="size-3.5" />
                      <span>تحويل لمندوب آخر مباشرة</span>
                    </button>
                  </div>
                )}

                {actionType === "reassign" && availableParties.length > 0 && onConfirmReassign ? (
                  <div className="rounded-xl border border-primary/30 bg-primary/5 p-3.5 space-y-3">
                    <div className="space-y-1.5">
                      <Label className="text-sm font-bold">اختر المندوب الجديد لتحويل الإرسالية إليه</Label>
                      <AppSelect
                        value={targetPartyId ? String(targetPartyId) : ""}
                        onValueChange={(v) => setTargetPartyId(v ? Number(v) : null)}
                        className="h-11 w-full text-sm font-bold"
                      >
                        <option value="">— اختر المندوب أو شركة التوصيل البديلة —</option>
                        {availableParties.map((p) => (
                          <option key={p.id} value={String(p.id)}>
                            {p.name} ({p.partyType === "COMPANY" ? "شركة" : "مندوب"}) · {p.openConsignments ?? 0} طرد نشط
                          </option>
                        ))}
                      </AppSelect>
                    </div>
                    {targetParty && <DeliveryPartyExposureBadge party={targetParty} />}
                    <Button
                      variant="default"
                      size="lg"
                      className="w-full py-6 text-base font-extrabold gap-2"
                      disabled={!targetPartyId || isPending}
                      onClick={() => targetPartyId && onConfirmReassign(targetPartyId)}
                    >
                      <Truck aria-hidden className="size-5" />
                      {isPending ? L.saving : "تأكيد التحويل للمندوب الجديد"}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="cancel-delivery-reason" className="text-sm font-bold">
                          سبب إلغاء الإسناد <span className="text-destructive">*</span>
                        </Label>
                        <span className="text-[11px] text-muted-foreground">اختر سبب الإلغاء أو اكتب أدناه</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {PRESET_CANCEL_REASONS.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => onReasonChange(preset)}
                            className={cn(
                              "rounded-lg border px-2.5 py-1 text-xs font-bold transition-all",
                              reason === preset
                                ? "border-destructive bg-destructive/15 text-destructive font-extrabold shadow-xs"
                                : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                            )}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                      <Input
                        id="cancel-delivery-reason"
                        value={reason}
                        onChange={(e) => onReasonChange(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && canCancel && reason.trim().length >= 3 && !isPending) {
                            e.preventDefault();
                            onConfirmCancel();
                          }
                        }}
                        placeholder="أو اكتب سبباً مخصصاً هنا…"
                        className="h-10"
                        maxLength={500}
                        autoFocus
                      />
                    </div>
                    <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-muted-foreground space-y-1">
                      <p className="font-bold text-destructive">تنبيه المعالجة الذرية — سيتم عند التأكيد:</p>
                      <ul className="list-disc list-inside space-y-0.5">
                        <li>تحرير ذمة المندوب المالية فوراً في دفتر التوصيل (COD_RELEASED).</li>
                        <li>تحويل حالة الإرسالية إلى ملغاة (CANCELLED) وإلغاء ارتباط الطرد.</li>
                        <li>إعادة الطلب / الفاتورة إلى حالة الجاهزية للإسناد الجديد دون المساس بالمبيعات أو المخزون.</li>
                      </ul>
                    </div>
                    <Button
                      variant="destructive"
                      size="lg"
                      className="w-full py-6 text-base font-extrabold gap-2"
                      disabled={reason.trim().length < 3 || isPending}
                      onClick={onConfirmCancel}
                    >
                      <Ban aria-hidden className="size-5" />
                      {isPending ? L.cancelling : "تأكيد إلغاء الإسناد والتوصيل"}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)]/20 p-4 space-y-2">
                <div className="flex items-center gap-2 text-[var(--sem-warn)] font-extrabold text-sm">
                  <AlertTriangle className="size-4 shrink-0" />
                  <span>لا يمكن إلغاء الإسناد المباشر لهذا الطرد</span>
                </div>
                <p className="text-xs text-muted-foreground leading-5">
                  الإرسالية <strong>#{activeCn.consignmentNumber}</strong> حالتها الحالية (<strong>{activeCn.parcelStatus}</strong>) أو بدأ تحصيل مبالغ منها ({fmt(activeCn.collectedAmount)} د.ع).
                </p>
                <p className="text-xs text-[var(--sem-warn)] font-bold">
                  حسب القواعد المالية، لإلغاء هذا الطرد يرجى التوجه إلى قسم (إلغاء / مرتجع) لاسترجاع الإرسالية وتصفية الذمم أصولياً.
                </p>
              </div>
            )}
          </div>
        ) : (
          /* حالة الطلب غير مسند حالياً */
          <div className="rounded-2xl border-2 border-[var(--sem-info)]/30 bg-[var(--sem-info-bg)]/15 p-6 text-center space-y-3">
            <Info aria-hidden className="mx-auto size-10 text-[var(--sem-info)]" />
            <div>
              <p className="text-base font-extrabold text-foreground">
                الطلب غير مسند حالياً لأي جهة توصيل
              </p>
              <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
                هذا الطلب (رقم #{scannedOrder.orderNumber}) لا يرتبط بأي إرسالية توصيل نشطة حالياً، ولا توجد ذمة مالية معلقة عليه للتوصيل.
              </p>
            </div>
            <div className="rounded-xl border bg-background p-3 text-start space-y-1.5 max-w-md mx-auto text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">العميل:</span>
                <span className="font-bold">{scannedOrder.customerName ?? "زبون نقدي"}</span>
              </div>
              {scannedOrder.customerPhone && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">الهاتف:</span>
                  <span className="font-mono font-bold" dir="ltr">{scannedOrder.customerPhone}</span>
                </div>
              )}
              {scannedOrder.deliveryAddress && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">العنوان:</span>
                  <span className="font-bold">{scannedOrder.deliveryAddress}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">قيمة الطلب:</span>
                <span className="font-bold">{fmt(scannedOrder.salePrice)} د.ع</span>
              </div>
            </div>
            <div className="flex flex-wrap justify-center gap-2 pt-2">
              {onNavigateToDispatch && (
                <Button
                  onClick={() => onNavigateToDispatch(scannedOrder)}
                  className="gap-2 font-bold"
                >
                  <Truck className="size-4" />
                  الانتقال لإسناد هذا الطلب لمندوب
                </Button>
              )}
              <Button variant="outline" onClick={onReset}>
                مسح طلب آخر
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
