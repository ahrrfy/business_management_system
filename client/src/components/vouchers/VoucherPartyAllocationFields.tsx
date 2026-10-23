// نَموذج مُوحَّد لإنشاء سند قبض/صرف (vouchers-pro ٣٠/٦/٢٦).
// يَشمل: تَصنيف + اسم طَرف للسندات «أخرى» + Maker-Checker + مُرفق + بَصمة + تَحذير الازدواج
// + معاينة قَيد دفتر + اختصارات لوحة المفاتيح + حفظ+طباعة + استخدام CustomerPicker/SupplierPicker.
import CustomerPicker from "@/components/CustomerPicker";
import SupplierPicker from "@/components/voucher/SupplierPicker";
import DeliveryPartyPicker from "@/components/voucher/DeliveryPartyPicker";
import { AppSelect } from "@/components/ui/AppSelect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmt } from "@/lib/money";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { AlertTriangle, Hourglass, Info } from "lucide-react";
import type { VoucherFormModel } from "./useVoucherForm";

type Props = Pick<
  VoucherFormModel,
  | "isReceipt"
  | "direction"
  | "branchId"
  | "amount"
  | "partyType"
  | "setPartyType"
  | "customerId"
  | "setCustomerId"
  | "supplierId"
  | "setSupplierId"
  | "deliveryPartyId"
  | "setDeliveryPartyId"
  | "counterpartyName"
  | "setCounterpartyName"
  | "invoiceId"
  | "setInvoiceId"
  | "customerData"
  | "invoiceQ"
  | "setInvoiceQ"
  | "outstandingInvoiceOptions"
  | "selectedInvoiceLabel"
  | "setSelectedInvoiceLabel"
  | "selectedInList"
  | "invoiceRemaining"
  | "recent"
  | "balanceWarn"
>;
export function VoucherPartyAllocationFields({
  isReceipt,
  direction,
  branchId,
  amount,
  partyType,
  setPartyType,
  customerId,
  setCustomerId,
  supplierId,
  setSupplierId,
  deliveryPartyId,
  setDeliveryPartyId,
  counterpartyName,
  setCounterpartyName,
  invoiceId,
  setInvoiceId,
  customerData,
  invoiceQ,
  setInvoiceQ,
  outstandingInvoiceOptions,
  selectedInvoiceLabel,
  setSelectedInvoiceLabel,
  selectedInList,
  invoiceRemaining,
  recent,
  balanceWarn,
}: Props) {
  return (
    <Card>
      <CardHeader className="py-2.5 px-3.5">
        <CardTitle className="text-sm">الطرف المقابل</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-2.5 px-3.5 pb-3.5 pt-0">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Label>نوع الطرف *</Label>
            <span className="text-[11px] text-muted-foreground">
              {partyType === "OTHER" && "تأثير على الصندوق/الدفتر فقط"}
              {partyType === "CUSTOMER" &&
                (isReceipt ? "AR ينقص بقيمة السند" : "AR يَزيد (استرداد)")}
              {partyType === "SUPPLIER" &&
                (isReceipt
                  ? "AP يَزيد (استلام نقد)"
                  : "AP يَنقص (دفعة للمورّد)")}
              {partyType === "DELIVERY_PARTY" &&
                (isReceipt ? "تحصيل عهدة COD" : "صرف مستحقات توصيل")}
            </span>
          </div>
          <AppSelect
            className="h-9"
            value={partyType}
            onValueChange={(value) => {
              const v = value as typeof partyType;
              setPartyType(v);
              setCustomerId(null);
              setSupplierId(null);
              setDeliveryPartyId(null);
              setInvoiceId(null);
            }}
          >
            <option value="OTHER">أخرى (راتب/إيجار/إيرادات متفرّقة…)</option>
            <option value="CUSTOMER">عميل</option>
            <option value="SUPPLIER">مورّد</option>
            <option value="DELIVERY_PARTY">جهة توصيل (COD / مستحقات)</option>
          </AppSelect>
        </div>

        {partyType === "CUSTOMER" && (
          <>
            <CustomerPicker
              customerId={customerId}
              onCustomerChange={(id) => {
                setCustomerId(id);
                setInvoiceId(null);
                setInvoiceQ("");
                setSelectedInvoiceLabel("");
              }}
              balance={customerData.data?.currentBalance}
            />
            {customerId != null && (
              <div className="space-y-1">
                <Label
                  className="flex items-center gap-1"
                  title={
                    !isReceipt
                      ? "هذا سند رد مبلغ للعميل: يسجل صرفاً فعلياً ويحدّث رصيده عند التنفيذ. اختيار فاتورة يخصم المبلغ من مدفوعها، وترك الاختيار فارغاً يرد المبلغ على حساب العميل."
                      : "اترك الاختيار فارغاً ليوزع النظام القبض تلقائياً من أقدم فواتير العميل المؤهلة في هذا الفرع. اختيار فاتورة يخصص القبض لها وحدها."
                  }
                >
                  {isReceipt
                    ? "تخصيص فاتورة محددة (اختياري)"
                    : "ربط الرد بفاتورة (اختياري)"}
                  <Info aria-hidden className="size-3 text-muted-foreground" />
                </Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <UnifiedSearchInput
                    value={invoiceQ}
                    onChange={setInvoiceQ}
                    placeholder="ابحث برقم الفاتورة… (F2)"
                    barcode={true}
                    debounceMs={200}
                    size="default"
                  />
                  <AppSelect
                    value={invoiceId != null ? String(invoiceId) : "0"}
                    onValueChange={(v) => {
                      const id = v === "0" ? null : Number(v);
                      setInvoiceId(id);
                      if (id != null) {
                        const inv = outstandingInvoiceOptions.find(
                          (o) => Number(o.id) === id,
                        );
                        if (inv) {
                          setSelectedInvoiceLabel(
                            `فاتورة #${inv.invoiceNumber} — ${isReceipt ? "متبقٍّ" : "مدفوع"} ${fmt(isReceipt ? invoiceRemaining(inv) : inv.paidAmount)} د.ع`,
                          );
                        }
                      } else {
                        setSelectedInvoiceLabel("");
                      }
                    }}
                    aria-label="ربط السند بفاتورة"
                  >
                    <option value="0">— بلا ربط (توزيع تلقائي) —</option>
                    {invoiceId != null && !selectedInList && (
                      <option value={String(invoiceId)}>
                        {selectedInvoiceLabel || `فاتورة مُختارة #${invoiceId}`}
                      </option>
                    )}
                    {outstandingInvoiceOptions.map((inv) => (
                      <option key={Number(inv.id)} value={String(inv.id)}>
                        فاتورة #{inv.invoiceNumber} —{" "}
                        {isReceipt ? "متبقٍّ" : "مدفوع"}{" "}
                        {fmt(
                          isReceipt ? invoiceRemaining(inv) : inv.paidAmount,
                        )}{" "}
                        د.ع
                      </option>
                    ))}
                  </AppSelect>
                </div>
              </div>
            )}
          </>
        )}
        {partyType === "SUPPLIER" && (
          <SupplierPicker
            supplierId={supplierId}
            onSupplierChange={setSupplierId}
          />
        )}
        {partyType === "DELIVERY_PARTY" && (
          <DeliveryPartyPicker
            partyId={deliveryPartyId}
            onPartyChange={setDeliveryPartyId}
            branchId={branchId}
          />
        )}
        {partyType === "OTHER" && (
          <div className="space-y-1">
            <Label title="مَوصى به — يُمكّن تَقرير «كل ما دُفع/قُبض من فلان» (مفيد للرواتب والإيجارات المُكرَّرة).">
              اسم المُستفيد / الدافع
            </Label>
            <Input
              value={counterpartyName}
              onChange={(e) => setCounterpartyName(e.target.value)}
              placeholder={
                isReceipt
                  ? "مَثلاً: المستثمر / شركة الإعلان — تَحصيل"
                  : "مَثلاً: المستثمر (مثل: سلمى أحمد) / الموظف أحمد محمد"
              }
            />
          </div>
        )}

        {balanceWarn && (
          <div className="rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] text-xs p-2 flex items-start gap-2">
            <AlertTriangle aria-hidden className="size-4 shrink-0 mt-0.5" />
            <span>{balanceWarn}</span>
          </div>
        )}

        {(recent.data ?? []).length > 0 && (
          <div className="rounded-md border bg-muted/30 p-2 text-[12px] space-y-1">
            <div className="font-bold text-foreground flex items-center gap-1">
              <Info aria-hidden className="size-3.5" />
              آخر سندات لنفس الطَرف (7 أيام):
            </div>
            {(recent.data ?? []).map((r) => (
              <div
                key={Number(r.id)}
                className="flex items-center justify-between gap-2 text-muted-foreground"
              >
                <span className="truncate">
                  {r.voucherNumber} — {r.direction === "IN" ? "قبض" : "صرف"}
                  {r.approvalStatus === "PENDING_APPROVAL" ? (
                    <Hourglass aria-hidden className="inline size-3 ms-1" />
                  ) : null}
                </span>
                <span className="tabular-nums shrink-0" dir="ltr">
                  {fmt(r.amount)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
