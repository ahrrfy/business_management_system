/**
 * تقييمُ بوّابة المصدر بمفردات `server/trpc.ts` نفسها.
 *
 * ⛔ لا فحصَ صلاحيةٍ جديد هنا: `moduleAccessAllowed` هي الدالّة التي تنفّذها
 * `requireModuleGate` (بوّابة `moduleProcedure`)، و`hasModuleAccess` هي التي تنفّذها
 * `requireModule`؛ و`isOwner` هي صفةُ `ownerProcedure`؛ و`REPORTS_ADMIN` = admin بعد
 * `reports:FULL`. الصندوق يُعيد استعمال المفردات لا يخترع مفردةً رابعة.
 */
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { hasModuleAccess, moduleAccessAllowed } from "@shared/permissions";
import type { Actor } from "../tx";
import type { DecisionActor, DecisionGate } from "./types";

/** هل يعبر الفاعلُ بوّابةَ المصدر؟ مرآةٌ لما ستفعله بوّابةُ الإجراء الأصليّ لو استُدعي مباشرةً. */
export function gatePasses(gate: DecisionGate, actor: DecisionActor): boolean {
  switch (gate.type) {
    case "MODULE": {
      if (!moduleAccessAllowed(actor.role, actor.permissionsOverride, gate.moduleKey, "FULL", gate.roles)) {
        return false;
      }
      // `requireOwnBranch`: غيرُ العابر بلا فرعٍ مُسنَد يُرفَض.
      return actor.crossBranch || actor.branchId != null;
    }
    case "MODULE_MAP":
      return hasModuleAccess(actor.role, actor.permissionsOverride, gate.moduleKey, "FULL");
    case "OWNER":
      if (!actor.isOwner) return false;
      return gate.moduleKey ? hasModuleAccess(actor.role, actor.permissionsOverride, gate.moduleKey, "FULL") : true;
    case "REPORTS_ADMIN":
      return (
        actor.role === "admin" &&
        moduleAccessAllowed(actor.role, actor.permissionsOverride, "reports", "FULL", ["manager"])
      );
  }
}

export function assertGate(gate: DecisionGate, actor: DecisionActor, subject: string): void {
  if (gatePasses(gate, actor)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: appErrorMessage({
      what: `تعذّر حسم ${subject}`,
      why: "حسابك لا يحمل بوّابة الإجراء الأصليّ لهذا القرار (صلاحية الوحدة أو صفة المالك)",
      doThis: "اطلب من صاحب الصلاحية حسمه من صندوقه، أو من المالك منحك صلاحية الوحدة",
    }),
  });
}

/** يحوّل فاعلَ الصندوق إلى `Actor` الخدمات — الفرعُ الغائب يُمرَّر صفراً كما تفعل الراوترات. */
export function serviceActor(actor: DecisionActor): Actor & { isOwner: boolean; role: string } {
  return {
    userId: actor.userId,
    branchId: actor.branchId ?? 0,
    role: actor.role,
    isOwner: actor.isOwner,
  };
}
