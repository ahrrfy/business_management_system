import { MovementTypeBadge } from "@/components/common/MovementBadges";
import { ErrorState, LoadingState } from "@/components/PageState";
import { PurchaseDetailDrawer } from "@/components/purchases/PurchaseDetailDrawer";
import { AccountHealthBanner } from "@/components/statements/AccountHealthBanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QuickVoucherSheet } from "@/components/vouchers/QuickVoucherSheet";
import { VoucherDetailDrawer } from "@/components/vouchers/VoucherDetailDrawer";
import { fmtDate } from "@/lib/date";
import { D, fmt } from "@/lib/money";
import { trpc } from "@/lib/trpc";
import { treasuryOperationAllowed } from "@/lib/treasuryOperationAccess";
import { openWhatsApp, toIraqiIntl } from "@/lib/whatsapp";
import { balanceDirectionLabel } from "@shared/balanceTrail";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  FileText,
  MessageSquare,
  PhoneCall,
  RotateCcw,
} from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";

export interface SupplierDossierDrawerProps {
  supplierId: number | null;
  open: boolean;
  onClose: () => void;
}

export function SupplierDossierDrawer(props: SupplierDossierDrawerProps) {
  if (!props.open || !props.supplierId) return null;
  return <SupplierDossierSession key={props.supplierId} {...props} supplierId={props.supplierId} />;
}

function SupplierDossierSession({
  supplierId,
  open,
  onClose,
}: {
  supplierId: number;
  open: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canWriteVoucher = treasuryOperationAllowed(
    me.data,
    "vouchers.create",
    me.data?.role === "manager" || me.data?.role === "accountant" || Boolean(me.data?.isOwner),
  );
  const [quickVoucherType, setQuickVoucherType] = useState<"PAYMENT" | "RECEIPT" | null>(null);
  const [selectedPoId, setSelectedPoId] = useState<number | null>(null);
  const [selectedVoucherId, setSelectedVoucherId] = useState<number | null>(null);

  const supplierQ = trpc.suppliers.get.useQuery({ supplierId }, { enabled: open && supplierId > 0 });
  const stmtQ = trpc.reports.supplierStatement.useQuery({ supplierId }, { enabled: open && supplierId > 0 });

  const s = stmtQ.data?.supplier ?? supplierQ.data;
  const summary = stmtQ.data?.summary;
  const iqdBal = D(summary?.currentBalance ?? s?.currentBalance ?? 0);
  const usdBal = D(s?.currentBalanceUsd ?? 0);
  const intlPhone = toIraqiIntl(s?.phone);

  function refreshAll() {
    void utils.suppliers.invalidate();
    void utils.reports.invalidate();
    void utils.vouchers.invalidate();
  }

  return (
    <>
      <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
        <SheetContent side="right" dir="rtl" className="w-full sm:max-w-2xl overflow-y-auto p-4 sm:p-6">
          <SheetHeader className="pb-3 border-b space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <SheetTitle className="text-lg font-bold flex items-center gap-2">
                  <Building2 aria-hidden className="size-5 text-primary" />
                  <span>{s?.name ?? "ملف المورد 360°"}</span>
                </SheetTitle>
                <SheetDescription className="text-xs mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span>رقم المورد: #{supplierId}</span>
                  {(s as { supplierKind?: string } | undefined)?.supplierKind === "CONSIGNOR" ? (
                    <Badge variant="warning">مودع أمانة</Badge>
                  ) : (
                    <Badge variant="neutral">مورد اعتيادي</Badge>
                  )}
                  {s?.paymentTerms ? <span>· {s.paymentTerms}</span> : null}
                </SheetDescription>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs"
                onClick={() => refreshAll()}
                disabled={stmtQ.isFetching}
              >
                <RotateCcw aria-hidden className={`size-3.5 ${stmtQ.isFetching ? "animate-spin" : ""}`} />
                <span>تحديث</span>
              </Button>
            </div>
          </SheetHeader>

          {stmtQ.isLoading && !s && <LoadingState />}
          {stmtQ.isError && <ErrorState message={stmtQ.error.message} onRetry={() => void stmtQ.refetch()} />}

          {s && (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-1.5">
                {canWriteVoucher && (
                  <>
                    <Button type="button" size="sm" className="gap-1 text-xs" onClick={() => setQuickVoucherType("PAYMENT")}>
                      <ArrowUpRight aria-hidden className="size-3.5" />
                      <span>سند صرف</span>
                    </Button>
                    <Button type="button" size="sm" variant="outline" className="gap-1 text-xs" onClick={() => setQuickVoucherType("RECEIPT")}>
                      <ArrowDownLeft aria-hidden className="size-3.5" />
                      <span>سند قبض</span>
                    </Button>
                  </>
                )}
                <Button asChild type="button" size="sm" variant="outline" className="gap-1 text-xs">
                  <Link href={`/suppliers-statement?id=${supplierId}`}>
                    <FileText aria-hidden className="size-3.5" />
                    <span>كشف الحساب الكامل</span>
                  </Link>
                </Button>
                {intlPhone && (
                  <Button asChild type="button" size="sm" variant="outline" className="gap-1 text-xs">
                    <a href={`tel:${intlPhone}`}>
                      <PhoneCall aria-hidden className="size-3.5" />
                      <span>اتصال</span>
                    </a>
                  </Button>
                )}
                {s.phone && (
                  <Button type="button" size="sm" variant="outline" className="gap-1 text-xs" onClick={() => openWhatsApp(s.phone!, "")}>
                    <MessageSquare aria-hidden className="size-3.5" />
                    <span>واتساب</span>
                  </Button>
                )}
              </div>

              <AccountHealthBanner partyType="SUPPLIER" partyId={supplierId} onResolved={refreshAll} />

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
                <Card className="p-2.5 space-y-0.5">
                  <div className="text-muted-foreground">الرصيد الحالي (د.ع)</div>
                  <div className={`text-sm font-bold tabular-nums ${iqdBal.gt(0) ? "text-money-negative" : iqdBal.lt(0) ? "text-money-positive" : ""}`} dir="ltr">
                    {fmt(iqdBal.abs().toFixed(2))}
                  </div>
                  <div className="font-semibold text-[11px]">{balanceDirectionLabel("SUPPLIER", iqdBal)}</div>
                </Card>

                <Card className="p-2.5 space-y-0.5">
                  <div className="text-muted-foreground">مرجع الفواتير الدولارية</div>
                  <div className="text-sm font-bold tabular-nums" dir="ltr">
                    {usdBal.isZero() ? "$0" : `$${fmt(usdBal.abs().toFixed(2))}`}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {usdBal.isZero() ? "لا ذمة دولارية" : `${balanceDirectionLabel("SUPPLIER", usdBal)} · مشمول بالدينار`}
                  </div>
                </Card>

                <Card className="p-2.5 space-y-0.5">
                  <div className="text-muted-foreground">دفعات غير مخصصة</div>
                  <div className="text-sm font-bold tabular-nums" dir="ltr">
                    {fmt(summary?.unallocatedPayments ?? 0)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">متاح للتسوية</div>
                </Card>

                <Card className="p-2.5 space-y-0.5">
                  <div className="text-muted-foreground">غير مدفوع بالأوامر</div>
                  <div className="text-sm font-bold tabular-nums" dir="ltr">
                    {fmt(summary?.unpaid ?? 0)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{s.city ?? "—"}</div>
                </Card>
              </div>

              {stmtQ.data && (
                <Tabs defaultValue="orders" className="w-full">
                  <TabsList>
                    <TabsTrigger value="orders" className="text-xs">أوامر الشراء ({stmtQ.data.purchaseOrders.length})</TabsTrigger>
                    <TabsTrigger value="payments" className="text-xs">السندات والدفعات ({stmtQ.data.payments.length})</TabsTrigger>
                    <TabsTrigger value="grni" className="text-xs">غير مفوترة ({stmtQ.data.unbilledReceipts?.length ?? 0})</TabsTrigger>
                  </TabsList>

                  <TabsContent value="orders" className="mt-2 space-y-1.5">
                    {stmtQ.data.purchaseOrders.slice(0, 20).map((po) => (
                      <button
                        key={po.id}
                        type="button"
                        onClick={() => setSelectedPoId(Number(po.id))}
                        className="w-full text-start flex items-center justify-between gap-2 rounded-md border p-2 hover:bg-muted/40 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <MovementTypeBadge kind="PURCHASE" />
                          <span className="font-mono font-semibold" dir="ltr">{po.poNumber}</span>
                          <span className="text-muted-foreground">{fmtDate(po.orderDate)}</span>
                        </div>
                        <span className="font-bold tabular-nums" dir="ltr">{fmt(po.total)} د.ع</span>
                      </button>
                    ))}
                    {stmtQ.data.purchaseOrders.length === 0 && (
                      <p className="py-4 text-center text-xs text-muted-foreground">لا أوامر شراء.</p>
                    )}
                  </TabsContent>

                  <TabsContent value="payments" className="mt-2 space-y-1.5">
                    {stmtQ.data.payments.slice(0, 20).map((p, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <MovementTypeBadge kind={p.entryType} />
                          <span className="font-mono" dir="ltr">{p.voucherNumber ?? "—"}</span>
                          <span className="text-muted-foreground">{fmtDate(p.entryDate)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold tabular-nums" dir="ltr">{fmt(p.amount)} د.ع</span>
                          {p.receiptId && (
                            <Button type="button" size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => setSelectedVoucherId(Number(p.receiptId))}>
                              معاينة
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                    {stmtQ.data.payments.length === 0 && (
                      <p className="py-4 text-center text-xs text-muted-foreground">لا حركات دفع.</p>
                    )}
                  </TabsContent>

                  <TabsContent value="grni" className="mt-2 space-y-1.5">
                    {(stmtQ.data.unbilledReceipts ?? []).map((r) => (
                      <div key={r.goodsReceiptId} className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs">
                        <div>
                          <span className="font-semibold">{r.receiptNumber}</span>
                          {r.poNumber ? <span className="text-muted-foreground ms-2">({r.poNumber})</span> : null}
                        </div>
                        <span className="font-bold tabular-nums" dir="ltr">{fmt(r.totalAmount)} د.ع</span>
                      </div>
                    ))}
                    {(stmtQ.data.unbilledReceipts ?? []).length === 0 && (
                      <p className="py-4 text-center text-xs text-muted-foreground">لا استلامات بانتظار الفوترة.</p>
                    )}
                  </TabsContent>
                </Tabs>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {canWriteVoucher && quickVoucherType && (
        <QuickVoucherSheet
          open={!!quickVoucherType}
          onOpenChange={(o) => !o && setQuickVoucherType(null)}
          defaultType={quickVoucherType}
          defaultPartyType="SUPPLIER"
          defaultPartyId={supplierId}
          defaultPartyName={s?.name}
          currentBalance={summary?.currentBalance ?? s?.currentBalance ?? undefined}
          onSuccess={refreshAll}
        />
      )}

      <PurchaseDetailDrawer purchaseOrderId={selectedPoId} onClose={() => setSelectedPoId(null)} />
      <VoucherDetailDrawer voucherId={selectedVoucherId} open={selectedVoucherId != null} onOpenChange={(o) => !o && setSelectedVoucherId(null)} onActionSuccess={refreshAll} />
    </>
  );
}
