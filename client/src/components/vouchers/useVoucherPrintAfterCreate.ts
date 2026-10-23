import { fmt } from "@/lib/money";
import { notify } from "@/lib/notify";
import {
  printVoucherReceipt,
  printVoucherA4,
} from "@/lib/printing/voucherPrint";
import { releaseReservedPrintWindow } from "@/lib/printing/brand";

import { paymentMethodCompact } from "@shared/terms";
import type { PrintOpenResult } from "@shared/printAudit";
import { useState } from "react";

import { todayYmd } from "./voucherFormTypes";
import type { useVoucherFormState } from "./useVoucherFormState";

export function useVoucherPrintAfterCreate(
  ctx: Pick<
    ReturnType<typeof useVoucherFormState>,
    "utils" | "printAudit" | "branches" | "branchId"
  >,
) {
  const { utils, printAudit, branches, branchId } = ctx;
  const [pendingPrintRef, setPendingPrintRef] = useState<
    "thermal" | "a4" | null
  >(null);
  async function tryPrintAfterCreate(receiptId: number) {
    const printMode = pendingPrintRef;
    try {
      if (!printMode) return;
      const v = await utils.vouchers.get.fetch({ receiptId });
      if (!v) throw new Error("PRINT_FAILED");
      const branchName = (branches.data ?? []).find(
        (b) => Number(b.id) === Number(v.branchId),
      )?.name;
      const partyName =
        v.partyName ??
        (v.partyType === "OTHER" ? (v.counterpartyName ?? "—") : "—");
      const payload = {
        voucherNumber: v.voucherNumber ?? "",
        direction: v.direction as "IN" | "OUT",
        voucherDate: String(v.voucherDate ?? todayYmd()).slice(0, 10),
        createdAt: String(v.createdAt),
        branchName: branchName ?? null,
        amount: fmt(v.amount),
        paymentMethod: v.paymentMethod,
        paymentMethodLabel: paymentMethodCompact(v.paymentMethod),
        referenceNumber: v.referenceNumber,
        checkNumber: v.checkNumber,
        cardLastFour: v.cardLastFour,
        partyTypeLabel:
          v.partyType === "CUSTOMER"
            ? "عميل"
            : v.partyType === "SUPPLIER"
              ? "مورّد"
              : (v.partyType as string) === "DELIVERY_PARTY" ||
                  (v.partyType === "OTHER" &&
                    v.internalNote?.startsWith("DELIVERY_PARTY:"))
                ? "جهة توصيل"
                : "أخرى",
        partyName,
        partyBalance: null,
        categoryName: v.categoryName,
        description: v.description ?? "",
        counterpartyName: v.counterpartyName,
        approvalStatus: v.approvalStatus as
          | "APPROVED"
          | "PENDING_APPROVAL"
          | "REJECTED",
        approvedByName: v.approvedByName,
        approvedAt: v.approvedAt ? String(v.approvedAt) : null,
        createdByName: v.createdByName,
        cashBucket: v.cashBucket as "DRAWER" | "TREASURY" | null,
        signatureHash: v.signatureHash,
        attachmentUrl: v.attachmentUrl,
        relatedInvoiceNumber: v.invoiceNumber ?? null,
      };
      const result = await printAudit.run({
        documentType: "VOUCHER",
        documentId: receiptId,
        branchId: Number(v.branchId ?? branchId),
        channel: printMode === "a4" ? "BROWSER" : "THERMAL",
        open: (audit): Promise<PrintOpenResult> => {
          const auditedPayload = {
            ...payload,
            printedByName: audit.actorName,
            printRequestedAt: String(audit.requestedAt),
          };
          return printMode === "a4"
            ? printVoucherA4(auditedPayload)
            : printVoucherReceipt(auditedPayload);
        },
      });
      if (typeof result === "boolean" && !result) {
        notify.err(
          "تَمّ الحفظ، لكن نافذة الطباعة حُجبت. أعِد الطباعة من قائمة السندات.",
        );
      }
    } catch (e) {
      if (printMode === "a4") releaseReservedPrintWindow();
      console.warn("[voucher] فشلت الطباعة الفورية:", e);
      notify.err(
        "تَمّ الحفظ، لكن الطباعة فشلت. أعِد الطباعة من قائمة السندات.",
      );
    } finally {
      setPendingPrintRef(null);
    }
  }
  return { pendingPrintRef, setPendingPrintRef, tryPrintAfterCreate };
}
