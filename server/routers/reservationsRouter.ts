// راوتر الحجوزات (R-م٣). Procedures مبنيّة من المُصدَّرات (branchScopedProcedure + requireModule)
// تفادياً لتعديل trpc.ts — نمط tasksReadProcedure نفسه. عزل الفرع يدويّ في الطفرات (نمط tasks.create).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import { logAudit } from "../services/auditService";
import {
  cancelReservation, convertReservationToSale, createReservation, expireDueReservations, extendReservation,
  getAvailabilityByVariant, getReservation, listReservations, releaseReservation,
} from "../services/reservations";
import { branchScopedProcedure, managerProcedure, requireModule, router } from "../trpc";

const reservationsRead = branchScopedProcedure.use(requireModule("reservations", "READ"));
const reservationsWrite = branchScopedProcedure.use(requireModule("reservations", "FULL"));

const reservationStatus = z.enum(["ACTIVE", "PARTIALLY_FULFILLED", "FULFILLED", "EXPIRED", "CANCELLED", "RELEASED"]);
const reservationChannel = z.enum(["PHONE", "WALK_IN", "WHATSAPP", "STORE"]);

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

  get: reservationsRead
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const res = await getReservation(input.id, { scopedBranchId: ctx.scopedBranchId });
      if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "الحجز غير موجود" });
      return res;
    }),

  // استعلام التوفّر (ATP) لصنف — للشاشة «هل متوفر؟». غير المرتفع يرى فرعه فقط.
  availability: reservationsRead
    .input(z.object({ variantId: z.number().int().positive(), branchId: z.number().int().positive().optional() }))
    .query(({ ctx, input }) => {
      const branchId = ctx.scopedBranchId ?? input.branchId ?? undefined;
      return getAvailabilityByVariant(input.variantId, branchId);
    }),

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
              quotedUnitPrice: nonNegMoneyString.nullish(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // عزل الفرع (نمط tasks.create): غير المرتفع لا يحجز لفرع آخر.
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

  // تمديد وتحرير مديريّان (managerProcedure): التمديد ≤٧٢س بموافقة مدير، التحرير لظرف مخزنيّ.
  extend: managerProcedure
    .input(z.object({ id: z.number().int().positive(), hours: z.number().int().positive().max(72) }))
    .mutation(async ({ ctx, input }) => {
      const res = await extendReservation(input.id, input.hours, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
      await logAudit(ctx, { action: "reservation.extend", entityType: "reservation", entityId: input.id, newValue: { hours: input.hours } });
      return res;
    }),

  release: managerProcedure
    .input(z.object({ id: z.number().int().positive(), reason: z.string().max(300).nullish() }))
    .mutation(async ({ ctx, input }) => {
      const res = await releaseReservation(input.id, input.reason ?? null, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId ?? 0),
        role: ctx.user.role,
      });
      await logAudit(ctx, { action: "reservation.release", entityType: "reservation", entityId: input.id, newValue: { reason: input.reason ?? null } });
      return res;
    }),

  // كنس يدويّ للحجوزات المنتهية (managerProcedure) — يُربَط بـnode-cron في R-م٥؛ متاح الآن للتشغيل/الاختبار.
  sweepExpired: managerProcedure.mutation(async ({ ctx }) => {
    const res = await expireDueReservations();
    if (res.expired > 0) {
      await logAudit(ctx, { action: "reservation.sweepExpired", entityType: "reservation", entityId: 0, newValue: { expired: res.expired } });
    }
    return res;
  }),
});
