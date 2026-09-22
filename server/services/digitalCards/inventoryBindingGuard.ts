import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or } from "drizzle-orm";

import { digitalIntentInventoryReservations } from "../../../drizzle/schema";
import { appErrorMessage } from "../../../shared/errors";
import type { Tx } from "../../db";

/** يمنع تغيير معنى صنف تعتمد عليه نية ما زالت بين التحضير والحسم. */
export async function assertNoActiveDigitalInventoryBinding(
  tx: Tx,
  variantIds: readonly number[],
  context: string,
): Promise<void> {
  const ids = Array.from(new Set(variantIds.map(Number))).filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  if (!ids.length) return;
  const [active] = await tx
    .select({
      intentId: digitalIntentInventoryReservations.intentId,
      sourceVariantId: digitalIntentInventoryReservations.sourceVariantId,
      stockVariantId: digitalIntentInventoryReservations.stockVariantId,
    })
    .from(digitalIntentInventoryReservations)
    .where(
      and(
        eq(digitalIntentInventoryReservations.status, "ACTIVE"),
        or(
          inArray(digitalIntentInventoryReservations.sourceVariantId, ids),
          inArray(digitalIntentInventoryReservations.stockVariantId, ids),
        ),
      ),
    )
    .limit(1);
  if (active) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: `تعذّر ${context}`,
        why: `نية بيع رقم ${Number(active.intentId)} ما زالت تحجز معنى أو مخزون الصنف`,
        doThis:
          "أكمل النية الرقمية أو ألغها/عالجها أولاً، ثم أعد تعديل الكتالوج",
      }),
    });
  }
}
