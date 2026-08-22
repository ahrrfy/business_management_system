// راوتر بوابة العدّ الخارجية (العقد §٥ — يُركَّب كـ `count`).
//
// كل الإجراءات publicProcedure: الهوية ليست جلسة النظام بل كوكي `count_token`
// (JWT يُصدَر بعد PIN صحيح) أو مستخدم نظام مسجَّل بتكليف method=USER — تُحلّ في
// countPortalService.resolvePortalIdentity. الرسائل عربية مهذبة لعامل خارجي،
// وكل عدّ وتسليم يُسجَّل في auditLogs (user قد يكون null ⇒ countedByName في newValue).
//
// ملاحظة أمنية: rate-limit على `count.auth` يضيفه القائد في server/index.ts
// (بنمط auth.login) — انظر العقد §٧.

import { TRPCError } from "@trpc/server";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { getSessionCookieOptions } from "../cookies";
import { stocktakeAssignments, stocktakeSessions } from "../../drizzle/schema";
import { getDb } from "../db";
import { logAudit } from "../services/auditService";
import {
  authenticatePin,
  COUNT_COOKIE_NAME,
  COUNT_TOKEN_TTL_MS,
  finishAssignment,
  getPortalCatalog,
  getPortalDynamic,
  getPortalPulse,
  recordUnknownScan,
  resolvePortalIdentity,
  submitCount,
} from "../services/countPortalService";
import { publicProcedure, router, stocktakeAssignmentProcedure } from "../trpc";

/** رمز الجلسة من الرابط (مثل CNT-2026-0008) — يُطبَّع داخل الخدمة (trim/uppercase). */
const sessionCode = z
  .string()
  .trim()
  .min(4, "رمز الجلسة غير صالح")
  .max(40, "رمز الجلسة غير صالح")
  .regex(/^[A-Za-z0-9-]+$/, "رمز الجلسة غير صالح");

export const countPortalRouter = router({
  /**
   * جلسات العدّ المفتوحة المسندة للحساب الحالي فقط. هذه نقطة الدخول داخل
   * النظام؛ لا تكشف أي جلسة أو عامل آخر، ولا تحتاج رمز PIN إطلاقاً.
   */
  mine: stocktakeAssignmentProcedure.query(async ({ ctx }) => {
    const db = getDb();
    if (!db) return [] as Array<{
      sessionCode: string;
      sessionName: string;
      branchId: number;
      assignmentId: number;
      assignmentStatus: "ACTIVE" | "SUBMITTED";
      zone: string | null;
      lastActivityAt: Date | null;
    }>;

    const rows = await db
      .select({
        sessionCode: stocktakeSessions.code,
        sessionName: stocktakeSessions.name,
        branchId: stocktakeSessions.branchId,
        assignmentId: stocktakeAssignments.id,
        assignmentStatus: stocktakeAssignments.status,
        zone: stocktakeAssignments.zone,
        lastActivityAt: stocktakeAssignments.lastActivityAt,
      })
      .from(stocktakeAssignments)
      .innerJoin(stocktakeSessions, eq(stocktakeSessions.id, stocktakeAssignments.sessionId))
      .where(
        and(
          eq(stocktakeAssignments.method, "USER"),
          eq(stocktakeAssignments.userId, ctx.user.id),
          ne(stocktakeAssignments.status, "REMOVED"),
          eq(stocktakeSessions.status, "COUNTING"),
        ),
      )
      .orderBy(desc(stocktakeAssignments.lastActivityAt), desc(stocktakeAssignments.createdAt));

    return rows.map((row) => ({
      ...row,
      assignmentStatus: row.assignmentStatus as "ACTIVE" | "SUBMITTED",
      branchId: Number(row.branchId),
      assignmentId: Number(row.assignmentId),
    }));
  }),

  /**
   * دخول البوابة: PIN (٤ أرقام) ⇒ توكن JWT في كوكي count_token،
   * أو بلا PIN لمستخدم نظام مسجَّل له تكليف USER في الجلسة.
   */
  auth: publicProcedure
    .input(
      z.object({
        sessionCode,
        pin: z
          .string()
          .regex(/^\d{4}$/, "رمز الدخول مكوّن من 4 أرقام")
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const r = await authenticatePin(ctx.user, input);
        // وضع PIN فقط يُصدر توكناً — يوضع في كوكي بنفس خيارات كوكي الجلسة (httpOnly/strict/secure).
        if (r.token) {
          ctx.res.cookie(COUNT_COOKIE_NAME, r.token, {
            ...getSessionCookieOptions(ctx.req),
            maxAge: COUNT_TOKEN_TTL_MS,
          });
        }
        await logAudit(ctx, {
          action: "stocktake.portalAuth",
          entityType: "stocktake",
          entityId: r.session.id,
          newValue: {
            assignmentId: r.assignment.id,
            countedByName: r.assignment.name,
            zone: r.assignment.zone ?? null,
            mode: r.mode,
          },
        });
        return {
          ok: true as const,
          assignmentName: r.assignment.name,
          zone: r.assignment.zone,
          mode: r.mode,
        };
      } catch (e) {
        // فشل الدخول يُسجَّل للتدقيق — هجمات تخمين PIN/رموز الجلسات تُرى في السجل.
        if (e instanceof TRPCError) {
          await logAudit(ctx, {
            action: "stocktake.portalAuth.failed",
            entityType: "stocktake",
            entityId: null,
            newValue: { sessionCode: input.sessionCode, reason: e.code },
          });
        }
        throw e;
      }
    }),

  /**
   * حالة البوابة (جرد أعمى): أصنافي + أصناف الزملاء (للبحث/العدّ التحقّقي) +
   * مهام إعادة العدّ + التقدّم — بلا أرصدة دفترية ولا أسعار ولا كميات زملاء.
   */
  /**
   * حالة البوابة بنمط ETag في **جولةٍ واحدة**: يمرّر العميل وسم نسخته (`knownVersion`)؛ فإن
   * طابق الحالي رُدّ `changed:false` بلا حمولة (عشرات البايتات بدل ~١٠٠ﻙﺐ)، وإلّا رُدّت
   * الحالة الكاملة مع الوسم الجديد. بلا `knownVersion` ⇒ الحالة الكاملة دائماً (أول تحميل).
   *
   * ⚠️ الفحص مطويٌّ **داخل** `state` عمداً لا في إجراءٍ جديد: أي `publicProcedure` جديد
   * يُدخِل نقطة سلطةٍ مستجدّة يرفضها `authz-guard` بنيوياً (لا أساسَ يُحدَّث ولا استثناء).
   * والطيّ أفضل وظيفياً أيضاً — جولةٌ واحدة عند التغيّر بدل جولتَي «نبضة ثم جلب».
   */
  state: publicProcedure
    .input(
      z.object({
        sessionCode,
        knownVersion: z.string().max(64).optional(),
        /** وسم الكتالوج لدى العميل — إن طابق لم يُعد إرساله (٨٣٪ من الحمولة). */
        knownCatalogVersion: z.string().max(64).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const identity = await resolvePortalIdentity(ctx, input.sessionCode);
      // استعلاما تجميعٍ مفهرسان يعطيان **الوسمين معاً** — بلا تجسيد أي صفّ.
      const { v, cv } = await getPortalPulse(identity);

      // ① لا شيء تبدّل ⇒ ردٌّ بعشرات البايتات (الحالة الغالبة، ~٨٩٪).
      if (input.knownVersion && input.knownVersion === v) {
        return { v, cv, changed: false as const, catalog: null, dynamic: null };
      }

      // ② تبدّل شيء ⇒ المتغيّر دائماً، والكتالوج **فقط** إن كان لدى العميل قديماً.
      // ⚠️ المقارنة تسبق البناء عمداً: بناء الكتالوج ثمّ رميه كان يُبقي حمل القاعدة
      // والتخصيصات كما هي (٣٤١٤ صنفاً + وحداتها + باركوداتها لكل عادّ عند كل تغيّر)،
      // فيوفّر بايتات الشبكة وحدها ولا يعالج ضغط الذاكرة الذي أتت الشريحة لأجله.
      const catalogFresh = input.knownCatalogVersion === cv;
      const [dynamic, catalog] = await Promise.all([
        getPortalDynamic(identity),
        catalogFresh ? Promise.resolve(null) : getPortalCatalog(identity),
      ]);
      return { v, cv, changed: true as const, catalog: catalog?.items ?? null, dynamic };
    }),

  /**
   * تسجيل عدّة (idempotent عبر clientRequestId — آمن لمزامنة طابور الأوفلاين).
   *
   * يطوي أيضاً **التقاط الباركود المجهول** (ب-٤): إن حُدِّد `unknownBarcode` (بلا variantId)
   * سُجِّل في طابور الجلسة بدل عدٍّ — عمداً في هذا الإجراء لا إجراءٍ جديد، لأنّ أيّ publicProcedure
   * جديد = انتهاءُ سلطةٍ يرفضه حارس الصلاحيات (سلطته none). النتيجة موحّدة بحقل `kind`.
   */
  submit: publicProcedure
    .input(
      z.object({
        sessionCode,
        variantId: z.number().int().positive().optional(),
        // الكمية بالوحدة الأساس (التحويل من كرتون/درزن يتم في الواجهة قبل الإرسال).
        qty: z
          .number()
          .int("الكمية بالوحدة الأساس يجب أن تكون عدداً صحيحاً")
          .min(0, "الكمية لا تكون سالبة")
          .max(99_999_999, "الكمية أكبر من المعقول — راجع الإدخال")
          .optional(),
        unitBreakdown: z.string().max(500).optional(),
        scannerGuardOverride: z.boolean().optional(),
        // نسب العدّة إلى مصدرها؛ الإثبات النهائي (إعادة حلّ الباركود) خادميّ في submitCount.
        entryMethod: z
          .enum(["SCAN_HID", "SCAN_CAMERA", "MANUAL_AUTHORIZED", "SEARCH_PICK"])
          .optional(),
        scannedBarcode: z.string().trim().max(64).optional(),
        // مسار الباركود المجهول: باركودٌ مُسِح ولم يُحلّ داخل الجلسة (يُلتقط للمشرف، لا يُعدّ).
        unknownBarcode: z.string().trim().min(1).max(64).optional(),
        clientRequestId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const identity = await resolvePortalIdentity(ctx, input.sessionCode);

      // مسار الباركود المجهول (ب-٤): يُلتقط بدل أن يضيع، ولا يُعدّ.
      if (input.unknownBarcode) {
        const res = await recordUnknownScan(identity, {
          barcode: input.unknownBarcode,
          clientRequestId: input.clientRequestId,
        });
        if (!res.idempotent && res.recorded) {
          await logAudit(ctx, {
            action: "stocktake.unknownScan",
            entityType: "stocktake",
            entityId: identity.session.id,
            newValue: {
              barcode: input.unknownBarcode,
              countedByName: identity.countedByName,
              assignmentId: identity.assignment.id,
              clientRequestId: input.clientRequestId,
            },
          });
        }
        return {
          ok: true as const,
          kind: "UNKNOWN" as const,
          verifyMatch: null,
          idempotent: res.idempotent,
        };
      }

      // مسار العدّ العاديّ — يلزمه المتغيّر والكمية.
      if (input.variantId == null || input.qty == null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "العدّة تحتاج تحديد الصنف والكمية.",
        });
      }
      const res = await submitCount(identity, {
        variantId: input.variantId,
        qty: input.qty,
        unitBreakdown: input.unitBreakdown ?? null,
        scannerGuardOverride: input.scannerGuardOverride,
        entryMethod: input.entryMethod,
        scannedBarcode: input.scannedBarcode ?? null,
        clientRequestId: input.clientRequestId,
      });
      // لا نكرّر سطر التدقيق عند إعادة مزامنة نفس العدّة (idempotent replay).
      if (!res.idempotent) {
        await logAudit(ctx, {
          action: "stocktake.count",
          entityType: "stocktake",
          entityId: identity.session.id,
          newValue: {
            variantId: input.variantId,
            qty: input.qty,
            kind: res.kind,
            verifyMatch: res.verifyMatch,
            entryMethod: input.entryMethod ?? null,
            scannedBarcode: input.scannedBarcode ?? null,
            scannerGuardOverrideRequested:
              input.scannerGuardOverride === true,
            countedByName: identity.countedByName,
            assignmentId: identity.assignment.id,
            clientRequestId: input.clientRequestId,
          },
        });
      }
      return res;
    }),

  /** تسليم العدّ: التكليف ⇒ SUBMITTED؛ آخر تكليف ⇒ الجلسة REVIEW آلياً. */
  finish: publicProcedure.input(z.object({ sessionCode })).mutation(async ({ input, ctx }) => {
    const identity = await resolvePortalIdentity(ctx, input.sessionCode);
    const res = await finishAssignment(identity);
    if (!res.alreadySubmitted) {
      await logAudit(ctx, {
        action: "stocktake.submitAssignment",
        entityType: "stocktake",
        entityId: identity.session.id,
        newValue: {
          assignmentId: identity.assignment.id,
          countedByName: identity.countedByName,
          zone: identity.assignment.zone ?? null,
          sessionMovedToReview: res.sessionMovedToReview,
        },
      });
    }
    return { ok: res.ok, sessionMovedToReview: res.sessionMovedToReview };
  }),

  /** حفظ وإنهاء وردية: تبقى الجلسة COUNTING ويستأنف العامل لاحقاً من نفس التقدم. */
  /** خروج: مسح كوكي البوابة (لا يمسّ كوكي جلسة النظام). */
  logout: publicProcedure.mutation(async ({ ctx }) => {
    ctx.res.clearCookie(COUNT_COOKIE_NAME, getSessionCookieOptions(ctx.req));
    return { ok: true } as const;
  }),
});
