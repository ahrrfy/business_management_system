import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { paginateKeyset, countIfOffset } from "../lib/paginateKeyset";
import { z } from "zod";
import { branches, shifts, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { localDayStart, localNextDayStart } from "../services/dateRange";
import { closeShift, getExpectedOpening, getOpenShift, getShiftReport, openShift } from "../services/shiftService";
import { createCashDrop } from "../services/cashDropService";
import { router, treasuryCashierProcedure, treasuryReadProcedure } from "../trpc";
import { retryOnDup } from "../lib/retryDup";

// تاريخ فلترة YYYY-MM-DD (فلتر الفترة الخادمي على openedAt).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

export const shiftRouter = router({
  // سجلّ الورديات — قائمة مُصفّحة branch-scoped (IDOR كـreport): الكاشير يرى ورديات فرعه فقط،
  // المرتفعون يرون الكل أو يفلترون بفرع. تُغذّي شاشة /shifts وإعادة طباعة Z-report.
  list: treasuryReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          status: z.enum(["OPEN", "CLOSED"]).optional(),
          from: ymd.optional(),
          to: ymd.optional(),
          limit: z.number().int().positive().max(200).default(50),
          offset: z.number().int().min(0).default(0),
          // S3 (٣٠/٦): cursor (id) لـkeyset — يَتجاوز COUNT الكامل عند تَمريره.
          cursor: z.number().int().positive().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { rows: [], total: 0, hasMore: false, nextCursor: null as number | null };
      const i = input ?? ({} as NonNullable<typeof input>);
      const conds: SQL[] = [];
      const effectiveBranchId = ctx.scopedBranchId ?? i.branchId;
      if (effectiveBranchId != null) conds.push(eq(shifts.branchId, effectiveBranchId));
      if (i.status) conds.push(eq(shifts.status, i.status));
      // فلتر الفترة على openedAt (وقت فتح الوردية).
      // نصف مفتوح [from, to+يوم) بمنتصف ليلٍ محلي (Date("YYYY-MM-DD") = UTC ⇒ انزياح +03:00).
      if (i.from) conds.push(gte(shifts.openedAt, localDayStart(i.from)));
      if (i.to) conds.push(lt(shifts.openedAt, localNextDayStart(i.to)));
      // /simplify ٣٠/٦: paginateKeyset + countIfOffset.
      const { rows, hasMore, nextCursor, usingCursor } = await paginateKeyset({
        cursor: i.cursor,
        limit: i.limit,
        offset: i.offset,
        defaultLimit: 50,
        idCol: shifts.id,
        baseConds: conds,
        runQuery: (where, lim, off) => db
          .select({
            id: shifts.id,
            branchId: shifts.branchId,
            branchName: branches.name,
            userId: shifts.userId,
            userName: users.name,
            openingBalance: shifts.openingBalance,
            expectedCash: shifts.expectedCash,
            countedCash: shifts.countedCash,
            variance: shifts.variance,
            status: shifts.status,
            openedAt: shifts.openedAt,
            closedAt: shifts.closedAt,
          })
          .from(shifts)
          .leftJoin(users, eq(shifts.userId, users.id))
          .leftJoin(branches, eq(shifts.branchId, branches.id))
          .where(where)
          .orderBy(desc(shifts.id))
          .limit(lim)
          .offset(off),
      });
      const total = await countIfOffset(usingCursor, async () => {
        const baseWhere = conds.length ? and(...conds) : undefined;
        const totalRow = (await db.select({ n: sql<number>`COUNT(*)` }).from(shifts).where(baseWhere))[0];
        return Number(totalRow?.n ?? 0);
      });
      return { rows, total, hasMore, nextCursor };
    }),

  open: treasuryCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        // SHIFT-VALIDATE (تدقيق ٢/٧): الرصيد الافتتاحي مالٌ غير سالب (كان z.string() يقبل السالب).
        openingBalance: z.string().regex(/^\d+(\.\d{1,2})?$/, "الرصيد الافتتاحي مبلغ غير سالب").default("0"),
        // نوع الوردية: RETAIL (كاشير) أو RECEPTION (خدمة الزبائن). يُفتَح من شاشة الاستقبال بـRECEPTION.
        shiftType: z.enum(["RETAIL", "RECEPTION"]).default("RETAIL"),
        // ①ج سبب اختلاف الرصيد الافتتاحيّ عن المتبقّي من الوردية السابقة (إلزاميّ عند الاختلاف —
        // يُفرَض داخل openShift خادمياً تحت المعاملة). اختياريّ هنا: أوّل وردية/لا اختلاف لا يَطلبه.
        openingDiscrepancyReason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // G4 (تدقيق ١٤/٦/٢٦): قبل: `?? input.branchId` يسمح لكاشير بـbranchId=null بفتح وردية
      // على أي فرع. الآن: غير-elevated يُجبَر على فرعه (FORBIDDEN لو null)؛ admin/manager
      // يحترمان input.branchId (لافتتاح ورديات نيابةً عند الحاجة).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let actorBranchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        actorBranchId = Number(ctx.user.branchId);
      }
      const res = await openShift(
        { ...input, branchId: actorBranchId, openingDiscrepancyReason: input.openingDiscrepancyReason ?? null },
        { userId: ctx.user.id, branchId: actorBranchId },
      );
      // ①ج سجلّ فتح الوردية يَكشف فجوة الاستمرارية (المتوقَّع/الفرق/السبب) لا الرصيد المُدخَل وحده.
      // + إصلاح entityId: openShift يُرجِع shiftId لا id (كان undefined فيَعمى السجلّ عن الوردية).
      await logAudit(ctx, {
        action: "shift.open",
        entityType: "shift",
        entityId: res.shiftId,
        newValue: {
          openingBalance: input.openingBalance,
          branchId: actorBranchId,
          shiftType: input.shiftType,
          expectedOpening: res.expectedOpening,
          hasDiscrepancy: res.hasDiscrepancy,
          difference: res.difference,
          discrepancyReason: res.discrepancyReason,
        },
      });
      return res;
    }),

  // ①ج الرصيد الافتتاحيّ المتوقَّع = متبقّي آخر وردية مغلقة لنفس (الفرع×النوع) — تُعرَض في شاشة فتح
  // الوردية لمطابقة المُدخَل قبل الفتح (اطّلاعٌ فقط؛ الفرض النهائيّ داخل open، يُعاد الحساب تحت المعاملة).
  // نفس نمط عزل الفرع في current: الكاشير على فرعه (scopedBranch)، المرتفعون بـinput.branchId.
  expectedOpening: treasuryReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftType: z.enum(["RETAIL", "RECEPTION"]).default("RETAIL"),
      }),
    )
    .query(({ input, ctx }) => {
      const effective = ctx.scopedBranchId ?? input.branchId;
      return getExpectedOpening(effective, input.shiftType);
    }),

  close: treasuryCashierProcedure
    .input(
      z.object({
        shiftId: z.number().int().positive(),
        // SHIFT-VALIDATE (تدقيق ٢/٧): النقد المعدود مالٌ غير سالب.
        countedCash: z.string().regex(/^\d+(\.\d{1,2})?$/, "النقد المعدود مبلغ غير سالب"),
        // treasury-stage2: snapshot عدّاد الفئات (اختياري).
        countedBreakdown: z.record(z.string(), z.number().int().min(0).max(10000)).nullish(),
        // treasury-stage2: تسليم نقد للخزينة (اختياري).
        handover: z
          .object({
            amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح"),
            handoverTo: z.number().int().positive(),
            notes: z.string().max(500).nullish(),
          })
          .nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // سياسة #14: نمرّر دور الفاعل + فرعه ليفرض closeShift فحص الملكية/الفرع.
      // G4: استبدال `?? -1` الذي كان يُمرَّر للخدمة فيرفع رسالة مضلّلة (لا تطابُق فرع)
      // بدل سبب الحقيقي (لا فرع مُسنَد). FORBIDDEN صريح للأدوار غير المرتفعة.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      // NUMBERING-RACE (تدقيق ٢/٧): ترقيم سند التسليم (CH) يحرّر GET_LOCK قبل الالتزام ⇒ إغلاقان
      // متزامنان لنفس الفرع/اليوم قد يحسبان نفس الرقم؛ القيد الفريد يرفض الثاني. نعيد المحاولة على
      // التصادم (closeShift ذرّية داخل withTx فتتراجع المحاولة الفاشلة كاملةً).
      const res = await retryOnDup(() =>
        closeShift(input, {
          userId: ctx.user.id,
          branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
          role: ctx.user.role,
        }),
      );
      // M (تدقيق ٢٣/٦/٢٦): سجلّ إغلاق الوردية كان «countedCash» فقط — بلا expectedCash ولا
      // variance ولا handover. تحقيق الفروقات اللاحق لا يَعرف من قَبَض ولا كَم سُلِّم. الآن نَلتقط
      // الناتج الكامل من closeShift ⇒ سجلٌّ كاشف لحظة الإقفال (Z-report snapshot في audit).
      await logAudit(ctx, {
        action: "shift.close",
        entityType: "shift",
        entityId: input.shiftId,
        newValue: {
          countedCash: input.countedCash,
          expectedCash: res.expectedCash,
          variance: res.variance,
          openingBalance: res.openingBalance,
          handover: res.handover
            ? {
                handoverNumber: res.handover.handoverNumber,
                amount: input.handover?.amount ?? null,
                handoverTo: input.handover?.handoverTo ?? null,
              }
            : null,
        },
      });
      return res;
    }),

  // السحب النقديّ أثناء الوردية (cash drop) — نقلٌ مِن الدرج إلى الخزينة في منتصف الوردية لتقليل
  // مخاطرة تكدّس النقد. مرآةٌ لحوكمة close (نفس treasuryCashierProcedure + فحص الملكية داخل الخدمة).
  // retryOnDup: ترقيم CD يحرّر GET_LOCK قبل الالتزام ⇒ سحبان متزامنان قد يحسبان نفس الرقم، القيد
  // الفريد يرفض الثاني فنعيد المحاولة (createCashDrop ذرّيّ داخل withTx فتتراجع المحاولة الفاشلة).
  cashDrop: treasuryCashierProcedure
    .input(
      z.object({
        shiftId: z.number().int().positive(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح"),
        // مفتاح idempotency من العميل ⇒ فقدُ ردٍّ/نقرٌ مزدوج لا يُكرّر حركة النقد (نمط createSale).
        clientRequestId: z.string().min(1).max(64),
        // مستلِمٌ اختياريّ (مدير/إداريّ يتسلّم العهدة)؛ بدونه يُنسَب الاستلام للفاعل (درج أمانٍ بلا شخص).
        dropTo: z.number().int().positive().nullish(),
        notes: z.string().max(500).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const res = await retryOnDup(() =>
        createCashDrop(
          { shiftId: input.shiftId, amount: input.amount, clientRequestId: input.clientRequestId, dropTo: input.dropTo ?? null, notes: input.notes ?? null },
          {
            userId: ctx.user.id,
            branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
            role: ctx.user.role,
          },
        ),
      );
      await logAudit(ctx, {
        action: "shift.cashDrop",
        entityType: "shift",
        entityId: input.shiftId,
        newValue: {
          dropNumber: res.dropNumber,
          amount: input.amount,
          dropTo: input.dropTo ?? null,
          drawerBefore: res.drawerBefore,
          drawerAfter: res.drawerAfter,
        },
      });
      return res;
    }),

  // treasury-stage2: مستلِمو تسليم النقد عند إغلاق الوردية. يطابق تحقّق cashHandoverService
  // (المستلِم admin/manager نشط) ⇒ نُرجِع فقط الإداريين/المديرين النشطين. متاح للكاشير
  // (treasuryCashierProcedure نفس بوّابة الإغلاق) كي يختار من يُسلّمه نقد الدرج.
  handoverRecipients: treasuryCashierProcedure.query(async () => {
    const db = getDb();
    if (!db) return [] as { id: number; name: string }[];
    const rows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.isActive, true), inArray(users.role, ["admin", "manager"])))
      .orderBy(users.name);
    return rows.map((r) => ({ id: r.id, name: r.name ?? `#${r.id}` }));
  }),

  // §٧ IDOR: كان كاشير من فرع A يستطيع `report` لوردية فرع B بمعرفة shiftId.
  // الآن نفرض ctx.scopedBranchId: إن كانت الوردية في فرع آخر ⇒ FORBIDDEN لغير المرتفعين.
  report: treasuryReadProcedure
    .input(z.object({ shiftId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const report = await getShiftReport(input.shiftId);
      if (!report) return null;
      // ctx.scopedBranchId == null للمرتفعين (admin/manager): مرور حر.
      // ctx.scopedBranchId == number لغيرهم: فرض المطابقة.
      const sBranchId = (report as { branchId?: number | null })?.branchId;
      if (ctx.scopedBranchId != null && sBranchId != null && Number(sBranchId) !== ctx.scopedBranchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ليس لك صلاحية على ورديات هذا الفرع" });
      }
      return report;
    }),

  // §٧: الكاشير يبقى في فرعه؛ المرتفعون يجوز لهم تمرير branchId لأي فرع. ctx.scopedBranchId
  // أقوى من ctx.user.branchId (يغلق ثغرة إن كان branchId الخام null).
  current: treasuryReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        // بوّابة الاستقبال تستعلم عن وردية RECEPTION صراحةً؛ بدونه يُرجَع أيّ وردية مفتوحة.
        shiftType: z.enum(["RETAIL", "RECEPTION"]).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const effective = ctx.scopedBranchId ?? input.branchId;
      return getOpenShift(ctx.user.id, effective, input.shiftType);
    }),
});
