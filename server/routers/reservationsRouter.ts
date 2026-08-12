// راوتر الحجوزات (R-م٣/م٤). Procedures من المُصدَّرات (branchScopedProcedure + requireModule) تفادياً لتعديل trpc.ts.
// إغلاق ثغرة صلاحية (مراجعة Codex P1): كل الطفرات — بما فيها التمديد المديريّ — تمرّ ببوّابة وحدة `reservations`
// (requireModule) لا بمجرّد الدور، فمديرٌ صلاحيته reservations=NONE/READ لا يتجاوز.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, desc, eq, gte, like, lt, or, type SQL } from "drizzle-orm";
import { products, productUnits, productVariants, reservationLines, reservations } from "../../drizzle/schema";
import { positiveMoneyString } from "../lib/schemas";
import { logAudit } from "../services/auditService";
import { utcDayStart, utcNextDayStart } from "../services/businessDay";
import { money, round2, toDbMoney } from "../services/money";
import {
  cancelReservation, convertReservationToSale, createReservation, expireDueReservations, extendReservation,
} from "../services/reservations";
import { requireDb } from "../services/tx";
import { logger } from "../logger";
import { branchScopedProcedure, requireModule, router } from "../trpc";

const reservationsRead = branchScopedProcedure.use(requireModule("reservations", "READ"));
const reservationsWrite = branchScopedProcedure.use(requireModule("reservations", "FULL"));

/**
 * فحصٌ كسول لانتهاء **حجزٍ بعينه** — يُشغَّل قبل `get` بفلتر id فيعالَج المطلوب حتماً وحده.
 * ملاحظات Codex على PR #557:
 * - **P1**: الكنسُ العامّ بحدّ ٥٠ قد يُعالج ٥٠ صفّاً من فرعٍ آخر بينما الحجز المطلوب يبقى ACTIVE.
 *   بفلتر id نضمن معالجة المطلوب حصراً.
 * - **P2 (deadlock)**: الكنس العام يقفل `reservations` قبل `reservationStock`، بينما `createReservation`
 *   يقفل `reservationStock` قبل `reservations` (numbering) — تعارض ممكن تحت الحمل. كنسُ id واحدٍ
 *   لا يمرّ بذلك المسار على تعدّد الصفوف. الكرون الخلفيّ يتولّى الدفعات العامّة (لا في مسار الطلب).
 * - `list` لا يستدعي هذه الدالة إطلاقاً (نعتمد الكرون كلّ ٥د) — فرق العرض الأقصى ٥ دقائق مقبول.
 */
async function sweepExpiredById(reservationId: number): Promise<void> {
  try {
    const res = await expireDueReservations({ reservationId, limit: 1 });
    if (res.expired > 0) logger.info({ reservationId }, "reservations.lazy-sweep(id) expired one");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), reservationId }, "reservations.lazy-sweep(id) failed (non-fatal)");
  }
}

const reservationStatus = z.enum(["ACTIVE", "PARTIALLY_FULFILLED", "FULFILLED", "EXPIRED", "CANCELLED", "RELEASED"]);
const reservationChannel = z.enum(["PHONE", "WALK_IN", "WHATSAPP", "STORE"]);

function assertElevated(role: string | undefined) {
  if (role !== "admin" && role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه العملية تتطلب صلاحية مدير" });
  }
}

const ymdString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");

export const reservationsRouter = router({
  /** القائمة — فلاتر مدى تاريخ الانتهاء (from/to شامِلَين) + ترتيب «ينتهي أولاً» افتراضياً (طابور
   *  الصباح) + offset/hasMore بدل الاقتطاع الصامت. الاستعلام مباشر هنا (لا listReservations من
   *  الخدمة، القاصرة عن المدى/الترتيب/hasMore — تبقى بلا مسّ) بنفس شروط العزل حرفياً. */
  list: reservationsRead
    .input(
      z
        .object({
          status: reservationStatus.optional(),
          branchId: z.number().int().positive().optional(),
          q: z.string().max(200).optional(),
          from: ymdString.optional(),
          to: ymdString.optional(),
          sort: z.enum(["EXPIRY", "NEWEST"]).optional(),
          limit: z.number().int().positive().max(200).optional(),
          offset: z.number().int().min(0).max(100_000).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      // `list` لا يستدعي كنسَ الانتهاء بعد الآن — الكرون الخلفيّ (`reservationsSweeper` كلّ ٥د)
      // يتكفّل بالدفعات العامّة، فلا يُدخل مسارُ القراءة عالي التردّد سباقَ أقفال مع `createReservation`.
      const db = requireDb();
      const conds: (SQL | undefined)[] = [];
      // عزل الفرع: غير المرتفع (scopedBranchId مضبوط) يرى فرعه فقط؛ المرتفع يفلتر بـbranchId اختيارياً.
      const branch = ctx.scopedBranchId ?? input?.branchId;
      if (branch != null) conds.push(eq(reservations.branchId, branch));
      if (input?.status) conds.push(eq(reservations.status, input.status));
      if (input?.q?.trim()) {
        const pat = `%${input.q.trim()}%`;
        conds.push(or(
          like(reservations.reservationNumber, pat),
          like(reservations.contactPhone, pat),
          like(reservations.contactName, pat),
        ));
      }
      // مدى الانتهاء بيوم أعمال UTC (businessDay): [from 00:00, to+يوم 00:00) — حدّ أعلى حصريّ.
      if (input?.from) conds.push(gte(reservations.expiresAt, utcDayStart(input.from)));
      if (input?.to) conds.push(lt(reservations.expiresAt, utcNextDayStart(input.to)));

      const limit = Math.min(input?.limit ?? 100, 200);
      const offset = input?.offset ?? 0;
      const order = (input?.sort ?? "EXPIRY") === "NEWEST"
        ? [desc(reservations.id)]
        : [asc(reservations.expiresAt), asc(reservations.id)];
      const rows = await db
        .select()
        .from(reservations)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(...order)
        .limit(limit + 1)
        .offset(offset);
      const hasMore = rows.length > limit;
      return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
    }),

  /** تفاصيل حجز واحد ببنوده (منتجات/كميات/أسعار) — «ماذا حجزتُ لك؟» لشاشة التفاصيل وحوار التحويل.
   *  الكمية المعروضة بوحدة الحجز (baseQuantity ÷ conversionFactor)، والإجماليات بـdecimal.js. */
  get: reservationsRead
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      // فحصٌ كسول محدَّد بالـid: أيّ حجزٍ فُتحت تفاصيله بعد انقضاء مدّته يُصبح EXPIRED قبل عرضه —
      // لا يبقى ACTIVE. الفلتر بـid يمنع كنسَ صفوف عشوائيّة ويُلغي تعارض الأقفال مع createReservation.
      await sweepExpiredById(input.id);
      const db = requireDb();
      const head = (
        await db.select().from(reservations).where(eq(reservations.id, input.id)).limit(1)
      )[0];
      // عزل الفرع: لا نكشف وجود حجز فرع آخر ⇒ NOT_FOUND لا FORBIDDEN (نمط صندوق الوارد).
      if (!head || (ctx.scopedBranchId != null && Number(head.branchId) !== ctx.scopedBranchId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "الحجز غير موجود" });
      }
      const rawLines = await db
        .select({
          id: reservationLines.id,
          variantId: reservationLines.variantId,
          productUnitId: reservationLines.productUnitId,
          baseQuantity: reservationLines.baseQuantity,
          fulfilledBase: reservationLines.fulfilledBase,
          quotedUnitPrice: reservationLines.quotedUnitPrice,
          productName: products.name,
          variantName: productVariants.variantName,
          color: productVariants.color,
          size: productVariants.size,
          unitName: productUnits.unitName,
          conversionFactor: productUnits.conversionFactor,
        })
        .from(reservationLines)
        .innerJoin(productVariants, eq(reservationLines.variantId, productVariants.id))
        .innerJoin(products, eq(productVariants.productId, products.id))
        .innerJoin(productUnits, eq(reservationLines.productUnitId, productUnits.id))
        .where(eq(reservationLines.reservationId, input.id))
        .orderBy(asc(reservationLines.id));

      let total = money(0);
      let hasUnpriced = false;
      const lines = rawLines.map((l) => {
        const factor = money(l.conversionFactor ?? "1");
        // كمية عرض بوحدة الحجز (ليست مالاً) — القسمة على المعامل تعكس تحويل الإنشاء.
        const qty = factor.gt(0) ? money(l.baseQuantity).div(factor) : money(l.baseQuantity);
        const lineTotal = l.quotedUnitPrice != null ? round2(qty.mul(money(l.quotedUnitPrice))) : null;
        if (lineTotal != null) total = total.add(lineTotal);
        else hasUnpriced = true;
        return {
          id: Number(l.id),
          variantId: Number(l.variantId),
          productUnitId: Number(l.productUnitId),
          productName: l.productName,
          variantName: l.variantName,
          color: l.color,
          size: l.size,
          unitName: l.unitName,
          quantity: qty.toNumber(),
          baseQuantity: Number(l.baseQuantity),
          fulfilledBase: Number(l.fulfilledBase),
          quotedUnitPrice: l.quotedUnitPrice,
          lineTotal: lineTotal != null ? toDbMoney(lineTotal) : null,
        };
      });
      return {
        ...head,
        lines,
        // إجمالي الأسطر المسعَّرة فقط؛ hasUnpriced يعلم الواجهة أن الإجمالي جزئيّ (سطر بلا سعر مرجعي).
        total: toDbMoney(total),
        hasUnpriced,
      };
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
              quotedUnitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/, "سعر غير صالح").nullish(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران؛ المدير يحجز بفرعه المُسنَد فقط.
      const elevated = ctx.user.role === "admin";
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
          .object({
            amount: positiveMoneyString,
            method: z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]),
            reference: z.string().trim().max(100).nullish(),
          })
          .nullish(),
      }).superRefine((input, ctx) => {
        if (input.payment && input.payment.method !== "CASH" && !input.payment.reference?.trim()) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payment", "reference"], message: "مرجع الدفع غير النقدي مطلوب" });
        }
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
