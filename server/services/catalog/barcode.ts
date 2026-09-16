// إسناد/تحديث باركود وحدة مع ضمان التفرّد بين الأساسيّ والبديل معاً.
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { canonicalizeBarcodeInput, canonicalizeBarcodeForStorage } from "@shared/barcodeNormalize";
import { productUnits } from "../../../drizzle/schema";
import { withTx } from "../tx";
import { findBarcodeClashes, assertNoActiveStocktakeForVariant } from "./barcodeAliases";

/** يسند باركوداً لوحدة بلا باركود (أو يحدّثه)، مع ضمان التفرّد عبر كل الوحدات — أساسيّاً وبديلاً. */
export async function assignBarcode(productUnitId: number, barcode: string) {
  return withTx(async (tx) => {
    const code = canonicalizeBarcodeInput(barcode); // الهوية (فحص التفرّد + رسائل الخطأ)
    if (!code) throw new TRPCError({ code: "BAD_REQUEST", message: "الباركود فارغ" });
    const stored = canonicalizeBarcodeForStorage(barcode); // المخزَّن حرفيّاً بصيغة المصنع (يُبقي المسافة الداخلية)
    const unit = (await tx.select().from(productUnits).where(eq(productUnits.id, productUnitId)).limit(1))[0];
    if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: "الوحدة غير موجودة" });

    // تجميد الباركود الأساسي أثناء الجرد النشط (Codex finding):
    // يمنع استبدال باركود الوحدة إذا كان الصنف مشمولاً في جلسة جرد نشطة تجنباً لرفض عدّات العاملين.
    // نقارن **هويّةً بهويّة** (المخزَّن قد يحمل الآن مسافةً داخلية): تغييرُ الصيغة العرضيّة وحدها بلا تغيّرِ
    // الهوية لا يوقظ الحارس — والهوية هي ما يراه الماسح والعدّاد.
    if (canonicalizeBarcodeInput(unit.barcode ?? "") !== code && unit.variantId) {
      await assertNoActiveStocktakeForVariant(tx, unit.variantId, "تعديل باركود الوحدة الأساسي");
    }

    // تفرّد الباركود: أساسيّ (يتجاهل نفس الوحدة) + بديل (لا استثناء — يمنع باركود أساسيّ يطابق بديلاً لسلعة أخرى).
    const clashes = await findBarcodeClashes(tx, [code], { ignorePrimaryUnitIds: [productUnitId] });
    if (clashes[0]) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `الباركود ${code} مُستخدَم في «${clashes[0].takenBy}» — غيّره أو احذفه من هناك أوّلاً.`,
      });
    }
    await tx.update(productUnits).set({ barcode: stored }).where(eq(productUnits.id, productUnitId));
    return { productUnitId, barcode: stored };
  });
}
