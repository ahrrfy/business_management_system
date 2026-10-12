import { useEffect, useRef } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { getMeta, setMeta } from "@/lib/offline/db";
import { printReceipt, type PrintResult, type ReceiptBrowserData } from "@/lib/printing/print";
import { releaseReservedPrintWindow } from "@/lib/printing/brand";
import { beginInvoicePrintAttempt, completeInvoicePrintAttempt, type InvoicePrintPurpose } from "@/lib/printing/invoicePrintAttempt";
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

  async function printAuthorizedDocument(invoiceId: number, purpose: InvoicePrintPurpose, reprint: boolean, render: () => Promise<PrintResult>) {
    if (receiptPrinting.current)
      return { ok: false as const, via: "browser" as const };
    receiptPrinting.current = true;
    try {
      const attempt = invoiceId > 0 && user
        ? beginInvoicePrintAttempt(user.id, invoiceId, purpose, reprint,
            user.isOwner || !hasOperationPolicy(user) || operationDecision(user, "invoicePrinting.requestPrint").allowed)
        : null;
      if (invoiceId > 0) {
        if (!attempt) throw new Error("تعذّر التحقق من حساب طباعة الفاتورة؛ أعد تسجيل الدخول.");
        await (attempt.mode === "REPRINT" ? requestReprint : requestPrint).mutateAsync({
          invoiceId: invoiceId,
          requestId: attempt.requestId,
          purpose,
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
      const result = await render();
      if (result.ok && attempt) completeInvoicePrintAttempt(attempt);
      return result;
    } finally {
      releaseReservedPrintWindow();
      receiptPrinting.current = false;
    }
  }
  function printAuthorizedReceiptData(rec: ReceiptBrowserData, reprint = false) {
    return printAuthorizedDocument(rec.invoiceId ?? 0, "THERMAL", reprint, () => printReceipt(rec));
  }
  function printAuthorizedReceipt(rec: Receipt, reprint = false) {
    return printAuthorizedReceiptData(buildBrandedReceipt(rec), reprint);
  }
  return { printAuthorizedReceipt, printAuthorizedReceiptData, printAuthorizedDocument, receiptPrinting };
}
