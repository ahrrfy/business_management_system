import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { getDeviceCode } from "@/lib/offline/outbox";
import { notify } from "@/lib/notify";
import {
  tenderAmount,
  tenderFingerprint,
  tenderPayments,
  tenderProblem,
  tenderTotals,
  type TenderPart,
  type TenderProof,
} from "./splitTender";
import { readTenderParts, readTenderProof, storeTender } from "./tenderStorage";

export function useSplitTender(input: {
  branchId: number;
  ownerId?: number;
  sessionKey: string;
  channel: "POS" | "RECEPTION";
  canConfirm: boolean;
  disabled?: boolean;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [parts, setParts] = useState<TenderPart[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const busy = useRef(false);
  const currentInput = useRef(input);
  currentInput.current = input;
  const proofCache = useRef(new Map<string, TenderProof>());
  const scope = `${input.ownerId ?? 0}:${input.branchId}:${input.channel}:${input.sessionKey}`;
  const draftKey = `split-tender-draft:${scope}`;
  const [readyScope, setReadyScope] = useState("");
  const currentParts = readyScope === scope ? parts : [];
  const cacheKey = (fingerprint: string) =>
    `split-tender-proof:${scope}:${fingerprint}`;
  const restore = (fingerprint: string): TenderProof | null => {
    return (
      proofCache.current.get(fingerprint) ??
      readTenderProof(cacheKey(fingerprint))
    );
  };
  const remember = (proof: TenderProof, epoch: number) => {
    const latest = currentInput.current;
    if (
      epoch === requestEpoch.current &&
      `${latest.ownerId ?? 0}:${latest.branchId}:${latest.channel}:${latest.sessionKey}` ===
        scope
    )
      proofCache.current.set(proof.fingerprint, proof);
    storeTender(cacheKey(proof.fingerprint), proof);
  };
  useEffect(() => {
    requestEpoch.current += 1;
    busy.current = false;
    setPendingId(null);
    setEditorOpen(false);
    setParts(readTenderParts(draftKey));
    setReadyScope(scope);
    setError(null);
    proofCache.current.clear();
    return () => {
      requestEpoch.current += 1;
    };
  }, [scope]);
  useEffect(() => {
    if (readyScope === scope) storeTender(draftKey, parts);
  }, [parts, scope, readyScope]);
  const router = input.channel === "POS" ? trpc.sales : trpc.reception;
  const start = router.initiateExternalPayment.useMutation();
  const finish = router.confirmExternalPayment.useMutation();
  function update(
    id: string,
    patch: Partial<Pick<TenderPart, "method" | "amount" | "reference">>,
  ) {
    if (readyScope !== scope) return;
    setError(null);
    setParts((previous) =>
      previous.map((part) => {
        if (part.id !== id) return part;
        const next = { ...part, ...patch };
        const fingerprint = tenderFingerprint(
          input.branchId,
          input.channel,
          next,
        );
        return {
          ...next,
          proof:
            next.method === "CASH"
              ? null
              : part.proof?.fingerprint === fingerprint
                ? part.proof
                : restore(fingerprint),
        };
      }),
    );
  }
  async function confirm(id: string) {
    const part = parts.find((p) => p.id === id);
    if (
      readyScope !== scope ||
      !part ||
      part.method === "CASH" ||
      busy.current ||
      input.disabled
    )
      return;
    if (!input.canConfirm)
      return setError("تأكيد الدفع الخارجي غير مفوّض لحسابك.");
    if (
      !input.branchId ||
      !part.reference.trim() ||
      !tenderAmount(part.amount).gt(0)
    )
      return setError("حدّد الفرع ومبلغ الدفعة ومرجع العملية أولاً.");
    const fingerprint = tenderFingerprint(input.branchId, input.channel, part);
    const epoch = requestEpoch.current;
    const stillCurrent = () =>
      epoch === requestEpoch.current &&
      currentInput.current.branchId === input.branchId &&
      currentInput.current.ownerId === input.ownerId &&
      currentInput.current.channel === input.channel &&
      currentInput.current.sessionKey === input.sessionKey &&
      currentInput.current.canConfirm &&
      !currentInput.current.disabled;
    busy.current = true;
    setPendingId(id);
    setError(null);
    try {
      let proof =
        part.proof?.fingerprint === fingerprint
          ? part.proof
          : restore(fingerprint);
      const deviceId = proof?.deviceId ?? (await getDeviceCode());
      const requestId = proof?.requestId ?? crypto.randomUUID();
      if (!proof) {
        const args = {
          branchId: input.branchId,
          method: part.method,
          amount: tenderAmount(part.amount).toFixed(2),
          reference: part.reference.trim(),
          requestId,
          deviceId,
        };
        const result = await start.mutateAsync({
          ...args,
          ...(input.channel === "POS" ? { channel: "POS" as const } : {}),
        });
        proof = {
          attemptId: result.attemptId,
          requestId,
          deviceId,
          fingerprint,
          confirmed: false,
        };
        remember(proof, epoch);
      }
      if (!stillCurrent()) return;
      if (!proof.confirmed) {
        await finish.mutateAsync({
          branchId: input.branchId,
          attemptId: proof.attemptId,
          deviceId,
          ...(input.channel === "POS" ? { channel: "POS" as const } : {}),
        });
        proof = { ...proof, confirmed: true };
        remember(proof, epoch);
      }
      if (!stillCurrent()) return;
      const confirmed = proof;
      setParts((previous) =>
        previous.map((p) =>
          p.id === id &&
          tenderFingerprint(input.branchId, input.channel, p) === fingerprint
            ? { ...p, proof: confirmed }
            : p,
        ),
      );
      notify.ok("تأكدت الدفعة الخارجية؛ ستُربط بالفاتورة مرة واحدة عند الحفظ.");
    } catch (cause) {
      if (epoch === requestEpoch.current)
        setError(cause instanceof Error ? cause.message : "تعذر تأكيد الدفعة.");
    } finally {
      if (epoch === requestEpoch.current) {
        busy.current = false;
        setPendingId(null);
      }
    }
  }
  function reset(committed = false) {
    if (committed)
      for (const part of parts) {
        const fingerprint = tenderFingerprint(
          input.branchId,
          input.channel,
          part,
        );
        proofCache.current.delete(fingerprint);
        storeTender(cacheKey(fingerprint), null);
      }
    storeTender(draftKey, null);
    requestEpoch.current += 1;
    busy.current = false;
    setPendingId(null);
    setEditorOpen(false);
    setParts([]);
    setError(null);
  }
  return {
    ready: readyScope === scope,
    editorOpen: readyScope === scope && editorOpen,
    setEditorOpen,
    parts: currentParts,
    pendingId,
    error,
    active: currentParts.length > 0,
    tendered: currentParts
      .reduce((sum, p) => sum.plus(tenderAmount(p.amount)), tenderAmount("0"))
      .toFixed(2),
    hasCash: currentParts.some((p) => p.method === "CASH"),
    hasNonCash: currentParts.some((p) => p.method !== "CASH"),
    enable: (due: string) =>
      setParts([
        {
          id: crypto.randomUUID(),
          method: "CASH",
          amount: tenderAmount(due).toFixed(2),
          reference: "",
          proof: null,
        },
        {
          id: crypto.randomUUID(),
          method: "CARD",
          amount: "",
          reference: "",
          proof: null,
        },
      ]),
    add: () =>
      setParts((previous) =>
        previous.length < 10
          ? [
              ...previous,
              {
                id: crypto.randomUUID(),
                method: "CARD",
                amount: "",
                reference: "",
                proof: null,
              },
            ]
          : previous,
      ),
    remove: (id: string) =>
      setParts((previous) => previous.filter((p) => p.id !== id)),
    update,
    confirm,
    reset,
    totals: (due: string) => tenderTotals(currentParts, due),
    problem: (due: string) =>
      tenderProblem(currentParts, due, input.branchId, input.channel),
    payments: (due: string) => {
      const problem = tenderProblem(
        currentParts,
        due,
        input.branchId,
        input.channel,
      );
      if (problem) {
        setError(problem);
        return null;
      }
      return tenderPayments(currentParts);
    },
  };
}
export type SplitTenderDraft = ReturnType<typeof useSplitTender>;
