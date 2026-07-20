/**
 * نواة كشف الأسماء المشابهة — مشتركة بين كاشف المنتجات (catalog.similarNames)
 * وكاشفَي العميل/المورّد (findSimilar): «ازدواج الكتالوج/الأطراف يُمسَك عند المصدر».
 *
 * المبدأ: مطابقة **أغلبية الكلمات** (⌊ن/٢⌋+١) على عمود `searchNorm` المولَّد بالتطبيع
 * العربي — مطابقة الكل تُفلت الازدواج الناقص كلمةً («باركر قلم ازرق» عن «قلم جاف أزرق باركر»)،
 * ومطابقة أيّ كلمة تُغرق بالضجيج («قلم»/«شركة» وحدها = مئات).
 *
 * ⚠️ أعمدة searchNorm (هجرات 0035/0039) تطوي الهمزات/التاء/الكشيدة لكنها **لا تطوي الأرقام**
 * العربية-الهندية، بينما tokenizeSearchQuery يحوّلها لاتينية ⇒ نطوي الأرقام وقت الاستعلام
 * فوق العمود. لا فهرس يُفقَد — المطابقة LIKE %..% مسح كامل أصلاً، والنداءات debounced بحدود صغيرة.
 */
import { sql, type SQL } from "drizzle-orm";
import { normalizeSearchText, tokenizeSearchQuery } from "../../shared/searchNormalize";
import { escLike } from "./sqlLike";

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** يطوي الأرقام العربية-الهندية والفارسية إلى لاتينية داخل تعبير SQL (سلسلة REPLACE). */
export function foldDigitsSql(expr: SQL): SQL {
  let out = expr;
  for (let i = 0; i < 10; i++) {
    out = sql`replace(${out}, ${ARABIC_DIGITS[i]}, ${String(i)})`;
    out = sql`replace(${out}, ${PERSIAN_DIGITS[i]}, ${String(i)})`;
  }
  return out;
}

export interface MajorityTokenMatch {
  /** شرط WHERE: عدد الكلمات المطابقة ≥ العتبة. */
  where: SQL;
  /** تعبير عدد الكلمات المطابقة (للترتيب). */
  matchCount: SQL;
  /** 1 عند التطابق التام في الفضاء المُطبَّع (تحذير أقوى من مجرد تشابه). */
  isExact: SQL<number>;
  /** ترتيب بالملاءمة: التام ثم الأكثر كلماتٍ ثم الأقرب لبداية الاسم. */
  orderBy: SQL[];
  tokens: string[];
  threshold: number;
}

/**
 * يبني مطابقة أغلبية الكلمات على عمود مُطبَّع. يعيد null لاسم فارغ/بلا كلمات.
 * `normCol` = عمود searchNorm خاماً (يُغلَّف بـcoalesce وطيّ الأرقام هنا).
 */
export function majorityTokenMatch(normCol: SQL, rawName: string): MajorityTokenMatch | null {
  const tokens = tokenizeSearchQuery(rawName); // ≤٥ كلمات مُطبَّعة
  if (!tokens.length) return null;
  const whole = normalizeSearchText(rawName);
  const norm = foldDigitsSql(sql`coalesce(${normCol}, '')`);

  const tokenHits = tokens.map(
    (t) => sql`(case when ${norm} LIKE ${`%${escLike(t)}%`} ESCAPE '!' then 1 else 0 end)`
  );
  const matchCount = sql`(${sql.join(tokenHits, sql` + `)})`;
  // أغلبية الكلمات: ن=١⇒١، ن=٢⇒٢، ن=٣⇒٢، ن=٤⇒٣، ن=٥⇒٣.
  const threshold = Math.floor(tokens.length / 2) + 1;
  const isExact = sql<number>`case when ${norm} = ${whole} then 1 else 0 end`;

  return {
    where: sql`${matchCount} >= ${threshold}`,
    matchCount,
    isExact,
    orderBy: [sql`${isExact} desc`, sql`${matchCount} desc`, sql`instr(${norm}, ${tokens[0]})`],
    tokens,
    threshold,
  };
}

/** مرآة JS لقاعدة الأغلبية نفسها — لتصنيف matchedOn بعد جلب الصفوف (تناسق مضمون مع SQL). */
export function majorityTokenHitJs(storedName: string | null | undefined, rawName: string): boolean {
  const tokens = tokenizeSearchQuery(rawName);
  if (!tokens.length) return false;
  const norm = normalizeSearchText(storedName ?? "");
  const hits = tokens.filter((t) => norm.includes(t)).length;
  return hits >= Math.floor(tokens.length / 2) + 1;
}

/** لاحقة أرقام قابلة للمطابقة من هاتف بأي صيغة كتابة (محلية 07xx أو دولية ‎+9647xx‎):
 *  أرقام فقط، وآخر ١٠ خانات — القاسم المشترك بين الصيغتين. أقل من ٧ أرقام = ضجيج، تُهمل. */
export function phoneMatchSuffix(s: string | null | undefined): string | null {
  const digits = (s ?? "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}
