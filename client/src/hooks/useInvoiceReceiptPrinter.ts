import { useEffect, useRef } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { getMeta, setMeta } from "@/lib/offline/db";
import { printReceipt } from "@/lib/printing/print";
import { releaseReservedPrintWindow } from "@/lib/printing/brand";
import {
  hasOperationPolicy,
  operationDecision,
} from "@shared/operationPermissions";
import { buildBrandedReceipt, type Receipt } from "@/components/pos/posShared";

export function useInvoiceReceiptPrinter(
  user: RouterOutputs["auth"]["me"] | undefined,
  offlineUserId: number | null | undefined,
) {
  const requestPrint = trpc.invoicePrinting.requestPrint.useMutation();
  const requestReprint = trpc.invoicePrinting.requestReprint.useMutation();
  const receiptPrinting = useRef(false);
  useEffect(() => {
    if (!user) return;
    void setMeta(
      "invoicePrintPolicyMode",
      JSON.stringify({ userId: user.id, canonical: hasOperationPolicy(user) }),
    );
  }, [user]);

  async function printAuthorizedReceipt(rec: Receipt, reprint = false) {
    if (receiptPrinting.current)
      return { ok: false as const, via: "browser" as const };
    receiptPrinting.current = true;
    try {
      if (rec.invoiceId > 0) {
        await (reprint ? requestReprint : requestPrint).mutateAsync({
          invoiceId: rec.invoiceId,
          requestId: crypto.randomUUID(),
          purpose: "THERMAL",
        });
      } else {
        // A temporary offline receipt has no server invoice to authorize or journal.
        const path = reprint
          ? "invoicePrinting.requestReprint"
          : "invoicePrinting.requestPrint";
        let legacyOfflineSession = false;
        if (!user) {
          try {
            const saved = JSON.parse(
              (await getMeta("invoicePrintPolicyMode")) ?? "null",
            ) as { userId?: number; canonical?: boolean } | null;
            legacyOfflineSession =
              saved?.canonical === false && saved.userId === offlineUserId;
          } catch {
            /* No verified policy mode: fail closed. */
          }
        }
        if (
          (!user && !legacyOfflineSession) ||
          (user &&
            !user.isOwner &&
            hasOperationPolicy(user) &&
            !operationDecision(user, path).allowed)
        )
          throw new Error(
            "تعذّر التحقق من صلاحية طباعة الإيصال المؤقت؛ اتصل بالخادم لتحديث صلاحيات حسابك.",
          );
      }
      return await printReceipt(buildBrandedReceipt(rec));
    } finally {
      releaseReservedPrintWindow();
      receiptPrinting.current = false;
    }
  }
  return { printAuthorizedReceipt, receiptPrinting };
}
