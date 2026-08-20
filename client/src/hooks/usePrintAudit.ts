import { trpc } from "@/lib/trpc";
import type { PrintChannel, PrintDocumentType } from "@shared/printAudit";

const newRequestId = () => typeof crypto !== "undefined" && "randomUUID" in crypto
  ? crypto.randomUUID()
  : `print-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export interface PrintAuditMetadata {
  requestId: string;
  actorName: string;
  requestedAt: Date | string;
  reprint: boolean;
}

/** يسجل REQUESTED ثم نتيجة النقل كسطر append-only آخر؛ BROWSER لا يتحول أبداً إلى PRINTED. */
export function usePrintAudit() {
  const requestPurchase = trpc.printAudit.requestPurchase.useMutation();
  const requestTreasury = trpc.printAudit.requestTreasury.useMutation();
  const requestReport = trpc.printAudit.requestReport.useMutation();
  const outcomePurchase = trpc.printAudit.outcomePurchase.useMutation();
  const outcomeTreasury = trpc.printAudit.outcomeTreasury.useMutation();
  const outcomeReport = trpc.printAudit.outcomeReport.useMutation();

  async function run<T extends boolean | { via: "server" | "thermal" | "browser" }>(input: {
    documentType: PrintDocumentType;
    documentId: number;
    branchId?: number | null;
    channel: PrintChannel;
    open: (metadata: PrintAuditMetadata) => Promise<T> | T;
  }): Promise<T> {
    const requestId = newRequestId();
    const requestInput = {
      requestId,
      documentId: input.documentId,
      branchId: input.branchId ?? null,
      channel: input.channel,
      copies: 1,
    };
    const authority = input.documentType === "PURCHASE_RETURN" ? "purchase" : input.documentType === "EXCHANGE_TRANSACTION" || input.documentType === "VOUCHER" ? "treasury" : "report";
    const audit = authority === "purchase"
      ? await requestPurchase.mutateAsync({ ...requestInput, documentType: "PURCHASE_RETURN" })
      : authority === "treasury"
        ? await requestTreasury.mutateAsync({ ...requestInput, documentType: input.documentType as "EXCHANGE_TRANSACTION" | "VOUCHER" })
        : await requestReport.mutateAsync({ ...requestInput, documentType: input.documentType as "CUSTOMER_STATEMENT" | "SUPPLIER_STATEMENT" });
    const complete = authority === "purchase" ? outcomePurchase : authority === "treasury" ? outcomeTreasury : outcomeReport;
    try {
      const result = await input.open({ ...audit, requestId });
      const success = typeof result === "boolean" ? result : true;
      const via = typeof result === "boolean" ? input.channel : result.via === "server" ? "SERVER_BRIDGE" : result.via === "thermal" ? "THERMAL" : "BROWSER";
      await complete.mutateAsync({
        requestId,
        outcome: success ? (via === "BROWSER" || via === "PDF" ? "DIALOG_OPENED" : "DISPATCHED") : "FAILED",
        failureCode: success ? undefined : "POPUP_BLOCKED",
      });
      return result;
    } catch (error) {
      await complete.mutateAsync({ requestId, outcome: "FAILED", failureCode: error instanceof Error ? error.name.slice(0, 80) : "UNKNOWN" }).catch(() => undefined);
      throw error;
    }
  }

  return {
    run,
    pending: requestPurchase.isPending || requestTreasury.isPending || requestReport.isPending
      || outcomePurchase.isPending || outcomeTreasury.isPending || outcomeReport.isPending,
  };
}
