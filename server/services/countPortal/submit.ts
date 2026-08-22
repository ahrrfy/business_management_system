// تسجيل عدّة (submit) داخل withTx واحدة — العقد §٥ من docs/stocktake-contract.md.
import { TRPCError } from "@trpc/server";
import { mysqlCodeFrom } from "@shared/errorMap.ar";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  products,
  productUnitBarcodes,
  productUnits,
  productVariants,
  stocktakeAssignments,
  stocktakeCountOperations,
  stocktakeCounts,
  stocktakeDecisions,
  stocktakeItems,
  stocktakeSessions,
  users,
} from "../../../drizzle/schema";
import { requireDb, withTx } from "../tx";
import type { PortalIdentity } from "./identity";
import {
  SESSION_UNAVAILABLE_MSG,
  IDENTITY_EXPIRED_MSG,
  COUNTING_ENDED_MSG,
} from "./shared";
import {
  isScanEntry,
  type CountEntryMethod,
  type CountMethod,
} from "../../../shared/stocktakeCountMethod";

function scannerPrefix(code: string | null | undefined): number | null {
  const digits = String(code ?? "").replace(/\D/g, "");
  // الباركود القصير قد يساوي كمية مشروعة مصادفةً؛ حادثة HID المثبتة تخص أكواداً طويلة.
  if (digits.length < 8) return null;
  const prefix = Number(digits.slice(0, 7));
  return Number.isSafeInteger(prefix) ? prefix : null;
}

function parseUnitBreakdown(
  raw: string | null | undefined,
): Record<string, number> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

export type SubmitCountInput = {
  variantId: number;
  /** الكمية المعدودة بالوحدة الأساس (عدد صحيح ≥ 0). */
  qty: number;
  /** تفصيل الإدخال متعدد الوحدات (JSON نصي ≤ 500 حرف) — للتدقيق فقط. */
  unitBreakdown?: string | null;
  /** إقرار صريح من مسؤول USER مكلّف بعد إعادة عدّ الكمية المشتبه بها يدوياً. */
  scannerGuardOverride?: boolean;
  /**
   * طريقة إدخال العدّة (نسبٌ يُدقَّق). في جلسة SCAN_REQUIRED يُلزم الخادمُ مسحاً فعلياً
   * (SCAN_HID/SCAN_CAMERA مع scannedBarcode يعيد الحلّ إلى نفس المتغيّر) أو استثناءً يدوياً
   * محكوماً بمشرف (MANUAL_AUTHORIZED)؛ ويرفض الاختيار الحر (SEARCH_PICK). غيابه = SEARCH_PICK.
   */
  entryMethod?: CountEntryMethod;
  /** الباركود الممسوح فعلاً (لإثبات المطابقة الخادمية) — يلزم لطرق المسح في SCAN_REQUIRED. */
  scannedBarcode?: string | null;
  /** مفتاح idempotency لمزامنة طابور الأوفلاين (uuid). */
  clientRequestId: string;
};

export type SubmitCountResult = {
  ok: true;
  kind: "FIRST" | "RECOUNT" | "VERIFY";
  /** للعدّ التحقّقي: هل طابق العدّ الفعّال؟ (null لغير VERIFY) — للتوست في الواجهة. */
  verifyMatch: boolean | null;
  /** true عند إعادة إرسال نفس clientRequestId (مزامنة أوفلاين مكرّرة) — نجاح بلا أثر. */
  idempotent: boolean;
};

/**
 * تسجيل عدّة (العقد §٥ — `submit`) داخل withTx واحدة:
 * - تحقّق: الجلسة COUNTING، التكليف ACTIVE، الصنف ضمن أصناف الجلسة — تحت قفل صفّي.
 * - منطقتي: recountStatus=PENDING ⇒ عدّ RECOUNT (يُنجز الطلب ويمسح أي تعارض —
 *   «العدّ الثالث يحسم»). وإلا: لي عدّ فعّال سابق ⇒ أحدّثه؛ لا عدّ فعّالاً ⇒ FIRST باسمي.
 * - منطقة زميل: BLOCK ⇒ رفض واضح. VERIFY: لا FIRST بعد ⇒ FIRST باسمي؛ يوجد عدّ
 *   فعّال لغيري ⇒ أدرج/أحدّث VERIFY باسمي مع isConflict عند الاختلاف — لا أحد يطمس عدّ أحد.
 * - idempotency: UNIQUE(sessionId, clientRequestId) — تكرار ⇒ نجاح بلا أثر.
 */
export async function submitCount(
  identity: PortalIdentity,
  input: SubmitCountInput,
): Promise<SubmitCountResult> {
  // حراسة دفاعية (zod في الراوتر يضمنها أيضاً).
  if (!Number.isInteger(input.qty) || input.qty < 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الكمية يجب أن تكون عدداً صحيحاً غير سالب.",
    });
  }
  if (input.unitBreakdown && input.unitBreakdown.length > 500) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تفصيل الوحدات أطول من المسموح.",
    });
  }

  try {
    return await withTx(async (tx) => {
      // (٠) idempotency: نفس clientRequestId داخل الجلسة ⇒ أعد نتيجة العدّة الأولى بلا أثر.
      // (١) الجلسة تحت قفل — يمنع السباق مع approve/forceReview/cancel.
      const sessionRows = await tx
        .select()
        .from(stocktakeSessions)
        .where(eq(stocktakeSessions.id, identity.session.id))
        .for("update")
        .limit(1);
      const session = sessionRows[0];
      if (!session)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: SESSION_UNAVAILABLE_MSG,
        });

      // Request ids live in a separate immutable ledger. Taking the session
      // lock first serializes devices, and this locking read then observes the
      // operation committed by a request that was ahead of us.
      const dupRows = await tx
        .select()
        .from(stocktakeCountOperations)
        .where(
          and(
            eq(stocktakeCountOperations.sessionId, identity.session.id),
            eq(stocktakeCountOperations.clientRequestId, input.clientRequestId),
          ),
        )
        .for("update")
        .limit(1);
      const dup = dupRows[0];
      if (dup) {
        return {
          ok: true as const,
          kind: dup.resultKind,
          verifyMatch: dup.resultVerifyMatch,
          idempotent: true,
        };
      }

      if (session.status !== "COUNTING") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: COUNTING_ENDED_MSG,
        });
      }

      // (٢) التكليف ACTIVE تحت قفل.
      const asgRows = await tx
        .select()
        .from(stocktakeAssignments)
        .where(eq(stocktakeAssignments.id, identity.assignment.id))
        .for("update")
        .limit(1);
      const asg = asgRows[0];
      if (!asg || Number(asg.sessionId) !== Number(session.id)) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: IDENTITY_EXPIRED_MSG,
        });
      }
      if (asg.status !== "ACTIVE") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "تكليف الجرد غير نشط — لا يمكن تسجيل أو تعديل عدّات بعد التسليم أو إزالة العامل.",
        });
      }
      const myAssignmentId = Number(asg.id);

      // (٣) الصنف ضمن نطاق الجلسة (تحقّق خادمي — لا ثقة بالواجهة).
      const itemRows = await tx
        .select({
          id: stocktakeItems.id,
          recountStatus: stocktakeItems.recountStatus,
          reviewApprovedAt: stocktakeItems.reviewApprovedAt,
          sku: productVariants.sku,
        })
        .from(stocktakeItems)
        .innerJoin(
          productVariants,
          eq(stocktakeItems.variantId, productVariants.id),
        )
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(
          and(
            eq(stocktakeItems.sessionId, session.id),
            eq(stocktakeItems.variantId, input.variantId),
            eq(products.isService, false),
          ),
        )
        .for("update")
        .limit(1);
      const item = itemRows[0];
      if (!item) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "هذا الصنف خارج نطاق جلسة الجرد — راجع مسؤول الجرد.",
        });
      }
      if (item.reviewApprovedAt != null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "اعتمدت الإدارة عدّ هذا المنتج مرحلياً — لا يمكن تعديله إلا بعد طلب إعادة عدّ جديد.",
        });
      }

      // حارس تضخم الكمية من قارئ HID: عند فتح بطاقة الكمية يكون قارئ الباركود العام معطلاً
      // والحقل مركزاً، فتدخل أرقام الباركود ثم تقصها الواجهة إلى أول 7 أرقام. نرفض البصمة
      // خادمياً قبل أي كتابة، مع مراعاة معامل الوحدة والباركودات البديلة.
      // كل الوحدات (نشطةً ومتقاعدة) — حارسُ «الكمية تطابق بادئة باركود» يفحصها جميعاً لأنّ رقم
      // باركودٍ متقاعدٍ كُتب في حقل العدد يبقى خطأَ ماسحٍ يجب رفضه (يحرسه اختبار البوابة القائم).
      // ونعلّم isActive كي نبني **دليل المسح** (#6) من النشطة وحدها أدناه.
      const units = await tx
        .select({
          id: productUnits.id,
          unitName: productUnits.unitName,
          factor: productUnits.conversionFactor,
          barcode: productUnits.barcode,
          isActive: productUnits.isActive,
        })
        .from(productUnits)
        .where(eq(productUnits.variantId, input.variantId));
      const aliases = await tx
        .select({
          unitName: productUnits.unitName,
          factor: productUnits.conversionFactor,
          barcode: productUnitBarcodes.barcode,
          isActive: productUnits.isActive,
        })
        .from(productUnitBarcodes)
        .innerJoin(
          productUnits,
          eq(productUnitBarcodes.productUnitId, productUnits.id),
        )
        .where(eq(productUnits.variantId, input.variantId));
      // ── إثبات المصدر (وثيقة «الجرد بالباركود» ٢٢/٨) ──
      // مشرفٌ مُصرِّح: تكليف USER لحسابٍ رتبته manager/admin — مصدر واحد لتجاوز حارس الماسح
      // وللاستثناء اليدويّ المحكوم في جلسة المسح الإلزامي. مُذكَّر: استعلام users مرّةً واحدة.
      let supervisorResolved = false;
      let supervisorUserId: number | null = null;
      const getSupervisorUserId = async (): Promise<number | null> => {
        if (supervisorResolved) return supervisorUserId;
        supervisorResolved = true;
        if (
          identity.mode === "USER" &&
          identity.countedByUserId != null &&
          asg.method === "USER" &&
          asg.userId != null &&
          Number(asg.userId) === Number(identity.countedByUserId)
        ) {
          const supervisor = (
            await tx
              .select({ role: users.role })
              .from(users)
              .where(eq(users.id, Number(asg.userId)))
              .limit(1)
          )[0];
          if (supervisor?.role === "manager" || supervisor?.role === "admin") {
            supervisorUserId = Number(asg.userId);
          }
        }
        return supervisorUserId;
      };

      // أسلوب الجلسة يقرّر ما إذا كان المسح إلزامياً. غياب entryMethod = SEARCH_PICK (عميل قديم):
      // مقبول في FREE، مرفوض في SCAN_REQUIRED — فلا تمرّ عدّةٌ حرّة عبر واجهةٍ متجاوِزة.
      const sessionMethod = session.countMethod as CountMethod;
      const entryMethod: CountEntryMethod = input.entryMethod ?? "SEARCH_PICK";
      const scannedBarcode = input.scannedBarcode?.trim() || null;

      if (sessionMethod === "SCAN_REQUIRED") {
        if (isScanEntry(entryMethod)) {
          // مسحٌ فعليّ ⇒ الباركود الممسوح يجب أن يعيد الحلّ إلى **هذا** المتغيّر خادمياً
          // (لا ثقة بالواجهة): يطابق باركود وحدةٍ **نشطة** أو بديلَ وحدةٍ نشطة لنفس المتغيّر.
          // (#6) الوحدة المتقاعدة لا تُقبل دليلاً — لا تعرضها الواجهة ولا تعدّها التغطية «متاحة».
          const variantCodes = new Set<string>();
          for (const u of units)
            if (u.barcode && u.isActive !== false) variantCodes.add(String(u.barcode).trim());
          for (const a of aliases)
            if (a.barcode && a.isActive !== false) variantCodes.add(String(a.barcode).trim());
          if (!scannedBarcode) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "هذه الجلسة بأسلوب المسح الإلزامي — امسح باركود الصنف لفتح بطاقة العدّ.",
            });
          }
          if (!variantCodes.has(scannedBarcode)) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "الباركود الممسوح لا يخصّ هذا الصنف — امسح باركود الصنف الصحيح، أو أبلغ مسؤول الجرد إن كان الباركود مفقوداً.",
            });
          }
        } else if (entryMethod === "MANUAL_AUTHORIZED") {
          // استثناء يدويّ محكوم: يلزمه إذن مشرف (باركود تالف/بلا ملصق/قارئ معطّل).
          const authorizedBy = await getSupervisorUserId();
          if (authorizedBy == null) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message:
                "الإدخال اليدويّ في جلسة المسح الإلزامي يتطلّب إذن مسؤول الجرد من حساب USER مكلّف برتبة manager أو admin.",
            });
          }
        } else {
          // SEARCH_PICK أو غيره ⇒ اختيارٌ حرّ ممنوع في المسح الإلزامي.
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "هذه الجلسة بأسلوب المسح الإلزامي — لا يُفتح العدّ بالاختيار من القائمة، امسح باركود الصنف.",
          });
        }
      }
      // القيمتان المخزَّنتان: الباركود يُحفظ لطرق المسح فقط (يدويّ/حر بلا باركود).
      const storedEntryMethod: CountEntryMethod = entryMethod;
      const storedScannedBarcode = isScanEntry(entryMethod)
        ? scannedBarcode
        : null;

      const breakdown = parseUnitBreakdown(input.unitBreakdown);
      const candidates = [
        ...units.map((unit) => ({
          unitName: unit.unitName,
          factor: unit.factor,
          code: unit.barcode,
        })),
        ...aliases.map((unit) => ({
          unitName: unit.unitName,
          factor: unit.factor,
          code: unit.barcode,
        })),
        { unitName: null, factor: "1", code: item.sku },
      ];
      const scannerLike = candidates.some((candidate) => {
        const prefix = scannerPrefix(candidate.code);
        if (prefix == null) return false;
        if (candidate.unitName && breakdown?.[candidate.unitName] === prefix)
          return true;
        const baseQty = new Decimal(prefix).times(String(candidate.factor));
        return (
          baseQty.isInteger() &&
          baseQty.abs().lte(Number.MAX_SAFE_INTEGER) &&
          baseQty.toNumber() === input.qty
        );
      });
      let scannerOverrideByUserId: number | null = null;
      if (scannerLike && input.scannerGuardOverride === true) {
        scannerOverrideByUserId = await getSupervisorUserId();
      }
      if (scannerLike && scannerOverrideByUserId == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "الكمية تطابق بداية باركود المنتج ويُحتمل أن الماسح كتب داخل حقل العدد. امسح الحقل وأعد العدّ يدوياً؛ وللكمية المشروعة يلزم تأكيد مسؤول الجرد من حساب USER مكلّف برتبة manager أو admin.",
        });
      }
      const candidateDigest = createHash("sha256")
        .update(
          JSON.stringify(
            candidates
              .map((candidate) => ({
                code: String(candidate.code ?? ""),
                factor: new Decimal(String(candidate.factor)).toString(),
                unitName: candidate.unitName ?? null,
              }))
              .sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b)),
              ),
          ),
          "utf8",
        )
        .digest("hex");
      const guardedUnitBreakdown = JSON.stringify({
        ...(breakdown ?? {}),
        __stocktakeScannerGuard: {
          version: 1,
          qty: input.qty,
          candidateDigest,
          ...(scannerOverrideByUserId == null
            ? {}
            : {
                override: "SUPERVISOR_USER",
                authorizedByUserId: scannerOverrideByUserId,
              }),
        },
      });

      // (٤) عدّات الصنف الحالية تحت قفل (تمنع سباق عدَّين متزامنين على نفس الصنف).
      const counts = await tx
        .select()
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, session.id),
            eq(stocktakeCounts.variantId, input.variantId),
          ),
        )
        .for("update");
      counts.sort((a, b) => Number(a.id) - Number(b.id));

      const first = counts.find((c) => c.kind === "FIRST") ?? null;
      const recounts = counts.filter((c) => c.kind === "RECOUNT");
      const latestRecount = recounts.length
        ? recounts[recounts.length - 1]
        : null;
      // العدّ الفعّال = آخر RECOUNT إن وُجد وإلا FIRST (نفس قاعدة rawCount في المراجعة).
      const effectiveRow = latestRecount ?? first;

      const now = new Date();

      let kind: "FIRST" | "RECOUNT" | "VERIFY";
      let verifyMatch: boolean | null = null;

      if (item.recountStatus === "PENDING") {
        // إعادة عدّ مطلوبة على صنفي ⇒ عدّ RECOUNT يحسم: يُنجز الطلب ويمسح أي تعارض.
        kind = "RECOUNT";
        await tx.insert(stocktakeCounts).values({
          sessionId: session.id,
          variantId: input.variantId,
          assignmentId: asg.id,
          kind: "RECOUNT",
          qty: input.qty,
          unitBreakdown: guardedUnitBreakdown,
          entryMethod: storedEntryMethod,
          scannedBarcode: storedScannedBarcode,
          countedByName: identity.countedByName,
          countedByUserId: identity.countedByUserId,
          countedAt: now,
          clientRequestId: input.clientRequestId,
        });
        await tx
          .update(stocktakeItems)
          .set({ recountStatus: "DONE" })
          .where(eq(stocktakeItems.id, item.id));
        // «التعارض يُحل بالعدّ الثالث» — امسح أعلام التعارض على هذا الصنف.
        await tx
          .update(stocktakeCounts)
          .set({ isConflict: false })
          .where(
            and(
              eq(stocktakeCounts.sessionId, session.id),
              eq(stocktakeCounts.variantId, input.variantId),
              eq(stocktakeCounts.isConflict, true),
            ),
          );
      } else {
        const myOwn =
          [...counts]
            .reverse()
            .find(
              (c) =>
                Number(c.assignmentId) === myAssignmentId &&
                (c.kind === "FIRST" || c.kind === "RECOUNT"),
            ) ?? null;

        if (effectiveRow && !myOwn && session.dupPolicy === "BLOCK") {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "سُجّل عدّ لهذا الصنف بالفعل — سياسة هذه الجلسة تمنع العدّ المكرر.",
          });
        }

        // آخر عدّ فعّال سجّلتُه أنا (RECOUNT إن وُجد وإلا FIRST) — «يمكنك تعديل العدّ قبل التسليم».
        if (myOwn) {
          // تحديث projection العدّ فقط؛ مفاتيح الطلب تبقى ثابتة في سجل العمليات.
          kind = myOwn.kind as "FIRST" | "RECOUNT";
          await tx
            .update(stocktakeCounts)
            .set({
              qty: input.qty,
              unitBreakdown: guardedUnitBreakdown,
              entryMethod: storedEntryMethod,
              scannedBarcode: storedScannedBarcode,
              countedAt: now,
            })
            .where(eq(stocktakeCounts.id, myOwn.id));

          // إن كان عدّي هو العدّ الفعّال للصنف، أعد تقييم تعارض العدّات التحقّقية
          // غير المحسومة (تصحيحي لرقم الزميل المطابق يجب أن يُسقط التعارض، والعكس).
          const effectiveAfter =
            effectiveRow && Number(effectiveRow.id) === Number(myOwn.id)
              ? input.qty
              : (effectiveRow?.qty ?? input.qty);
          for (const v of counts) {
            if (v.kind !== "VERIFY" || v.resolvedPick) continue;
            const conflictNow = v.qty !== effectiveAfter;
            if (conflictNow !== v.isConflict) {
              await tx
                .update(stocktakeCounts)
                .set({ isConflict: conflictNow })
                .where(eq(stocktakeCounts.id, v.id));
            }
          }
        } else if (!effectiveRow) {
          // لا عدّ فعّالاً بعد ⇒ FIRST باسمي (في منطقتي، أو منطقة زميل بسياسة VERIFY).
          kind = "FIRST";
          await tx.insert(stocktakeCounts).values({
            sessionId: session.id,
            variantId: input.variantId,
            assignmentId: asg.id,
            kind: "FIRST",
            qty: input.qty,
            unitBreakdown: guardedUnitBreakdown,
            entryMethod: storedEntryMethod,
            scannedBarcode: storedScannedBarcode,
            countedByName: identity.countedByName,
            countedByUserId: identity.countedByUserId,
            countedAt: now,
            clientRequestId: input.clientRequestId,
          });
        } else {
          // يوجد عدّ فعّال سجّله غيري ⇒ عدّ تحقّقي باسمي — العدّان يبقيان في السجل دائماً.
          // المقارنة ضد العدّ الفعّال (آخر RECOUNT وإلا FIRST) كما في نموذج jrd-count —
          // تمنع تعارضاً زائفاً ضد FIRST قديم حلّ محله RECOUNT.
          kind = "VERIFY";
          const match = input.qty === effectiveRow.qty;
          const myVerify =
            counts.find(
              (c) =>
                c.kind === "VERIFY" &&
                Number(c.assignmentId) === myAssignmentId,
            ) ?? null;
          // سدّ أوراكل الاستنتاج (مراجعة أمنية): نتيجة التطابق تُكشف لأول إرسال فقط —
          // تكرار تعديل التحقّقي مع رؤية match/لا-match يتيح استنتاج كمية الزميل بالتقريب.
          verifyMatch = myVerify ? null : match;
          if (myVerify) {
            await tx
              .update(stocktakeCounts)
              .set({
                qty: input.qty,
                unitBreakdown: guardedUnitBreakdown,
                entryMethod: storedEntryMethod,
                scannedBarcode: storedScannedBarcode,
                countedAt: now,
                isConflict: !match,
                // تعديل العدّ التحقّقي يُلغي حسماً سابقاً مبنياً على قيمة قديمة.
                resolvedBy: null,
                resolvedPick: null,
                resolvedAt: null,
              })
              .where(eq(stocktakeCounts.id, myVerify.id));
          } else {
            await tx.insert(stocktakeCounts).values({
              sessionId: session.id,
              variantId: input.variantId,
              assignmentId: asg.id,
              kind: "VERIFY",
              qty: input.qty,
              unitBreakdown: guardedUnitBreakdown,
              entryMethod: storedEntryMethod,
              scannedBarcode: storedScannedBarcode,
              countedByName: identity.countedByName,
              countedByUserId: identity.countedByUserId,
              countedAt: now,
              isConflict: !match,
              clientRequestId: input.clientRequestId,
            });
          }
        }
      }

      // أي عدّ جديد/معدّل يغيّر أساس القرار الإداري؛ يسقط القرار السابق ويُعاد إلى المراجعة.
      await tx
        .delete(stocktakeDecisions)
        .where(
          and(
            eq(stocktakeDecisions.sessionId, session.id),
            eq(stocktakeDecisions.variantId, input.variantId),
          ),
        );

      // Record the accepted request in the same transaction as the mutable
      // projection. This row is append-only and is the sole replay authority.
      await tx.insert(stocktakeCountOperations).values({
        sessionId: session.id,
        variantId: input.variantId,
        assignmentId: asg.id,
        clientRequestId: input.clientRequestId,
        requestQty: input.qty,
        requestUnitBreakdown: guardedUnitBreakdown,
        entryMethod: storedEntryMethod,
        scannedBarcode: storedScannedBarcode,
        resultKind: kind,
        resultVerifyMatch: verifyMatch,
      });

      // (٥) آخر نشاط للتكليف — يغذّي شاشة المتابعة الحية.
      await tx
        .update(stocktakeAssignments)
        .set({ lastActivityAt: now })
        .where(eq(stocktakeAssignments.id, asg.id));

      return { ok: true as const, kind, verifyMatch, idempotent: false };
    });
  } catch (e) {
    // سباق طلبين متزامنين بنفس clientRequestId: الثاني يصطدم بالقيد الفريد
    // UNIQUE(sessionId, clientRequestId) فتُلغى معاملته — نعيد نتيجة العدّة الأولى.
    if (mysqlCodeFrom(e) === "ER_DUP_ENTRY") {
      const db = requireDb();
      const rows = await db
        .select()
        .from(stocktakeCountOperations)
        .where(
          and(
            eq(stocktakeCountOperations.sessionId, identity.session.id),
            eq(stocktakeCountOperations.clientRequestId, input.clientRequestId),
          ),
        )
        .limit(1);
      const dup = rows[0];
      if (dup) {
        return {
          ok: true,
          kind: dup.resultKind,
          verifyMatch: dup.resultVerifyMatch,
          idempotent: true,
        };
      }
    }
    throw e;
  }
}
