// راوتر التحويلات النقدية بين الفروع. managerProcedure (تأثير مالي مباشر).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  cancelTransfer,
  listTransfers,
  receiveTransfer,
  sendTransfer,
} from "../services/cashTransferService";
import { managerProcedure, router } from "../trpc";

const moneyStr = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان عشريتان كحدّ أقصى)");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

export const cashTransfersRouter = router({
  send: managerProcedure
    .input(
      z.object({
        fromBranchId: z.number().int().positive(),
        toBranchId: z.number().int().positive(),
        amount: moneyStr,
        notes: z.string().max(500).nullish(),
        clientRequestId: z.string().min(1).max(80).optional(),
        confirmNegative: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد" });
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await sendTransfer(input, {
            userId: ctx.user.id,
            branchId: ctx.user.branchId == null ? input.fromBranchId : Number(ctx.user.branchId),
            role: ctx.user.role,
          });
          await logAudit(ctx, {
            action: "cashTransfer.send",
            entityType: "cashTransfer",
            entityId: res.transferId,
            newValue: {
              transferNumber: res.transferNumber,
              fromBranchId: input.fromBranchId,
              toBranchId: input.toBranchId,
              amount: input.amount,
            },
          });
          return res;
        } catch (e: any) {
          if (e?.code === "ER_DUP_ENTRY" && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إرسال التحويل" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إرسال التحويل (تكرار)" });
    }),

  receive: managerProcedure
    .input(z.object({ transferId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await receiveTransfer(input.transferId, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId == null ? 0 : Number(ctx.user.branchId),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "cashTransfer.receive",
        entityType: "cashTransfer",
        entityId: input.transferId,
      });
      return res;
    }),

  cancel: managerProcedure
    .input(
      z.object({
        transferId: z.number().int().positive(),
        reason: z.string().min(3).max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await cancelTransfer(input.transferId, input.reason, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId == null ? 0 : Number(ctx.user.branchId),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "cashTransfer.cancel",
        entityType: "cashTransfer",
        entityId: input.transferId,
        newValue: { reason: input.reason },
      });
      return res;
    }),

  list: managerProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          direction: z.enum(["INCOMING", "OUTGOING", "ALL"]).default("ALL"),
          status: z.enum(["IN_TRANSIT", "RECEIVED", "CANCELLED"]).optional(),
          from: ymd.optional(),
          to: ymd.optional(),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin" && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const scopedBranchId = ctx.user.role === "admin" ? null : Number(ctx.user.branchId);
      return listTransfers(input ?? { direction: "ALL", limit: 50, offset: 0 }, scopedBranchId);
    }),
});
