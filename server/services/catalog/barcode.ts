// إسناد/تحديث باركود وحدة مع ضمان التفرّد.
import { TRPCError } from "@trpc/server";
import { and, eq, ne } from "drizzle-orm";
import { productUnits } from "../../../drizzle/schema";
import { withTx } from "../tx";

/** يسند باركوداً لوحدة بلا باركود (أو يحدّثه)، مع ضمان التفرّد عبر كل الوحدات. */
export async function assignBarcode(productUnitId: number, barcode: string) {
  return withTx(async (tx) => {
    const code = barcode.trim();
    if (!code) throw new TRPCError({ code: "BAD_REQUEST", message: "الباركود فارغ" });
    const unit = (await tx.select().from(productUnits).where(eq(productUnits.id, productUnitId)).limit(1))[0];
    if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: "الوحدة غير موجودة" });
    // تفرّد الباركود.
    const clash = (
      await tx
        .select({ id: productUnits.id })
        .from(productUnits)
        .where(and(eq(productUnits.barcode, code), ne(productUnits.id, productUnitId)))
        .limit(1)
    )[0];
    if (clash) throw new TRPCError({ code: "CONFLICT", message: `الباركود ${code} مُستخدَم لوحدة أخرى` });
    await tx.update(productUnits).set({ barcode: code }).where(eq(productUnits.id, productUnitId));
    return { productUnitId, barcode: code };
  });
}
