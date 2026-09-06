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
  if (!source) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذر تنفيذ عملية المالك مباشرة",
        why: `نوع القرار ${options.kind} غير موصول بصندوق القرارات`,
        doThis: "أبلغ الدعم الفني باسم العملية قبل إعادة إرسالها",
      }),
    });
  }
  const freshness = await source.freshness(options.id);
  // يعيد المستدعي حالته المخزنة عند replay؛ لا نزعم أنه اعتمد طلباً سبق حسمه بالرفض.
  if (freshness === "DECIDED") return false;
  if (freshness === "GONE") {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذر إكمال عملية المالك",
        why: "سجل الطلب لم يعد موجودا",
        doThis: "حدّث الشاشة وتحقق من سجل العملية قبل إنشائها من جديد",
      }),
    });
  }
  const row = (
    await source.list(decisionActor, { branchIds: null, now: new Date() })
  ).find((candidate) => candidate.kind === options.kind && candidate.id === options.id);
  if (!row) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر إكمال عملية المالك",
        why: `الطلب ${options.kind} #${options.id} غير ظاهر ضمن الطلبات القابلة للتنفيذ`,
        doThis: "حدّث الشاشة وتحقق من صلاحية بيانات العملية وحالتها",
      }),
    });
  }
  if (!row.allowedActions.includes("APPROVE") || row.approveBlockedReason) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: row.approveBlockedReason ?? appErrorMessage({
        what: "تعذر تنفيذ عملية المالك مباشرة",
        why: "الطلب لا يوفّر إجراء اعتماد صالحا في حالته الحالية",
        doThis: "حدّث الشاشة وعالج سبب منع التنفيذ الظاهر في تفاصيل الطلب",
      }),
    });
  }
  const variant = options.variant ?? (row.approveVariants.length === 1 ? row.approveVariants[0]!.key : null);
  if (row.approveVariants.length > 1 && !variant) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذر تنفيذ عملية المالك مباشرة",
        why: "العملية لها أكثر من صيغة تنفيذ ولا تحتوي على اختيار صريح",
        doThis: "اختر صيغة التنفيذ المطلوبة ثم أعد حفظ العملية",
      }),
    });
  }
  const reference = options.reference?.trim() || null;
  if (row.requiredReference && !reference) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذر تنفيذ عملية المالك مباشرة",
        why: `${row.requiredReference.label} غير مدخل وهو مطلوب لإتمام العملية`,
        doThis: `أدخل ${row.requiredReference.label} ثم أعد حفظ العملية`,
      }),
    });
  }
  const result = await decideDecision(
    {
      kind: options.kind,
      id: options.id,
      action: "APPROVE",
      clientRequestId: `owner-auto-${randomUUID()}`,
      reason: options.reason?.trim() || "اعتماد تلقائي: منفذ العملية هو المالك",
      expectedVersion: row.expectedVersion,
      confirmations: Object.fromEntries(row.confirmations.map((item) => [item.key, true])),
      reference,
      variant,
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
