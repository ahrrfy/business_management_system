import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { users } from "../../../drizzle/schema";
import type { DecisionKind } from "@shared/decisionRegistry";
import { appErrorMessage } from "@shared/errors";
import { requireDb, type Actor } from "../tx";

export interface OwnerAutoDecisionOptions {
  kind: DecisionKind;
  id: number;
  reason?: string | null;
  reference?: string | null;
  variant?: string | null;
  expectedVersion?: number | null;
  confirmations?: Record<string, boolean>;
}

/**
 * يحسم طلب القرار فور إنشائه عندما يكون الفاعل مالكا نشطا.
 *
 * هذه هي الوصلة العامة بين خدمات الطلب وصندوق القرارات: لا نكرر منطق التنفيذ المالي
 * أو المخزني هنا، بل نستدعي المصدر نفسه الذي يستعمله زر «اعتماد». الموظف يعاد منه
 * `false` بلا أي تغيير، والمالك ينفذ مسار الاعتماد الأصلي كاملا مرة واحدة.
 */
export async function autoDecideForActiveOwner(
  actor: Actor,
  options: OwnerAutoDecisionOptions,
): Promise<boolean> {
  const [owner] = await requireDb()
    .select({
      id: users.id,
      branchId: users.branchId,
      isOwner: users.isOwner,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  if (!owner?.isActive || !owner.isOwner) return false;

  const decisionActor = {
    userId: Number(owner.id),
    branchId: owner.branchId == null ? null : Number(owner.branchId),
    // سلطة المالك عابرة للوحدات؛ صفة isOwner تحسم من القاعدة أعلاه ولا من حمولة API.
    role: "admin",
    isOwner: true,
    permissionsOverride: null,
    crossBranch: true,
  } as const;
  const { decideDecision, sourceForKind } = await import("../decisions");
  const source = sourceForKind(options.kind);
  // replay لطلب حُسم سلفا يعيد حالته ولا يحاول صناعة حسم ثانٍ.
  if (source && (await source.freshness(options.id)) === "DECIDED") return false;
  // لا نبحث في قائمة الصندوق: بعض المصادر تقصّها إلى 200 صف، فيختفي الطلب الجديد مع
  // وجود طابور قديم. الحسم يوجَّه مباشرة بالمعرّف إلى المصدر القانوني، وهو يعيد فحص
  // الطزاجة والبوابة وجميع شروط المجال تحت أقفاله الأصلية.
  const result = await decideDecision(
    {
      kind: options.kind,
      id: options.id,
      action: "APPROVE",
      clientRequestId: `owner-auto-${randomUUID()}`,
      reason: options.reason?.trim() || "اعتماد تلقائي: منفذ العملية هو المالك",
      expectedVersion: options.expectedVersion,
      confirmations: options.confirmations,
      reference: options.reference?.trim() || null,
      variant: options.variant,
    },
    decisionActor,
  );
  if (result.outcome !== "EXECUTED") {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "لم تكتمل عملية المالك مباشرة",
        why: `أعاد مسار القرار النتيجة ${result.outcome} بدلا من التنفيذ`,
        doThis: "حدّث الشاشة وتحقق من حالة الطلب قبل إعادة المحاولة",
      }),
    });
  }
  return true;
}
