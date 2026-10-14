import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import type { OperationUser } from "@shared/operationPermissions";
import { treasuryOperationAllowed } from "./treasuryOperationAccess";

/** Independent expense actions, preserving existing authority for untouched accounts. */
export function expenseOperationAccess(user: OperationUser | null | undefined) {
  // الإلغاء = expensesManagerProcedure(["manager"], "expenses", "FULL") — نُخفي الزرّ عمّن يرفضه
  // الخادم (كاشير/محاسب: إدخالٌ بلا إلغاء) بنفس دالة الخادم moduleAccessAllowed ⇒ لا تباعُد.
  const legacyCanManage =
    !!user?.role &&
    moduleAccessAllowed(
      user.role as RoleKey,
      (user.permissionsOverride ?? null) as PermissionMap | null,
      "expenses",
      "FULL",
      ["manager"],
    );
  const canCancel = treasuryOperationAllowed(
    user,
    "expenses.cancel",
    legacyCanManage,
  );
  const canExecuteManaged = treasuryOperationAllowed(
    user,
    "expenses.executeManaged",
    legacyCanManage,
  );
  const canCorrect = treasuryOperationAllowed(
    user,
    "expenses.requestAccrualCorrection",
    legacyCanManage,
  );
  return { canCancel, canExecuteManaged, canCorrect };
}
