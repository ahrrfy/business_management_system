// إسناد/تحديث باركود وحدة مع ضمان التفرّد بين الأساسيّ والبديل معاً.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { productUnits } from "../../../drizzle/schema";
import { withTx } from "../tx";
import { findBarcodeClashes } from "./barcodeAliases";

/** يسند باركوداً لوحدة بلا باركود (أو يحدّثه)، مع ضمان التفرّد عبر كل الوحدات — أساسيّاً وبديلاً. */
export async function assignBarcode(productUnitId: number, barcode: string) {
  return withTx(async (tx) => {
    const code = barcode.trim();
    if (!code) throw new TRPCError({ code: "BAD_REQUEST", message: "الباركود فارغ" });
    const unit = (await tx.select().from(productUnits).where(eq(productUnits.id, productUnitId)).limit(1))[0];
    if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: "الوحدة غير موجودة" });
    // تفرّد الباركود: أساسيّ (يتجاهل نفس الوحدة) + بديل (لا استثناء — يمنع باركود أساسيّ يطابق بديلاً لسلعة أخرى).
    const clashes = await findBarcodeClashes(tx, [code], { ignorePrimaryUnitIds: [productUnitId] });
    if (clashes[0]) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `الباركود ${code} مُستخدَم في «${clashes[0].takenBy}» — غيّره أو احذفه من هناك أوّلاً.`,
      });
    }
    await tx.update(productUnits).set({ barcode: code }).where(eq(productUnits.id, productUnitId));
    return { productUnitId, barcode: code };
  });
}
