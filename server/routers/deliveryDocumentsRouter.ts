import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { appErrorMessage } from "@shared/errors";
import {
  canCrossBranches,
  deliveryCashierProcedure,
  deliveryReadProcedure,
  router,
} from "../trpc";
import { withTx } from "../services/tx";
import {
  completeDeliveryDocumentPrintTx,
  listDeliveryDocumentSnapshotsTx,
  requestDeliveryDocumentPrintTx,
} from "../services/delivery/documentSnapshots";

const sourceTypes = [
  "INVOICE",
  "CONSIGNMENT",
  "SHIPMENT",
  "REMITTANCE",
  "RETURN_RECEIPT",
  "AFTERCARE_EXECUTION",
  "AFTERCARE_SETTLEMENT",
  "PARTY_SETTLEMENT",
] as const;

type DocumentContext = {
  scopedBranchId?: number | null;
  user: { id: number; branchId?: number | null; role?: string; isOwner?: boolean | null };
};

function documentBranch(ctx: DocumentContext, requested?: number) {
  const crossBranch = canCrossBranches(ctx.user);
  const assignedBranch = Number(ctx.user.branchId ?? 0);
  const enforcedBranch = crossBranch ? ctx.scopedBranchId : assignedBranch;
  if (
    enforcedBranch != null &&
    enforcedBranch > 0 &&
    requested != null &&
    requested !== enforcedBranch
  )
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذر فتح مستند التوصيل",
        why: "المستند يخص فرعاً خارج نطاق حسابك الحالي",
        doThis: "انتقل إلى محطة الفرع الصحيح أو اطلب من مسؤول مخول تنفيذ الطباعة",
      }),
    });
  const value =
    enforcedBranch ?? requested ?? assignedBranch;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذر تحديد فرع مستند التوصيل",
        why: "لا يوجد فرع صالح في الحساب أو الطلب",
        doThis: "اختر الفرع من شريط المحطة ثم أعد فتح المستند",
      }),
    });
  return value;
}

export const deliveryDocumentsRouter = router({
  list: deliveryReadProcedure
    .input(
      z.object({
        sourceType: z.enum(sourceTypes),
        sourceId: z.number().int().positive(),
        branchId: z.number().int().positive().optional(),
      }),
    )
    .query(({ input, ctx }) =>
      withTx((tx) =>
        listDeliveryDocumentSnapshotsTx(tx, {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          branchId: documentBranch(ctx, input.branchId),
        }),
      ),
    ),
  requestPrint: deliveryCashierProcedure
    .input(
      z.object({
        snapshotId: z.number().int().positive(),
        branchId: z.number().int().positive().optional(),
        clientRequestId: z.string().trim().min(8).max(80),
        copyType: z.enum(["ORIGINAL", "REPRINT"]),
        reason: z.string().trim().min(3).max(500).optional(),
        printerKey: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .mutation(({ input, ctx }) =>
      withTx((tx) =>
        requestDeliveryDocumentPrintTx(tx, {
          ...input,
          branchId: documentBranch(ctx, input.branchId),
          requestedBy: ctx.user.id,
        }),
      ),
    ),
  completePrint: deliveryCashierProcedure
    .input(
      z
        .object({
          printId: z.number().int().positive(),
          branchId: z.number().int().positive().optional(),
          status: z.enum(["SENT", "FAILED", "CANCELLED"]),
          errorMessage: z.string().trim().min(3).max(500).optional(),
        })
        .superRefine((input, ctx) => {
          if (input.status === "FAILED" && !input.errorMessage)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["errorMessage"],
              message: "سبب فشل الطباعة مطلوب",
            });
          if (input.status !== "FAILED" && input.errorMessage)
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["errorMessage"],
              message: "سبب الفشل متاح لحالة الفشل فقط",
            });
        }),
    )
    .mutation(({ input, ctx }) =>
      withTx((tx) =>
        completeDeliveryDocumentPrintTx(tx, {
          ...input,
          branchId: documentBranch(ctx, input.branchId),
        }),
      ),
    ),
});
