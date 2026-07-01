// تسجيل عدّة (submit) داخل withTx واحدة — العقد §٥ من docs/stocktake-contract.md.
import { TRPCError } from "@trpc/server";
import { mysqlCodeFrom } from "@shared/errorMap.ar";
import { and, eq } from "drizzle-orm";
import {
  stocktakeAssignments,
  stocktakeCounts,
  stocktakeItems,
  stocktakeSessions,
} from "../../../drizzle/schema";
import { requireDb, withTx } from "../tx";
import type { PortalIdentity } from "./identity";
import { SESSION_UNAVAILABLE_MSG, IDENTITY_EXPIRED_MSG, COUNTING_ENDED_MSG } from "./shared";

export type SubmitCountInput = {
  variantId: number;
  /** الكمية المعدودة بالوحدة الأساس (عدد صحيح ≥ 0). */
  qty: number;
  /** تفصيل الإدخال متعدد الوحدات (JSON نصي ≤ 500 حرف) — للتدقيق فقط. */
  unitBreakdown?: string | null;
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
  input: SubmitCountInput
): Promise<SubmitCountResult> {
  // حراسة دفاعية (zod في الراوتر يضمنها أيضاً).
  if (!Number.isInteger(input.qty) || input.qty < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الكمية يجب أن تكون عدداً صحيحاً غير سالب." });
  }
  if (input.unitBreakdown && input.unitBreakdown.length > 500) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تفصيل الوحدات أطول من المسموح." });
  }

  try {
    return await withTx(async (tx) => {
      // (٠) idempotency: نفس clientRequestId داخل الجلسة ⇒ أعد نتيجة العدّة الأولى بلا أثر.
      const dupRows = await tx
        .select()
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, identity.session.id),
            eq(stocktakeCounts.clientRequestId, input.clientRequestId)
          )
        )
        .limit(1);
      const dup = dupRows[0];
      if (dup) {
        return {
          ok: true as const,
          kind: dup.kind,
          verifyMatch: dup.kind === "VERIFY" ? !dup.isConflict : null,
          idempotent: true,
        };
      }

      // (١) الجلسة تحت قفل — يمنع السباق مع approve/forceReview/cancel.
      const sessionRows = await tx
        .select()
        .from(stocktakeSessions)
        .where(eq(stocktakeSessions.id, identity.session.id))
        .for("update")
        .limit(1);
      const session = sessionRows[0];
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: SESSION_UNAVAILABLE_MSG });
      if (session.status !== "COUNTING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: COUNTING_ENDED_MSG });
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
        throw new TRPCError({ code: "UNAUTHORIZED", message: IDENTITY_EXPIRED_MSG });
      }
      if (asg.status !== "ACTIVE") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "سلّمت عدّك مسبقاً — لا يمكن تسجيل أو تعديل عدّات بعد التسليم.",
        });
      }
      const myAssignmentId = Number(asg.id);

      // (٣) الصنف ضمن نطاق الجلسة (تحقّق خادمي — لا ثقة بالواجهة).
      const itemRows = await tx
        .select()
        .from(stocktakeItems)
        .where(
          and(
            eq(stocktakeItems.sessionId, session.id),
            eq(stocktakeItems.variantId, input.variantId)
          )
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

      // (٤) عدّات الصنف الحالية تحت قفل (تمنع سباق عدَّين متزامنين على نفس الصنف).
      const counts = await tx
        .select()
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, session.id),
            eq(stocktakeCounts.variantId, input.variantId)
          )
        )
        .for("update");
      counts.sort((a, b) => Number(a.id) - Number(b.id));

      const first = counts.find((c) => c.kind === "FIRST") ?? null;
      const recounts = counts.filter((c) => c.kind === "RECOUNT");
      const latestRecount = recounts.length ? recounts[recounts.length - 1] : null;
      // العدّ الفعّال = آخر RECOUNT إن وُجد وإلا FIRST (نفس قاعدة rawCount في المراجعة).
      const effectiveRow = latestRecount ?? first;

      const isMine = Number(item.assignmentId) === myAssignmentId;
      const now = new Date();

      let kind: "FIRST" | "RECOUNT" | "VERIFY";
      let verifyMatch: boolean | null = null;

      if (isMine && item.recountStatus === "PENDING") {
        // إعادة عدّ مطلوبة على صنفي ⇒ عدّ RECOUNT يحسم: يُنجز الطلب ويمسح أي تعارض.
        kind = "RECOUNT";
        await tx.insert(stocktakeCounts).values({
          sessionId: session.id,
          variantId: input.variantId,
          assignmentId: asg.id,
          kind: "RECOUNT",
          qty: input.qty,
          unitBreakdown: input.unitBreakdown ?? null,
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
              eq(stocktakeCounts.isConflict, true)
            )
          );
      } else {
        if (!isMine && session.dupPolicy === "BLOCK") {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "هذا الصنف من منطقة زميلك — سياسة هذه الجلسة تمنع العدّ المكرر. اطلب من مسؤول الجرد إسناده إليك إن لزم.",
          });
        }

        // آخر عدّ فعّال سجّلتُه أنا (RECOUNT إن وُجد وإلا FIRST) — «يمكنك تعديل العدّ قبل التسليم».
        const myOwn =
          [...counts]
            .reverse()
            .find(
              (c) =>
                Number(c.assignmentId) === myAssignmentId &&
                (c.kind === "FIRST" || c.kind === "RECOUNT")
            ) ?? null;

        if (myOwn) {
          // تحديث عدّي الذاتي (qty/at/breakdown) — clientRequestId الجديد يلتقط إعادة إرسال التعديل.
          kind = myOwn.kind as "FIRST" | "RECOUNT";
          await tx
            .update(stocktakeCounts)
            .set({
              qty: input.qty,
              unitBreakdown: input.unitBreakdown ?? null,
              countedAt: now,
              clientRequestId: input.clientRequestId,
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
            unitBreakdown: input.unitBreakdown ?? null,
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
              (c) => c.kind === "VERIFY" && Number(c.assignmentId) === myAssignmentId
            ) ?? null;
          // سدّ أوراكل الاستنتاج (مراجعة أمنية): نتيجة التطابق تُكشف لأول إرسال فقط —
          // تكرار تعديل التحقّقي مع رؤية match/لا-match يتيح استنتاج كمية الزميل بالتقريب.
          verifyMatch = myVerify ? null : match;
          if (myVerify) {
            await tx
              .update(stocktakeCounts)
              .set({
                qty: input.qty,
                unitBreakdown: input.unitBreakdown ?? null,
                countedAt: now,
                clientRequestId: input.clientRequestId,
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
              unitBreakdown: input.unitBreakdown ?? null,
              countedByName: identity.countedByName,
              countedByUserId: identity.countedByUserId,
              countedAt: now,
              isConflict: !match,
              clientRequestId: input.clientRequestId,
            });
          }
        }
      }

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
        .from(stocktakeCounts)
        .where(
          and(
            eq(stocktakeCounts.sessionId, identity.session.id),
            eq(stocktakeCounts.clientRequestId, input.clientRequestId)
          )
        )
        .limit(1);
      const dup = rows[0];
      if (dup) {
        return {
          ok: true,
          kind: dup.kind,
          verifyMatch: dup.kind === "VERIFY" ? !dup.isConflict : null,
          idempotent: true,
        };
      }
    }
    throw e;
  }
}
