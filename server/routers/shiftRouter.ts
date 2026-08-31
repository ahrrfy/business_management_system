import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { paginateKeyset, countIfOffset } from "../lib/paginateKeyset";
import { escLike } from "../lib/sqlLike";
import { z } from "zod";
import { branches, shifts, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import { localDayStart, localNextDayStart } from "../services/dateRange";
import { closeShift, getOpenShift, getShiftReport, openShift } from "../services/shiftService";
import { remediateAndCloseLegacyNegativeShifts } from "../services/legacyNegativeShiftService";
import { createCashDrop } from "../services/cashDropService";
import {
  cancelShiftFundingRequest,
  listMyPendingShiftFunding,
  listEligibleShiftFundingSources,
  listPendingShiftFundingForOwners,
  requestAdditionalShiftFunding,
  respondToShiftFundingRequest,
} from "../services/shiftFundingService";
import {
  ownerProcedure,
  router,
  selfServiceProcedure,
  treasuryCashierProcedure,
  treasuryHandoverRecipientsProcedure,
  treasuryReadProcedure,
} from "../trpc";
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
          shiftType: z.enum(["RETAIL", "RECEPTION", "PRINT_SERVICES"]).optional(),
          varianceState: z.enum(["WITH_VARIANCE", "MATCHED", "UNRECONCILED"]).optional(),
          q: z.string().trim().max(100).optional(),
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
      if (i.shiftType) conds.push(eq(shifts.shiftType, i.shiftType));
      if (i.varianceState === "WITH_VARIANCE") {
        conds.push(sql`${shifts.variance} is not null and abs(${shifts.variance}) > 0.005`);
      } else if (i.varianceState === "MATCHED") {
        conds.push(sql`${shifts.variance} is not null and abs(${shifts.variance}) <= 0.005`);
      } else if (i.varianceState === "UNRECONCILED") {
        conds.push(isNull(shifts.variance));
      }
      if (i.q) {
        const raw = i.q.trim();
        const like = `%${escLike(raw)}%`;
        const numeric = raw.match(/^#?(\d+)$/);
        const shiftId = numeric ? Number(numeric[1]) : null;
        const searchCond = shiftId != null && Number.isSafeInteger(shiftId) && shiftId > 0
          ? or(
              eq(shifts.id, shiftId),
              sql`coalesce(${users.name}, '') LIKE ${like} ESCAPE '!'`,
            )
          : sql`coalesce(${users.name}, '') LIKE ${like} ESCAPE '!'`;
        if (searchCond) conds.push(searchCond);
      }
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
            shiftType: shifts.shiftType,
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

  /** عهد التمويل الإضافي المسندة لصاحب الوردية الحالي فقط، بصرف النظر عن مسمى دوره. */
  fundingRequests: selfServiceProcedure.query(({ ctx }) =>
    listMyPendingShiftFunding({
      userId: ctx.user.id,
      branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
      role: ctx.user.role,
      isOwner: ctx.user.isOwner,
    }),
  ),

  /** سحوبات الورديات المقبولة المتاحة كمصدرٍ وحيد لعهدة إضافية. */
  fundingSources: ownerProcedure
    .input(z.object({
      targetShiftId: z.number().int().positive(),
      cursorReceiptId: z.number().int().positive().nullish(),
    }))
    .query(({ input, ctx }) =>
      listEligibleShiftFundingSources(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
        role: ctx.user.role,
        isOwner: ctx.user.isOwner,
      }),
    ),

  /** الطلبات الصادرة المعلقة كي يستطيع المالك تحرير مصدرها إن لم يتم التسليم. */
  fundingOutgoing: ownerProcedure.query(({ ctx }) =>
    listPendingShiftFundingForOwners({
      userId: ctx.user.id,
      branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
      role: ctx.user.role,
      isOwner: ctx.user.isOwner,
    }),
  ),

  cancelFunding: ownerProcedure
    .input(
      z.object({
        requestReceiptId: z.number().int().positive(),
        cancellationReason: z.string().trim().min(5).max(500),
      }),
    )
    .mutation(({ input, ctx }) =>
      cancelShiftFundingRequest(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
        role: ctx.user.role,
        isOwner: ctx.user.isOwner,
        ipAddress:
          (ctx.req.headers["x-forwarded-for"] as string | undefined)
            ?.split(",")[0]
            ?.trim() ?? ctx.req.ip ?? null,
      }),
    ),

  /** المالك ينشئ عقد التسليم فقط؛ لا تتحرك الخزنة قبل قبول صاحب الوردية. */
  requestFunding: ownerProcedure
    .input(
      z.object({
        shiftId: z.number().int().positive(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ التمويل غير صالح"),
        evidenceNote: z.string().trim().min(10).max(500),
        sourceTreasuryReceiptId: z.number().int().positive(),
        clientRequestId: z.string().trim().min(1).max(64),
      }),
    )
    .mutation(({ input, ctx }) =>
      retryOnDup(() =>
        requestAdditionalShiftFunding(input, {
          userId: ctx.user.id,
          branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
          role: ctx.user.role,
          isOwner: ctx.user.isOwner,
          ipAddress:
            (ctx.req.headers["x-forwarded-for"] as string | undefined)
              ?.split(",")[0]
              ?.trim() ?? ctx.req.ip ?? null,
        }),
      ),
    ),

  /** صاحب الوردية وحده يؤكد أن النقد وصل فعلياً أو يرفض العهدة بلا أثر مالي. */
  respondFunding: selfServiceProcedure
    .input(
      z
        .object({
          requestReceiptId: z.number().int().positive(),
          decision: z.enum(["ACCEPT", "REJECT"]),
          rejectionReason: z.string().trim().max(500).nullish(),
        })
        .superRefine((value, ctx) => {
          if (
            value.decision === "REJECT" &&
            (value.rejectionReason?.trim().length ?? 0) < 5
          ) {
            ctx.addIssue({
              code: "custom",
              path: ["rejectionReason"],
              message: "سبب الرفض مطلوب (5 محارف على الأقل)",
            });
          }
        }),
    )
    .mutation(({ input, ctx }) =>
      respondToShiftFundingRequest(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
        role: ctx.user.role,
        isOwner: ctx.user.isOwner,
        ipAddress:
          (ctx.req.headers["x-forwarded-for"] as string | undefined)
            ?.split(",")[0]
            ?.trim() ?? ctx.req.ip ?? null,
      }),
    ),

  open: treasuryCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        // SHIFT-VALIDATE (تدقيق ٢/٧): الرصيد الافتتاحي مالٌ غير سالب (كان z.string() يقبل السالب).
        openingBalance: z.string().regex(/^\d+(\.\d{1,2})?$/, "الرصيد الافتتاحي مبلغ غير سالب").default("0"),
        // نوع الوردية: RETAIL (كاشير التجزئة) / RECEPTION (خدمة الزبائن، يُفتَح من شاشة الاستقبال) /
        // PRINT_SERVICES (كاشير خدمات الطباعة، يُفتَح من شاشة الطباعة — درج مستقلّ بقرار المالك ٢٣/٧/٢٦).
        shiftType: z.enum(["RETAIL", "RECEPTION", "PRINT_SERVICES"]).default("RETAIL"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // G4 (تدقيق ١٤/٦/٢٦): قبل: `?? input.branchId` يسمح لكاشير بـbranchId=null بفتح وردية
      // على أي فرع. الآن: غير-elevated يُجبَر على فرعه (FORBIDDEN لو null)؛ admin/manager
      // يحترمان input.branchId (لافتتاح ورديات نيابةً عند الحاجة).
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران
      let actorBranchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        actorBranchId = Number(ctx.user.branchId);
      }
      const res = await openShift(
        { ...input, branchId: actorBranchId },
        { userId: ctx.user.id, branchId: actorBranchId },
      );
      // سجلّ فتح الوردية: الرصيد الافتتاحيّ (عهدة الوردية المستقلّة) + الفرع/النوع.
      // إصلاح entityId: openShift يُرجِع shiftId لا id (كان undefined فيَعمى السجلّ عن الوردية).
      await logAudit(ctx, {
        action: "shift.open",
        entityType: "shift",
        entityId: res.shiftId,
        newValue: {
          openingBalance: input.openingBalance,
          branchId: actorBranchId,
          shiftType: input.shiftType,
          // العهدة الوسيطة: أثر سحب العهدة من الخزينة + علم العجز (خزينة سالبة).
          treasuryBalanceAfter: res.treasuryBalanceAfter,
          treasuryWarning: res.treasuryWarning,
        },
      });
      // رصيد الخزينة مكتومٌ عن الكاشير (نمط hideTreasury في اللوحة) — نحجب المبلغ عن غير المرتفعين
      // ونُبقي treasuryWarning (boolean) كي تُظهر شاشته تنبيهاً عاماً دون كشف رقم خزنة الفرع.
      return elevated ? res : { ...res, treasuryBalanceAfter: null };
    }),

  close: treasuryCashierProcedure
    .input(
      z.object({
        shiftId: z.number().int().positive(),
        // SHIFT-VALIDATE (تدقيق ٢/٧): النقد المعدود مالٌ غير سالب.
        countedCash: z.string().regex(/^\d+(\.\d{1,2})?$/, "النقد المعدود مبلغ غير سالب"),
        // treasury-stage2: snapshot عدّاد الفئات (اختياري).
        countedBreakdown: z.record(z.string(), z.number().int().min(0).max(10000)).nullish(),
        // عقد الحيازة: عند وجود نقد يجب تسمية مدير مستقل يستلمه ويعدّه لاحقاً.
        handoverToUserId: z.number().int().positive().nullish(),
        // مسار مالك استثنائي لورديات سالبة سبقت تفعيل الحارس. لا يَقبل مبلغ تمويل من العميل؛
        // الخدمة تعيد حساب العجز وتضيف خزينة→درج بالقيمة الدقيقة ثم تغلق بصفر.
        legacyNegativeRemediation: z
          .object({
            expectedCash: z.string().regex(/^-\d+(\.\d{1,2})?$/, "لقطة الرصيد السالب غير صالحة"),
            sourceTreasuryReceiptId: z.number().int().positive().nullish(),
            evidenceNote: z.string().trim().min(20).max(1000),
            confirmDrawerCountedZero: z.literal(true),
            clientRequestId: z.string().trim().min(1).max(64),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.legacyNegativeRemediation) {
        if (input.countedCash !== "0" && input.countedCash !== "0.00") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "معالجة الوردية السالبة تشترط أن يكون النقد المعدود فعلياً صفراً",
          });
        }
        const batch = await remediateAndCloseLegacyNegativeShifts(
          [
            {
              shiftId: input.shiftId,
              expectedCash: input.legacyNegativeRemediation.expectedCash,
              sourceTreasuryReceiptId:
                input.legacyNegativeRemediation.sourceTreasuryReceiptId ?? null,
              evidenceNote: input.legacyNegativeRemediation.evidenceNote,
              confirmDrawerCountedZero:
                input.legacyNegativeRemediation.confirmDrawerCountedZero,
              clientRequestId: input.legacyNegativeRemediation.clientRequestId,
            },
          ],
          {
            userId: ctx.user.id,
            branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : -1,
            role: ctx.user.role,
            isOwner: ctx.user.isOwner,
            ipAddress:
              (ctx.req.headers["x-forwarded-for"] as string | undefined)
                ?.split(",")[0]
                ?.trim() ?? ctx.req.ip ?? null,
          },
        );
        const corrected = batch.items[0];
        if (!corrected) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "لم تكتمل معالجة الوردية" });
        }
        return {
          ...corrected,
          requiresManagerReview: false,
          varianceReasonCode: null,
          varianceReason: null,
          treasuryReturn: null,
          legacyNegativeRemediation: {
            totalFunding: batch.totalFunding,
            treasury: batch.treasury,
            cutoff: batch.cutoff,
          },
        };
      }
      // سياسة #14: نمرّر دور الفاعل + فرعه ليفرض closeShift فحص الملكية/الفرع.
      // G4: استبدال `?? -1` الذي كان يُمرَّر للخدمة فيرفع رسالة مضلّلة (لا تطابُق فرع)
      // بدل سبب الحقيقي (لا فرع مُسنَد). FORBIDDEN صريح للأدوار غير المرتفعة.
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      if (!/^0(?:\.0{1,2})?$/.test(input.countedCash) && input.handoverToUserId == null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "حدد مديراً مستقلاً لاستلام نقد الوردية",
        });
      }
      // NUMBERING-RACE (تدقيق ٢/٧): ترقيم سند التسليم (CH) يحرّر GET_LOCK قبل الالتزام ⇒ إغلاقان
      // متزامنان لنفس الفرع/اليوم قد يحسبان نفس الرقم؛ القيد الفريد يرفض الثاني. نعيد المحاولة على
      // التصادم (closeShift ذرّية داخل withTx فتتراجع المحاولة الفاشلة كاملةً).
      const res = await retryOnDup(() =>
        closeShift({ ...input, enforceCashGovernance: true }, {
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
          reconciliationStatus: res.reconciliationStatus,
          varianceReasonCode: res.varianceReasonCode,
          varianceReason: res.varianceReason,
          requiresManagerReview: res.requiresManagerReview,
          // النقد خرج من الدرج إلى عهدة المستلم، ولا يدخل الخزينة قبل عدّه وقبوله.
          treasuryReturn: res.treasuryReturn
            ? {
                handoverNumber: res.treasuryReturn.handoverNumber,
                amount: res.countedCash,
                recipientUserId: res.treasuryReturn.recipientUserId,
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
        // سلسلة حيازة ثنائية: المستلم إلزامي، والخدمة تتحقق أنه مدير نشط
        // مختلف عن المُسلّم ومن فرع الوردية نفسه.
        dropTo: z.number().int().positive(),
        notes: z.string().max(500).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const res = await retryOnDup(() =>
        createCashDrop(
          { shiftId: input.shiftId, amount: input.amount, clientRequestId: input.clientRequestId, dropTo: input.dropTo, notes: input.notes ?? null },
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
          dropTo: input.dropTo,
          drawerBefore: res.drawerBefore,
          drawerAfter: res.drawerAfter,
        },
      });
      return res;
    }),

  // treasury-stage2: مستلِمو تسليم النقد عند إغلاق الوردية أو إعادة إسناد عهدة
  // معلّقة. المستلِم admin/manager نشط، أمّا القارئ فيشمل الكاشير والمدير والمحاسب
  // والمنح الصريح. غير admin يرى مستلمي فرعه فقط؛ admin يعبر الفروع لمعالجة
  // الوردية في الفرع المختار.
  handoverRecipients: treasuryHandoverRecipientsProcedure.query(async ({ ctx }) => {
    const db = getDb();
    if (!db) return [] as { id: number; name: string; branchId: number | null }[];
    const branchScope = ctx.user.role === "admin" ? null : Number(ctx.user.branchId);
    const rows = await db
      .select({ id: users.id, name: users.name, branchId: users.branchId })
      .from(users)
      .where(
        and(
          eq(users.isActive, true),
          inArray(users.role, ["admin", "manager"]),
          branchScope == null ? undefined : eq(users.branchId, branchScope),
        ),
      )
      .orderBy(users.name);
    return rows.map((r) => ({ id: r.id, name: r.name ?? `#${r.id}`, branchId: r.branchId == null ? null : Number(r.branchId) }));
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
      // إصلاح تدقيق ٢٧/٧: فرعُ الوردية مُعشَّشٌ تحت report.shift لا في جذر report — كان القالب
      // `(report as { branchId? })` يقرأ undefined دائماً فيُبطِل الحارس صامتاً (IDOR ماليّ عابر
      // للفروع). المسار الصحيح مُنمَّطٌ الآن فيمتنع تكرار الخطأ (لا cast).
      const sBranchId = report.shift.branchId;
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
        // كل شاشة تستعلم عن نوع ورديتها صراحةً (RECEPTION للاستقبال، PRINT_SERVICES للطباعة)؛
        // بدونه يُرجَع أيّ وردية مفتوحة.
        shiftType: z.enum(["RETAIL", "RECEPTION", "PRINT_SERVICES"]).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const effective = ctx.scopedBranchId ?? input.branchId;
      return getOpenShift(ctx.user.id, effective, input.shiftType);
    }),
});
