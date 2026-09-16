/**
 * استعادة تكلفة من سجلّ الشذوذ، داخل معاملةٍ حاكمة واحدة.
 *
 * هذا المسار كان يكتب `productVariants.costPrice` مباشرةً من الراوتر، ثم يعلّم سجلّ
 * الشذوذ ويكتب التدقيق كلٌّ على حدة. بذلك كان منفذاً جانبياً يتجاوز حوكمة إعادة التقييم،
 * ويمكن لفشلٍ بين الخطوات أن يترك تكلفةً مستعادة بلا حالة/تدقيق مطابقين.
 */
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import {
  auditLogs,
  productVariants,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { postCostRevaluation } from "../costRevaluation";
import { money, toDbMoney } from "../money";
import { withTx, type Actor } from "../tx";

type RevertActor = Pick<Actor, "userId" | "role" | "isOwner"> & {
  branchId?: Actor["branchId"] | null;
  ipAddress?: string | null;
};

export const COST_CHANGE_REVERT_WINDOW_DAYS = 30;

type CostChangeLogRow = {
  id: number;
  variantId: number;
  changeKind: string;
  oldValue: string;
  newValue: string;
  reverted: number;
  createdAt: Date | string;
};

function rowsOf<T>(result: unknown): T[] {
  return (result as [T[], unknown])[0] ?? [];
}

async function lockChangeLog(tx: Tx, logId: number): Promise<CostChangeLogRow> {
  const result = await tx.execute(sql`
    SELECT id, variantId, changeKind, oldValue, newValue, reverted, createdAt
    FROM priceAnomalyLog
    WHERE id = ${logId}
    FOR UPDATE
  `);
  const row = rowsOf<CostChangeLogRow>(result)[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "سجلّ الأثر غير موجود" });
  }
  if (row.reverted) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "هذا التغيير مُعادٌ مسبقاً" });
  }
  const ageMs = Date.now() - new Date(row.createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > COST_CHANGE_REVERT_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "انقضت مهلة الاستعادة (٣٠ يوماً)",
    });
  }
  if (row.changeKind !== "cost") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الاستعادة تدعم حالياً تكلفة فقط",
    });
  }
  return row;
}

/**
 * يستعيد التكلفة السابقة من أثرٍ غير قابل للتعديل. إن وُجد مخزون مملوك، يرحّل
 * `postCostRevaluation` فرق القيمة لكل فرع عبر `postEntry` وحارس الفترة؛ وتبقى الاستعادة
 * والتدقيق وحالة الشذوذ والقيود في المعاملة نفسها.
 */
export async function revertCatalogCostChange(
  logId: number,
  actor: RevertActor,
): Promise<{ ok: true }> {
  return withTx(async (tx) => {
    const row = await lockChangeLog(tx, logId);
    const loggedNewCost = money(row.newValue);
    const restoredCost = money(row.oldValue);
    const reason = `استعادة سجل شذوذ التكلفة #${logId}`;
    // الحارس يقفل productVariants ثم branchStock، ويتحقق أن التكلفة المسجلة ما زالت حيّة؛
    // لذلك لا نعكس ترتيب أقفال WAVG ولا نطمس استلاماً أحدث.
    await postCostRevaluation(
      tx,
      row.variantId,
      loggedNewCost,
      restoredCost,
      actor,
      reason,
      { kind: "CATALOG_ANOMALY_REVERT", anomalyLogId: logId },
    );

    await tx
      .update(productVariants)
      .set({ costPrice: toDbMoney(restoredCost) })
      .where(eq(productVariants.id, row.variantId));
    await tx.execute(sql`
      UPDATE priceAnomalyLog
      SET reverted = TRUE, revertedAt = NOW()
      WHERE id = ${logId}
    `);
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId ?? null,
      action: "catalogAnomaly.revertCostChange",
      entityType: "productVariant",
      entityId: String(row.variantId),
      oldValue: { costPrice: loggedNewCost.toFixed(2) },
      newValue: {
        costPrice: restoredCost.toFixed(2),
        revertedLogId: logId,
        reason,
      },
      ipAddress: actor.ipAddress ?? null,
    });

    return { ok: true };
  });
}
