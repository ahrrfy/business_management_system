// خدمة إعدادات الضريبة — صفّ singleton واحد (id=1) يضبط الافتراضي الذي تُهيَّأ منه فاتورة
// جديدة (تفعيل الضريبة + نسبتها) + الرقم الضريبي للشركة (يُطبَع على الفاتورة). العراق VAT=0%
// افتراضياً (§١ من CLAUDE.md) — enabledByDefault يبقى false ما لم يُفعِّله المدير صراحةً.
//
// get-or-create كسول: القراءة الأولى تُنشئ الصفّ إن غاب (upsert بسيط بلا حاجة لـwithTx —
// عملية صفّ واحد بمفتاح ثابت id=1، لا قيد أعمال متعدّد الجداول يحتاج ذرّية معاملة).
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { taxSettings } from "../../drizzle/schema";
import { requireDb, withTx } from "./tx";
import { money } from "./money";

export interface TaxSettingsView {
  id: number;
  enabledByDefault: boolean;
  defaultTaxRatePercent: string;
  taxRegistrationNumber: string | null;
  updatedBy: number | null;
  updatedAt: string;
}

function toView(row: typeof taxSettings.$inferSelect): TaxSettingsView {
  return {
    id: row.id,
    enabledByDefault: row.enabledByDefault,
    defaultTaxRatePercent: row.defaultTaxRatePercent,
    taxRegistrationNumber: row.taxRegistrationNumber ?? null,
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** يقرأ صفّ إعدادات الضريبة (id=1)، وينشئه بالقيم الافتراضية إن لم يكن موجوداً بعد. */
export async function getTaxSettings(): Promise<TaxSettingsView> {
  const db = requireDb();
  const existing = await db.select().from(taxSettings).where(eq(taxSettings.id, 1)).limit(1);
  if (existing[0]) return toView(existing[0]);

  // إنشاء كسول بالقيم الافتراضية — onDuplicateKeyUpdate يمتصّ سباق القراءة المتزامنة الأولى
  // (لا حاجة لـwithTx: صفّ واحد بمفتاح ثابت، لا قيد أعمال متعدّد الجداول).
  await db
    .insert(taxSettings)
    .values({ id: 1, enabledByDefault: false, defaultTaxRatePercent: "0.00", taxRegistrationNumber: null })
    .onDuplicateKeyUpdate({ set: { id: 1 } });

  const created = await db.select().from(taxSettings).where(eq(taxSettings.id, 1)).limit(1);
  if (!created[0]) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إنشاء إعدادات الضريبة." });
  }
  return toView(created[0]);
}

export interface UpdateTaxSettingsInput {
  enabledByDefault: boolean;
  defaultTaxRatePercent: string;
  taxRegistrationNumber?: string | null;
}

/** يحدّث صفّ إعدادات الضريبة (id=1) — ينشئه أولاً إن غاب. النسبة يجب أن تقع ضمن [0,100]. */
export async function updateTaxSettings(
  input: UpdateTaxSettingsInput,
  actor: { userId: number },
): Promise<TaxSettingsView> {
  const rate = money(input.defaultTaxRatePercent ?? "0");
  if (rate.isNegative() || rate.gt(100)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "نسبة الضريبة يجب أن تكون بين 0 و100." });
  }
  const taxRegistrationNumber = input.taxRegistrationNumber?.trim() || null;

  return withTx(async (tx) => {
    // اضمن وجود الصفّ أولاً (get-or-create كسول) ثم حدّثه — يعمل حتى لو لم تُقرأ الإعدادات من قبل.
    await tx
      .insert(taxSettings)
      .values({ id: 1, enabledByDefault: false, defaultTaxRatePercent: "0.00", taxRegistrationNumber: null })
      .onDuplicateKeyUpdate({ set: { id: 1 } });

    await tx
      .update(taxSettings)
      .set({
        enabledByDefault: input.enabledByDefault,
        // decimal(5,2): نسبة ٠-١٠٠ بدقّتين عشريّتين — round2/toFixed(2) كافٍ (لا حاجة toDbMoney
        // المصمَّم لـdecimal(15,2) المالي؛ نفس سياسة التقريب HALF_UP عبر money.ts).
        defaultTaxRatePercent: rate.toFixed(2),
        taxRegistrationNumber,
        updatedBy: actor.userId,
      })
      .where(eq(taxSettings.id, 1));

    const rows = await tx.select().from(taxSettings).where(eq(taxSettings.id, 1)).limit(1);
    if (!rows[0]) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تحديث إعدادات الضريبة." });
    }
    return toView(rows[0]);
  });
}
