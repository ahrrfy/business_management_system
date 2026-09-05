/**
 * راوترُ القرارات — صندوق «مطلوب مني الآن» المبنيّ من `shared/decisionRegistry.ts` (م٧ ق٢).
 *
 * **البوّابة `superAppProcedure` (سلطةٌ من نوع «خريطة الوحدات») لا `branchScopedProcedure`:**
 * الصندوق يعبر الوحدات كلَّها، فلا تصلح بوّابةُ وحدةٍ واحدة؛ والمعالِج يُقيّم لكلّ نوعٍ بوّابةَ
 * إجرائه الأصليّ بمفردات `shared/permissions.ts` نفسها (`server/services/decisions/gate.ts`) —
 * وهو ما يصنّفه جردُ الصلاحيات `module-map` (نفسُ صنف `superApp.approvalInbox` القائم).
 * و`branchScopedProcedure` كانت ترفض المالكَ بلا فرعٍ مُسنَد — والمالك أوّلُ من يفتح هذا الصندوق.
 *
 * الإنفاذُ النهائيّ خادميٌّ في الخدمة: بوّابةُ المصدر ثمّ حرّاسُ دالّة الحسم الأصلية.
 */
import { z } from "zod";
import { DECISION_ACTIONS } from "@shared/decisionRegistry";
import { canCrossBranches } from "@shared/predicates";
import type { PermissionMap } from "@shared/permissions";
import { decideDecision, listDecisionInbox, type DecisionActor } from "../services/decisions";
import { logAudit } from "../services/auditService";
import { router, superAppProcedure } from "../trpc";
import type { TrpcContext } from "../context";

export function decisionActorFromUser(user: NonNullable<TrpcContext["user"]>): DecisionActor {
  return {
    userId: user.id,
    branchId: user.branchId == null ? null : Number(user.branchId),
    role: user.role,
    isOwner: user.isOwner === true,
    permissionsOverride: (user.permissionsOverride ?? null) as PermissionMap | null,
    crossBranch: canCrossBranches(user),
  };
}

export const decisionsRouter = router({
  inbox: superAppProcedure
    .input(
      z
        .object({
          kind: z.string().trim().min(1).max(80).optional(),
          branchId: z.number().int().positive().optional(),
          minAgeHours: z.number().min(0).max(24 * 365).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listDecisionInbox(decisionActorFromUser(ctx.user), input ?? {})),

  decide: superAppProcedure
    .input(
      z.object({
        kind: z.string().trim().min(1).max(80),
        id: z.number().int().positive(),
        action: z.enum(DECISION_ACTIONS),
        /** مفتاحُ تكرارٍ لكلّ نقرة — إعادةُ الإرسال بنفسه تعيد النتيجة نفسها حيث تدعم الخدمة الإعادة. */
        clientRequestId: z.string().trim().min(8).max(64),
        reason: z.string().trim().max(1000).optional(),
        expectedVersion: z.number().int().positive().nullish(),
        confirmations: z.record(z.string().max(60), z.boolean()).optional(),
        reference: z.string().trim().max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await decideDecision(
        { ...input, expectedVersion: input.expectedVersion ?? null },
        decisionActorFromUser(ctx.user),
        { audit: { user: ctx.user, req: ctx.req } },
      );
      await logAudit(ctx, {
        action: `decisions.${input.action.toLowerCase()}`,
        entityType: input.kind,
        entityId: input.id,
        newValue: { outcome: res.outcome, reason: input.reason?.slice(0, 200) ?? null, clientRequestId: input.clientRequestId },
      });
      return res;
    }),
});
