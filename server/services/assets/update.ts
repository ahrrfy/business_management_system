// تعديل بيانات أصل قائم (لا يشمل العهدة/الحالة/الاستبعاد — لها مساراتها).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { fixedAssets } from "../../../drizzle/schema";
import { money, toDbMoney } from "../money";
import { withTx } from "../tx";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";

/** تعديل بيانات أصل قائم (لا يشمل العهدة/الحالة/الاستبعاد — لها مساراتها). */
export interface UpdateAssetInput {
  name: string;
  category: string;
  brand?: string | null;
  serial?: string | null;
  branchId?: number | null;
  location?: string | null;
  supplierId?: number | null;
  purchaseDate: string;
  purchaseValue: string;
  salvageValue?: string;
  usefulLifeYears: number;
  depreciationMethod?: "sl" | "db";
  condition?: string | null;
  warrantyEnd?: string | null;
}

export async function updateAsset(id: number, input: UpdateAssetInput) {
  if (!(input.usefulLifeYears > 0)) throw new Error("العمر الإنتاجي يجب أن يكون أكبر من صفر");
  await withTx(async (tx) => {
    const a = await loadForUpdate(tx, id);
    if (a.status === "disposed") throw new Error("لا يمكن تعديل أصل مُستبعَد");

    // ASSET-EDIT (تدقيق ٢/٧): قيمة الشراء والمورّد مُرحَّلان محاسبياً عند الإنشاء (قيد PURCHASE +AP
    // أو PAYMENT_OUT، بمفتاح ASSET_ACQ:<id>) ويُغذّيان حساب الإهلاك. كان تعديلهما هنا يُعيد الكتابة
    // بلا قيدٍ تعويضي ولا تعديلٍ لرصيد المورد ⇒ (١) إهلاك يُحسب على قيمة لم تُرسمَل في الدفتر؛
    // (٢) الدين وقيد PURCHASE يبقيان على المورّد القديم عند تبديل المورّد. لا نسمح بتغييرهما عبر
    // شاشة التعديل — التصحيح الصحيح يكون باستبعاد الأصل وإعادة اقتنائه (مسارٌ يكتب القيود التعويضية).
    if (!money(a.purchaseValue ?? "0").eq(money(input.purchaseValue))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن تعديل قيمة شراء الأصل بعد اقتنائه (مُرحَّلة محاسبياً) — استبعِد الأصل وأعِد اقتناءه للتصحيح.",
      });
    }
    if ((a.supplierId ?? null) !== (input.supplierId ?? null)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن تغيير مورّد الأصل بعد اقتنائه (الدين مُقيَّد على المورّد الأصلي) — استبعِد الأصل وأعِد اقتناءه.",
      });
    }
    await tx
      .update(fixedAssets)
      .set({
        name: input.name,
        category: input.category as never,
        brand: input.brand ?? null,
        serial: input.serial ?? null,
        branchId: input.branchId ?? null,
        location: input.location ?? null,
        supplierId: input.supplierId ?? null,
        purchaseDate: input.purchaseDate,
        purchaseValue: toDbMoney(input.purchaseValue),
        salvageValue: toDbMoney(input.salvageValue ?? "0"),
        usefulLifeYears: input.usefulLifeYears,
        depreciationMethod: input.depreciationMethod ?? "sl",
        condition: input.condition ?? null,
        warrantyEnd: input.warrantyEnd ?? null,
      })
      .where(eq(fixedAssets.id, id));
  });
  return getAsset(id);
}
