import { and, eq } from "drizzle-orm";
import {
  deliveryParties,
  deliveryPartyMembers,
  users,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { fulfillmentError } from "../fulfillment/core";

/** Actual party choice is enough for an unlinked external carrier; staff drivers are always explicit, active and in branch. */
export async function validateDeliveryDriverTx(
  tx: Tx,
  input: { partyId: number; assignedUserId?: number | null },
  branchId: number,
) {
  const [party] = await tx
    .select()
    .from(deliveryParties)
    .where(eq(deliveryParties.id, input.partyId))
    .for("update")
    .limit(1);
  if (
    !party?.isActive ||
    (party.branchId != null && party.branchId !== branchId)
  )
    throw fulfillmentError("اختر جهة توصيل نشطة ضمن الفرع");
  const drivers = await tx
    .select({ userId: deliveryPartyMembers.userId })
    .from(deliveryPartyMembers)
    .where(
      and(
        eq(deliveryPartyMembers.partyId, party.id),
        eq(deliveryPartyMembers.memberRole, "DRIVER"),
        eq(deliveryPartyMembers.isActive, true),
      ),
    )
    .for("share");
  if (party.userId != null) {
    const [linked] = await tx
      .select({
        active: users.isActive,
        branchId: users.branchId,
        expiresAt: users.accessExpiresAt,
      })
      .from(users)
      .where(eq(users.id, party.userId))
      .for("share")
      .limit(1);
    if (
      !linked?.active ||
      (linked.expiresAt != null && linked.expiresAt.getTime() <= Date.now()) ||
      linked.branchId !== branchId
    )
      throw fulfillmentError(
        "الحساب المرتبط بجهة التوصيل غير نشط أو خارج الفرع؛ عالجه قبل الإسناد",
      );
  }
  if (
    party.partyType === "INDIVIDUAL" &&
    (party.userId != null || drivers.length > 0) &&
    input.assignedUserId == null
  )
    throw fulfillmentError("اختر المندوب الموظف صراحةً قبل تأكيد الإرسال");
  if (input.assignedUserId != null) {
    const [membership] = await tx
      .select({
        role: deliveryPartyMembers.memberRole,
        active: deliveryPartyMembers.isActive,
      })
      .from(deliveryPartyMembers)
      .where(
        and(
          eq(deliveryPartyMembers.partyId, party.id),
          eq(deliveryPartyMembers.userId, input.assignedUserId),
        ),
      )
      .for("share")
      .limit(1);
    if (
      (membership && (!membership.active || membership.role !== "DRIVER")) ||
      (!membership && input.assignedUserId !== party.userId)
    )
      throw fulfillmentError("المندوب المختار ليس عضواً نشطاً في جهة التوصيل");
  }
  if (input.assignedUserId != null) {
    const [selected] = await tx
      .select({
        active: users.isActive,
        branchId: users.branchId,
        expiresAt: users.accessExpiresAt,
      })
      .from(users)
      .where(eq(users.id, input.assignedUserId))
      .for("share")
      .limit(1);
    if (
      !selected?.active ||
      (selected.expiresAt != null &&
        selected.expiresAt.getTime() <= Date.now()) ||
      selected.branchId !== branchId
    )
      throw fulfillmentError("المندوب الموظف المختار غير نشط أو خارج الفرع");
  }
  return party;
}
