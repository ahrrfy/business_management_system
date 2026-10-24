import { loadCurrentOperationalAuthorityTx } from "./authorization/currentOperationalAuthority";
import { assertOperationAuthorityTx } from "./authorization/operationAuthority";
import { moduleAccessAllowed } from "../../shared/permissions";
import { money, toDbMoney } from "./money";
import { fulfillmentError, assertFulfillmentBranch } from "./fulfillment/core";
import type { Tx } from "../db";
import type { Actor } from "./tx";
import type { CheckoutServiceCharge } from "../../shared/checkoutCharges";
export type CheckoutAuthorityPath =
  | "sales.create"
  | "printPos.createSale"
  | "workOrders.receptionCheckout"|"reception.draftCommit";
export function assertCheckoutAuthorityTx(
  tx: Tx,
  actor: Actor,
  path: CheckoutAuthorityPath,
) {
  const module =
    path === "sales.create"
      ? "sales"
      : path === "printPos.createSale"
        ? "pos"
        : "workorders";
  return assertOperationAuthorityTx(tx, actor, path, (current) =>
    moduleAccessAllowed(
      current.role ?? "",
      current.persistedPermissionsOverride,
      module,
      "FULL",
      ["cashier", "manager"],
    ),
  );
}

/** Checked once for the sum of all SERVICE lines in the locked business operation. */
export async function authorizeCheckoutServicesTx(
  tx: Tx,
  actor: Actor,
  branchId: number,
  services: CheckoutServiceCharge[],
  path: CheckoutAuthorityPath = "sales.create",
) {
  await assertCheckoutAuthorityTx(tx, actor, path);
  const authority = await loadCurrentOperationalAuthorityTx(tx, actor.userId);
  assertFulfillmentBranch(
    {
      ...actor,
      role: authority.role,
      isOwner: authority.isOwner,
      branchId: authority.branchId ?? actor.branchId,
    },
    branchId,
  );
  const total = services.reduce((sum, line) => {
    if (
      !line.description.trim() ||
      line.description.length > 2000 ||
      !/^\d{1,13}(\.\d{1,2})?$/.test(line.amount) ||
      !money(line.amount).gt(0)
    )
      throw fulfillmentError(
        "حدد بيان خدمة ومبلغاً موجباً بدقة الدينار المعتمدة",
      );
    return sum.plus(money(line.amount));
  }, money("0"));
  const cap = money(authority.caps.maxServiceChargeAmountIqd ?? "0");
  if (!cap.isFinite() || !cap.gt(0) || total.gt(cap))
    throw fulfillmentError(
      "مجموع أجور الخدمة يتجاوز سقف التنفيذ الحالي أو أن السقف غير مفعل؛ أنشئ طلب أجر لاعتماد مستقل",
      "FORBIDDEN",
    );
  return {
    actorUserId: actor.userId,
    role: authority.role,
    branchId,
    cap: toDbMoney(cap),
    operationAmount: toDbMoney(total),
    policy: "SERVICE_ZERO_EXTERNAL_COST_V1" as const,
    authorityPath:path,
  };
}
