import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtAr, D } from "@/lib/money";
import type { DigitalRefundMethod } from "@shared/digitalPaymentSettlement";
import React, { useEffect, useState } from "react";

export function DigitalRefundTenderFields(props: {
  originalMethod: string; amount: string; method: DigitalRefundMethod; onMethod: (method: DigitalRefundMethod) => void;
  reference: string; onReference: (value: string) => void; confirmed: boolean; onConfirmed: (value: boolean) => void;
  reserved: boolean; evidenced: boolean; busy: boolean; onRecord: () => void; onReserve: () => void;
  onRelease: (reason: string) => void; grantToken: string | null; reservationExpiresAt?: Date | string | null; methodLocked?: boolean;
}) {
  const noPayout = !D(props.amount).gt(0);
  const [noRefund, setNoRefund] = useState(false);
  const [releaseReason, setReleaseReason] = useState("");
  const [, refreshClock] = useState(0);
  const expiresAt = props.reservationExpiresAt instanceof Date ? props.reservationExpiresAt.getTime() : props.reservationExpiresAt ? Date.parse(props.reservationExpiresAt) : 0;
  const leaseActive = expiresAt > Date.now();
  const mayOperate = !!props.grantToken && leaseActive;
  useEffect(() => { if (!leaseActive) return; const timer = setTimeout(() => refreshClock((value) => value + 1), Math.max(1, expiresAt - Date.now() + 10)); return () => clearTimeout(timer); }, [expiresAt]);
  useEffect(() => { setNoRefund(false); setReleaseReason(""); }, [props.reserved, props.evidenced]);
  return <fieldset className="space-y-3 border p-3" disabled={props.busy || noPayout}>
    <legend className="px-1 text-sm font-medium">رد العميل: {fmtAr(props.amount)} د.ع</legend>
    {noPayout ? <p className="text-sm">لا يوجد مبلغ يُصرف للعميل.</p> : <>
      <label className="flex items-center gap-2 text-sm"><input type="radio" name="digital-refund-method" checked={props.method === "CASH"}
        disabled={props.reserved || props.evidenced || props.methodLocked} onChange={() => props.onMethod("CASH")} /> صرف نقدي معتمد من خزينة الفرع</label>
      {props.originalMethod === "CARD" && <label className="flex items-center gap-2 text-sm"><input type="radio" name="digital-refund-method"
        checked={props.method === "CARD"} disabled={props.reserved || props.evidenced || props.methodLocked} onChange={() => props.onMethod("CARD")} /> رد إلى البطاقة الأصلية</label>}
      {props.method === "CASH" ? <p className="text-xs text-muted-foreground">يُثبت الصرف من الخزينة؛ يظل قبض البطاقة الأصلي محفوظاً كما وقع.</p> : !props.reserved && !props.evidenced
        ? <><p className="text-sm">احجز المبلغ والبنود قبل تنفيذ أي رد على جهاز الدفع.</p><Button type="button" size="sm" variant="outline" onClick={props.onReserve}>حجز مبلغ رد البطاقة</Button></> : <>
        {!props.evidenced && <p role="status" className="text-sm">{mayOperate ? "الحجز خُصص لهذه النافذة. نفّذ الرد مرة واحدة بالمبلغ المحدد ثم احفظ إثباته." : "هذا حجز قائم من محاولة سابقة. راجع سجل الجهاز؛ لا تنفّذ رداً جديداً. أثبت نجاح السابق أو حرر حجزاً لم يُنفّذ يقيناً."}</p>}
        <label className="block text-sm">مرجع نجاح رد البطاقة<Input dir="ltr" value={props.reference} maxLength={100} readOnly={props.evidenced}
          onChange={(event) => props.onReference(event.target.value)} /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={props.confirmed} disabled={props.evidenced}
          onChange={(event) => props.onConfirmed(event.target.checked)} /> تحققت من نجاح رد المبلغ إلى البطاقة الأصلية على جهاز الدفع</label>
        {props.evidenced ? <p role="status" className="text-sm">إثبات الرد محفوظ. أكمل الاعتماد المالي دون تكرار الرد على الجهاز.</p>
          : <><Button type="button" size="sm" variant="outline" disabled={!props.confirmed || !props.reference.trim()} onClick={props.onRecord}>حفظ إثبات رد البطاقة</Button>
            <details className="border-t pt-2 text-sm"><summary>تحرير حجز رد لم يُنفّذ</summary>
              <p className="my-2">النتيجة المجهولة تبقى للمراجعة. لا تحرر الحجز إذا نجح الرد أو تعذّر التأكد من نتيجته.</p>
              <label className="flex items-start gap-2"><input type="checkbox" checked={noRefund} onChange={(event) => setNoRefund(event.target.checked)} /> تحققت من الجهاز أن الرد لم يُنفّذ أو فشل يقيناً</label>
              <Input aria-label="سبب تحرير حجز الرد" value={releaseReason} maxLength={300} onChange={(event) => setReleaseReason(event.target.value)} />
              <Button type="button" variant="outline" size="sm" disabled={!noRefund || releaseReason.trim().length < 5 || (leaseActive && !mayOperate)} onClick={() => props.onRelease(releaseReason.trim())}>تحرير الحجز دون صرف</Button>
            </details></>}
      </>}
    </>}
  </fieldset>;
}
