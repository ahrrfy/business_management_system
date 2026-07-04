// دلالات الرصيد الافتتاحي المشتركة بين العملاء والموردين (§٥.٢) + مفتاح التكرار داخل الدفعة.
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { postOpeningEntry as postOpeningEntryShared } from "../openingBalance";
import type { ImportOptions } from "./types";
import { norm } from "./helpers";

type PartyBalanceFields = { openingBalance?: string; currency?: "IQD" | "USD" };

/** فحص دلالات الرصيد الحسّاسة: رصيد ≠ 0 بلا عملة لا يُفسَّر، وUSD بلا سعر صرف لا يُحوَّل. يعيد رسالة الفشل أو null. */
function balanceValidationError(r: PartyBalanceFields, options: ImportOptions): string | null {
  if (r.openingBalance === undefined || money(r.openingBalance).isZero()) return null;
  if (!r.currency) return "حدّد العملة — رصيد بلا عملة لا يُفسَّر";
  if (r.currency === "USD" && !options.usdRate) return "حدّد سعر صرف الدولار في خيارات الاستيراد";
  return null;
}

/** قيمة التخزين الموقَّعة: round2(الرصيد × سعر الصرف إن USD) ثم عكس الإشارة إن طُلب — كله decimal.js (§٥.٢). */
function storedOpeningBalance(r: PartyBalanceFields, options: ImportOptions): string {
  if (r.openingBalance === undefined) return "0.00";
  let d = money(r.openingBalance);
  if (d.isZero()) return "0.00";
  if (r.currency === "USD") d = d.times(money(options.usdRate));
  d = round2(d);
  if ((options.balanceSign ?? "asIs") === "invert") d = d.negated();
  return toDbMoney(d);
}

/** قيد دفتر مرجعي يرسّخ الرصيد الافتتاحي المستورد (قرار التحكيم §٩):
 *  بدونه يَعُدّ reconcile كل مستورد برصيدٍ «انحرافاً» زائفاً دائماً من يوم الاستيراد.
 *  يفوّض للآلية المشتركة (server/services/openingBalance.ts) بملاحظة الاستيراد —
 *  نفس القيد/المفتاح الذي يستعمله الإدخال اليدوي (مصدر حقيقة واحد). */
async function postOpeningEntry(
  tx: Tx,
  party: "CUSTOMER" | "SUPPLIER",
  partyId: number,
  amount: string,
): Promise<void> {
  await postOpeningEntryShared(tx, party, partyId, amount, "رصيد افتتاحي (استيراد من النظام القديم)");
}

// مفتاح التكرار داخل الدفعة (§٥.٢/§٤.٣.٤-ب): legacyCode إن وُجد ← (الهاتف+الاسم) ← الاسم.
// الهاتف وحده ليس مفتاحاً: الملفات الفعلية فيها هواتف مشتركة مشروعة (عائلة/محل واحد)،
// ورمي أصحابها «مكرّراً» يُفشل الملف كله أو يُسقط أرصدتهم بصمت.
// توحيد حالة الأحرف (legacy/الاسم) يطابق فحص العميل (duplicateKeyOf) وقيد UNIQUE في MySQL
// (ترتيب utf8mb4 غير حسّاس للحالة): «A1» و«a1» سيصطدمان في القاعدة فليُكشفا هنا أولاً.
function dupKeyOf(r: { legacyCode?: string; phone?: string; name: string }): string {
  const lc = norm(r.legacyCode)?.toLowerCase();
  if (lc) return `l:${lc}`;
  const nameKey = r.name.trim().toLowerCase();
  const phone = norm(r.phone);
  return phone ? `pn:${phone}|${nameKey}` : `n:${nameKey}`;
}

function dupMessage(r: { legacyCode?: string }): string {
  const lc = norm(r.legacyCode);
  return lc ? `مكرّر داخل الملف (الرقم القديم «${lc}» مزدوج)` : "مكرّر داخل الملف";
}

const LEGACY_DEALT_PREFIX = "آخر تعامل (النظام القديم):";

/** دمج آمن لسطر «آخر تعامل» مع الملاحظات: يزيل السطر القديم إن وُجد ثم يُلحق الجديد (لا تراكم عند إعادة الاستيراد). */
function mergeLastDealt(base: string | null, lastDealtAt: string): string {
  const kept = (base ?? "")
    .split("\n")
    .filter((line) => !line.trim().startsWith(LEGACY_DEALT_PREFIX))
    .join("\n")
    .trim();
  const line = `${LEGACY_DEALT_PREFIX} ${lastDealtAt}`;
  return kept ? `${kept}\n${line}` : line;
}


// تصدير داخلي للحزمة فقط (يستهلكه customers/suppliers) — لا يُعاد تصديره من البرميل importService.ts.
export { balanceValidationError, storedOpeningBalance, postOpeningEntry, dupKeyOf, dupMessage, mergeLastDealt };
