import { useCallback, useEffect, useRef, useState } from "react";
import { D } from "@/lib/money";
import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";
import { getDeviceCode } from "@/lib/offline/outbox";
import { financialIntentScopeKey, loadFinancialIntent, reserveFinancialIntent, resolveFinancialIntent,
  type FinancialIntent, type FinancialIntentScope } from "@/lib/persistedFinancialIntent";

type Prepare = RouterInputs["digitalCards"]["sales"]["prepare"];
type Finalized = RouterOutputs["digitalCards"]["sales"]["finalize"];
export type ReceptionDigitalCommand = {
  version: 1; prepare: Omit<Prepare, "externalPaymentAttemptId" | "externalPaymentDeviceId" | "managerApproval"> & { paymentMethod: "CASH" | "CARD" };
  amount: string; tenderedAmount?: string; customerName: string | null; captureConfirmed: true;
  reference: string | null; deviceId: string | null;
};
type Active = { scope: FinancialIntentScope; envelope: FinancialIntent<ReceptionDigitalCommand>; intentId: number | null; attemptId: number | null };

/** Saves the exact command before confirming payment or issuing a provider code. */
export function useReceptionDigitalCheckout(input: {
  scope: FinancialIntentScope | null;
  onPrepared: (intentId: number) => void;
  onCompleted: (result: Finalized, command: ReceptionDigitalCommand) => void;
  onRefunded?: (amount: string) => void;
}) {
  const callbacks = useRef(input); callbacks.current = input;
  const scopeKey = input.scope ? financialIntentScopeKey(input.scope) : "";
  const currentKey = useRef(scopeKey); currentKey.current = scopeKey;
  const active = useRef<Active | null>(null);
  const running = useRef(false);
  const [loadedKey, setLoadedKey] = useState("");
  const [pendingKey, setPendingKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prepare = trpc.digitalCards.sales.prepare.useMutation();
  const finalize = trpc.digitalCards.sales.finalize.useMutation();
  const initiate = trpc.reception.initiateExternalPayment.useMutation();
  const confirm = trpc.reception.confirmExternalPayment.useMutation();
  const utils = trpc.useUtils();

  const finish = useCallback(async (saved: Active) => {
    if (currentKey.current !== financialIntentScopeKey(saved.scope)) return;
    if (saved.intentId == null) throw new Error("استعد النيّة الأصلية قبل التثبيت");
    const command = saved.envelope.payload;
    const result = await finalize.mutateAsync({ intentId: saved.intentId, clientRequestId: saved.envelope.id, paymentAmount: command.amount,
      paymentMethod: command.prepare.paymentMethod, customerId: command.prepare.customerId });
    await resolveFinancialIntent(saved.scope, saved.envelope.id);
    if (currentKey.current === financialIntentScopeKey(saved.scope)) {
      active.current = null; setPendingKey(""); callbacks.current.onCompleted(result, command);
    }
  }, [finalize.mutateAsync]);

  const resume = useCallback(async (saved: Active) => {
    const key = financialIntentScopeKey(saved.scope);
    if (currentKey.current !== key) return;
    const command = saved.envelope.payload;
    if (command.version !== 1 || !command.captureConfirmed || command.prepare.sourceType !== "RECEPTION"
      || command.prepare.branchId !== saved.scope.branchId || command.prepare.clientRequestId !== saved.envelope.id
      || !["CASH", "CARD"].includes(command.prepare.paymentMethod)) throw new Error("الأمر المحفوظ غير متوافق؛ أبقه للمراجعة دون إصدار أو قبض جديد");
    if (command.prepare.paymentMethod === "CARD") {
      if (!command.deviceId || !command.reference) throw new Error("إثبات القبض المحفوظ غير مكتمل؛ راجع العملية دون تمرير البطاقة ثانيةً");
      const proof = await initiate.mutateAsync({ branchId: saved.scope.branchId, method: "CARD", amount: command.amount,
        reference: command.reference, requestId: `${saved.envelope.id}:card`, deviceId: command.deviceId });
      if (proof.state !== "CONFIRMED") await confirm.mutateAsync({ branchId: saved.scope.branchId, attemptId: proof.attemptId, deviceId: command.deviceId });
      saved.attemptId = proof.attemptId;
    }
    if (currentKey.current !== key) return;
    const result = await prepare.mutateAsync({ ...command.prepare,
      capturedDigitalPayment: { amount: command.amount, confirmed: true, deviceId: command.deviceId ?? await getDeviceCode() },
      externalPaymentAttemptId: saved.attemptId ?? undefined, externalPaymentDeviceId: command.prepare.paymentMethod === "CARD" ? command.deviceId ?? undefined : undefined });
    saved.intentId = result.intentId;
    const view = await utils.digitalCards.sales.getIntent.fetch({ intentId: result.intentId });
    if (view.intent.status === "FINALIZED") { await finish(saved); return; }
    if (view.intent.status === "CANCELLED" && view.financialSettlement?.status === "COMPLETED" && view.financialSettlement.saleAmount === "0.00" && D(view.financialSettlement.refundAmount).eq(command.amount)) {
      await resolveFinancialIntent(saved.scope, saved.envelope.id);
      if (currentKey.current === key) { active.current = null; setPendingKey(""); callbacks.current.onRefunded?.(view.financialSettlement.refundAmount); }
      return;
    }
    if (["NEEDS_REVIEW", "CANCELLED", "EXPIRED", "WRITEOFF_PENDING", "WRITTEN_OFF"].includes(view.intent.status)) {
      throw new Error("العملية الأصلية تحتاج مراجعة المدير؛ لا تصدر بديلاً ولا تقبض أو ترد المبلغ مرة ثانية");
    }
    if (currentKey.current === key) callbacks.current.onPrepared(result.intentId);
  }, [initiate.mutateAsync, confirm.mutateAsync, prepare.mutateAsync, utils.digitalCards.sales.getIntent.fetch, finish]);

  useEffect(() => {
    if (!input.scope) return;
    const capturedScope = input.scope;
    let cancelled = false;
    setError(null); active.current = null;
    void (async () => {
      try {
        const envelope = await loadFinancialIntent<ReceptionDigitalCommand>(capturedScope);
        if (cancelled || currentKey.current !== scopeKey) return;
        if (envelope) {
          active.current = { scope: capturedScope, envelope, intentId: null, attemptId: null };
          setPendingKey(scopeKey);
        } else setPendingKey("");
        setLoadedKey(scopeKey);
      } catch (failure) { if (!cancelled) setError(failure instanceof Error ? failure.message : "تعذّرت قراءة عملية الكروت المحفوظة"); }
    })();
    return () => { cancelled = true; };
  }, [scopeKey]);

  async function perform(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "تعذّر استكمال العملية؛ احتفظ بالأصل دون تكرار القبض أو الإصدار"); throw failure; }
    finally { running.current = false; setBusy(false); }
  }

  async function start(candidate: Omit<ReceptionDigitalCommand, "version" | "deviceId">) {
    if (!input.scope || loadedKey !== scopeKey) throw new Error("انتظر قراءة سجل العمليات المحفوظة قبل بدء قبض جديد");
    return perform(async () => {
      const capturedScope = input.scope!;
      const proposed: FinancialIntent<ReceptionDigitalCommand> = { id: candidate.prepare.clientRequestId, createdAt: new Date().toISOString(),
        payload: { ...candidate, version: 1, deviceId: await getDeviceCode() } };
      const envelope = await reserveFinancialIntent(capturedScope, proposed);
      const saved: Active = { scope: capturedScope, envelope, intentId: null, attemptId: null };
      active.current = saved; setPendingKey(scopeKey);
      await resume(saved);
    });
  }

  async function retry() {
    const saved = active.current;
    if (!saved || financialIntentScopeKey(saved.scope) !== scopeKey) return;
    return perform(() => resume(saved));
  }

  async function finalizePrepared(intentId: number) {
    const saved = active.current;
    if (!saved || saved.intentId !== intentId || financialIntentScopeKey(saved.scope) !== scopeKey) throw new Error("استعد أمر البيع الأصلي قبل التثبيت");
    return perform(() => finish(saved));
  }
  return { start, retry, finalizePrepared, busy, error, ready: !!scopeKey && loadedKey === scopeKey, pending: pendingKey === scopeKey && !!scopeKey };
}
