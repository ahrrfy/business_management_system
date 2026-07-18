import { TRPCError } from "@trpc/server";

/**
 * تحقّق معامل التحويل (تدقيق ١٧/٧). §٥ يفرض أن يكون `baseQuantity = quantity × conversionFactor`
 * عدداً صحيحاً. القاعدة الموحّدة: كل معامل **عدد صحيح موجب**؛ وحدة الأساس معاملها **١ حصراً**، وغير
 * الأساس **أكبر من ١**. كان الحارس الوحيد واجهياً ⇒ نداء API مباشر بمعامل خاطئ (درزن بمعامل «١»
 * يبيع ١٢ ويخصم ١) كان يمرّ صامتاً ويكسر ثابت المخزون. يُستدعى في كل مسارات كتابة الوحدات.
 */
export function assertValidUnitFactors(
  units: Array<{ unitName?: string; conversionFactor: string; isBaseUnit?: boolean }>,
): void {
  for (const u of units) {
    const name = u.unitName?.trim() || "?";
    const f = (u.conversionFactor ?? "").trim();
    if (!/^[1-9]\d*$/.test(f)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `معامل التحويل للوحدة «${name}» يجب أن يكون عدداً صحيحاً موجباً`,
      });
    }
    if (u.isBaseUnit === true && f !== "1") {
      throw new TRPCError({ code: "BAD_REQUEST", message: `وحدة الأساس «${name}» يجب أن يكون معاملها ١` });
    }
    if (u.isBaseUnit !== true && f === "1") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الوحدة غير الأساس «${name}» يجب أن يكون معاملها أكبر من ١`,
      });
    }
  }
}
