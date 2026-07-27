// راوتر الحجوزات (R-م٣/م٤). Procedures من المُصدَّرات (branchScopedProcedure + requireModule) تفادياً لتعديل trpc.ts.
// إغلاق ثغرة صلاحية (مراجعة Codex P1): كل الطفرات — بما فيها التمديد المديريّ — تمرّ ببوّابة وحدة `reservations`
// (requireModule) لا بمجرّد الدور، فمديرٌ صلاحيته reservations=NONE/READ لا يتجاوز.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { positiveMoneyString } from "../lib/schemas";
import { logAudit } from "../services/auditService";
import {
  cancelReservation, convertReservationToSale, createReservation, extendReservation, listReservations,
} from "../services/reservations";
import { branchScopedProcedure, requireModule, router } from "../trpc";

const reservationsRead = branchScopedProcedure.use(requireModule("reservations", "READ"));
const reservationsWrite = branchScopedProcedure.use(requireModule("reservations", "FULL"));

const reservationStatus = z.enum(["ACTIVE", "PARTIALLY_FULFILLED", "FULFILLED", "EXPIRED", "CANCELLED", "RELEASED"]);
const reservationChannel = z.enum(["PHONE", "WALK_IN", "WHATSAPP", "STORE"]);

function assertElevated(role: string | undefined) {
  if (role !== "admin" && role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه العملية تتطلب صلاحية مدير" });
  }
}

export const reservationsRouter = router({
  list: reservationsRead
    .input(
      z
        .object({
          status: reservationStatus.optional(),
          branchId: z.number().int().positive().optional(),
          q: z.string().max(200).optional(),
          limit: z.number().int().positive().max(200).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listReservations({ scopedBranchId: ctx.scopedBranchId }, { ...input })),

  create: reservationsWrite
    .input(
      z.object({
        branchId: z.number().int().positive(),
        customerId: z.number().int().positive().nullish(),
        contactName: z.string().max(200).nullish(),
        contactPhone: z.string().min(3).max(32),
        channel: reservationChannel.optional(),
        expiresInHours: z.number().int().positive().max(72).nullish(),
        notes: z.string().max(2000).nullish(),
        lines: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              productUnitId: z.number().int().positive(),
              quantity: z.number().positive(),
              quotedUnitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/, "سعر غير صالح").nullish(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      if (!elevated && Number(ctx.user.branchId) !== input.branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع الحجز لفرع آخر" });
      }
      const res = await createReservation(input, { userId: ctx.user.id, branchId: input.branchId, role: ctx.user.role });
      await logAudit(ctx, {
        action: "reservation.create",
        entityType: "reservation",
        entityId: res.reservationId,
        newValue: { reservationNumber: res.reservationNumber, lines: input.lines.length, overbooked: res.overbookedVariantIds.length },
      });
      return res;
    }),

  cancel: reservationsWrite
    .input(z.object({ id: z.number().int().positive(), reason: z.string().max(300).nullish() }))
    .mutation(async ({ ctx, input }) => {
      const res = await cancelReservation(input.id, input.reason ?? null, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
      await logAudit(ctx, { action: "reservation.cancel", entityType: "reservation", entityId: input.id, newValue: { reason: input.reason ?? null } });
      return res;
    }),

  // التمديد مديريّ (مراجعة Codex P1): بوّابة وحدة reservations (requireModule عبر reservationsWrite) + دور مدير.
  extend: reservationsWrite
    .input(z.object({ id: z.number().int().positive(), hours: z.number().int().positive().max(72) }))
    .mutation(async ({ ctx, input }) => {
      assertElevated(ctx.user.role);
      const res = await extendReservation(input.id, input.hours, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
      await logAudit(ctx, { action: "reservation.extend", entityType: "reservation", entityId: input.id, newValue: { hours: input.hours } });
      return res;
    }),

  // تحويل الحجز إلى فاتورة بيع (R-م٤): عبر createSale — يخصم المخزون ويحرّر المحجوز المنفَّذ.
  convert: reservationsWrite
    .input(
      z.object({
        reservationId: z.number().int().positive(),
        payment: z
          .object({ amount: positiveMoneyString, method: z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]) })
          .nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await convertReservationToSale(input, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "reservation.convert",
        entityType: "reservation",
        entityId: input.reservationId,
        newValue: { invoiceId: res.invoiceId, invoiceNumber: res.invoiceNumber, total: res.total },
      });
      return res;
    }),
});
