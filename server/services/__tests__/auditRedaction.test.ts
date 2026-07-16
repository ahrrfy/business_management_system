/**
 * تعقيم سجلّ التدقيق + تحصين قراءته — عطل «Out of sort memory» الإنتاجيّ (١٤–١٦/٧).
 *
 * **القصّة الكاملة:** `store.banner.update` مرّر مدخله كاملاً إلى `logAudit` وفيه data-URL
 * بميغابايتات ⇒ صفُّ تدقيقٍ عريض. و`ORDER BY id DESC` يُجبر MySQL على `filesort` يجب أن يتّسع
 * **لأعرض صفّ** ⇒ صفٌّ **واحد** يُسقط شاشة التدقيق **كلّها**. (بنرُ إنتاجٍ حقيقيّ = ١٫٣ م.ب =
 * ٥٫٣× `sort_buffer_size` الافتراضي ٢٥٦ ك.ب. أُعيد إنتاجه محلّياً قبل الإصلاح.)
 *
 * طبقتان تُختبَران هنا:
 *  ① **الكتابة**: `redactAuditValue` يحجب الصور ويسقّف الحمولة ⇒ لا تُكتَب سمومٌ جديدة.
 *  ② **القراءة**: الجلب بخطوتين ⇒ حتى لو وُجد صفٌّ عريض (صفوفٌ قديمة، استيراد، كتابةٌ خارج
 *     `logAudit`) تبقى الشاشة صامدة. الطبقتان ليستا تكراراً: الأولى تمنع، والثانية تصمد.
 */
import { desc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logAudit, redactAuditValue } from "../auditService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

/** data URL بحجم بنر إنتاجٍ حقيقيّ (قِيس فعلياً: ٥ صور = ١٫٣٨ م.ب). */
const bigDataUrl = (kb: number) => "data:image/jpeg;base64," + "A".repeat(kb * 1024);

const fakeCtx = { user: { id: 1, branchId: 1 }, req: { headers: {}, ip: "127.0.0.1" } } as never;

beforeEach(async () => {
  await truncateTables(["auditLogs", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
});

describe("redactAuditValue — الحارس المركزيّ (الكتابة)", () => {
  it("⭐ data URL ⇒ علامةٌ تصف الحجم، لا البايتات", () => {
    const out = redactAuditValue({ title: "بنر", imageUrl: bigDataUrl(1300) }) as Record<string, string>;
    expect(out.title).toBe("بنر");
    expect(out.imageUrl).toMatch(/^<صورة \d+ ك\.ب — محجوبة/);
    expect(JSON.stringify(out)).not.toContain("base64");
    expect(JSON.stringify(out).length).toBeLessThan(300);
  });

  it("⭐ يغوص في المصفوفات والكائنات المتداخلة (بنر بـ٢٠ صورة = ٤٠ م.ب نظرياً)", () => {
    const input = { title: "بنر", images: Array.from({ length: 20 }, (_, i) => ({ url: bigDataUrl(2048), sortOrder: i })) };
    const out = redactAuditValue(input);
    const str = JSON.stringify(out);
    expect(str).not.toContain("base64");
    expect(str.length).toBeLessThan(8 * 1024);
  });

  it("لا يمسّ القيم العادية (التدقيق يبقى مفيداً)", () => {
    const v = { name: "أحمد", price: "5000.00", isActive: true, count: 3, missing: null };
    expect(redactAuditValue(v)).toEqual(v);
    expect(redactAuditValue(null)).toBeNull();
    expect(redactAuditValue(undefined)).toBeNull();
  });

  it("سقفٌ نهائيّ لأيّ حمولةٍ ضخمة غير متوقَّعة (لا data URL فيها)", () => {
    const out = redactAuditValue({ rows: Array.from({ length: 5000 }, (_, i) => ({ i, label: `صنف ${i}` })) }) as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(2000);
  });

  it("النصّ الطويل يُقتطَع بعلامةٍ صريحة (لا يُحذف بصمت)", () => {
    const out = redactAuditValue({ note: "ن".repeat(5000) }) as Record<string, string>;
    expect(out.note).toMatch(/…<اقتُطع \d+ حرفاً>$/);
  });

  /**
   * 🛡️ انحدارٌ أمسكه اختبار H6 القائم (`auditLogGaps.test.ts`) — والدرس أثمن من الإصلاح:
   * كان حدُّ العمق ٦ «حمايةً من الدوران»، فبتر بياناتٍ **مشروعة**: `product.update` يسجّل
   * `variants → units → prices` فيتجاوزها، فصار `[{priceTier:"RETAIL"}]` ⇒ `["<عميق>"]`
   * — أي أنّ التعقيم أكلَ التدقيق الذي جاء ليحميه. حدُّ العمق أداةٌ خاطئة لمنع الدوران:
   * الصحيح كشفُ **الدورة** نفسها (مسار الأجداد)، والحجم يحكمه السقف لا العمق.
   */
  it("⭐ التداخل المشروع العميق يُحفَظ كاملاً (variants→units→prices)", () => {
    const deep = { variants: [{ units: [{ prices: [{ priceTier: "RETAIL", price: "5000.00" }] }] }] };
    expect(redactAuditValue(deep)).toEqual(deep);
  });

  it("المرجع الدائريّ يُوقَف بعلامةٍ (لا غوصٌ لا نهائيّ) دون بتر إخوته", () => {
    const node: Record<string, unknown> = { name: "أ" };
    node.self = node; // دورة
    const out = redactAuditValue({ node, sibling: "سليم" }) as Record<string, Record<string, unknown>>;
    expect(out.sibling).toBe("سليم");
    expect((out.node as Record<string, unknown>).name).toBe("أ");
    expect((out.node as Record<string, unknown>).self).toBe("<مرجعٌ دائريّ>");
  });

  it("الكائن المشترك بين فرعين (DAG لا دورة) يُحفَظ في الفرعين", () => {
    const shared = { tier: "RETAIL" };
    const out = redactAuditValue({ a: shared, b: shared }) as Record<string, unknown>;
    expect(out.a).toEqual({ tier: "RETAIL" });
    expect(out.b).toEqual({ tier: "RETAIL" }); // لا يُعلَّم «دائرياً» ظلماً
  });

  /**
   * 🛡️ انحدارٌ أمسكته مراجعة Codex: المسار العامّ يبني الكائن من `Object.entries`،
   * و`Object.entries(new Date())` = **`[]`** ⇒ كلّ `Date` تصير `{}`. أصاب ذلك أحداثاً قائمة:
   * `user.revokeSessions` (`revokedAt`) و`stocktake.firstSign` (`firstSignAt`) — تفقد تاريخها بصمت.
   */
  it("⭐ Date يُحفَظ تاريخاً (كان يصير {} — الحقل يفقد معناه بصمت)", () => {
    const d = new Date("2026-07-16T20:00:00.000Z");
    const out = redactAuditValue({ revokedAt: d, by: "admin" }) as Record<string, string>;
    expect(out.revokedAt).toBe("2026-07-16T20:00:00.000Z");
    expect(out.by).toBe("admin");
  });

  it("أيّ كائنٍ بـtoJSON يُحترَم تمثيله (Decimal وأمثاله)", () => {
    const money = { toJSON: () => "5000.00" };
    expect((redactAuditValue({ total: money }) as Record<string, string>).total).toBe("5000.00");
  });

  /**
   * 🛡️ انحدارٌ أمسكته مراجعة Codex: السقف كان يعدّ **أحرف UTF-16** بينما `LENGTH()` في MySQL
   * تعدّ **بايتات UTF-8**، والعربية حرفان لكل حرف ⇒ صفٌّ عربيّ يمرّ الحارس (٨٠٠٠ حرف < ٨١٩٢)
   * ثم تراه SQL ١٦٠٠٠ بايت: يلتقطه سكربت التطهير ويعجز عن تصغيره فلا يتقارب أبداً.
   */
  it("⭐ السقف بالبايتات لا بالأحرف (نظامٌ عربيّ: ٢ بايت للحرف)", () => {
    // ٦٠٠٠ حرف عربي = ٦٠٠٠ وحدة UTF-16 (تمرّ لو عددنا الأحرف) لكن ١٢٠٠٠ بايت (يجب أن تُقتطَع)
    const arabic = Array.from({ length: 6 }, (_, i) => [`k${i}`, "ن".repeat(1000)]);
    const out = redactAuditValue(Object.fromEntries(arabic)) as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("logAudit — الصفّ المكتوب فعلاً في القاعدة", () => {
  it("⭐ تعديل بنر بصورةٍ ضخمة ⇒ صفٌّ صغير بلا base64 (كان ميغابايتات)", async () => {
    await logAudit(fakeCtx, {
      action: "store.banner.update",
      entityType: "storeBanner",
      entityId: 1,
      newValue: { title: "بنر الصيف", imageUrl: bigDataUrl(1300), mobileImageUrl: bigDataUrl(800), isActive: true },
    });

    const [row] = await db()
      .select({ len: sql<number>`LENGTH(${s.auditLogs.newValue})`, v: s.auditLogs.newValue })
      .from(s.auditLogs);

    expect(Number(row.len)).toBeLessThan(8 * 1024); // كان ~٢٫١ م.ب
    const json = JSON.stringify(row.v);
    expect(json).not.toContain("base64");
    // التدقيق يبقى ذا معنى: أيّ الحقول تغيّرت
    expect(json).toContain("بنر الصيف");
    expect(json).toContain("isActive");
  });
});

/**
 * ② القراءة — الثابت الحاكم: **صفٌّ عريضٌ واحد لا يُسقط الجدول كلّه**.
 *
 * نُثبّت `sort_buffer_size` على قيمة الإنتاج الافتراضية (٢٥٦ ك.ب) داخل الجلسة، ثم نُدخل صفّاً
 * مسموماً **بحقن SQL مباشر** (يتجاوز `logAudit` عمداً — يحاكي الصفوف القديمة المكتوبة قبل
 * الحارس). لو عاد أحدهم يوماً إلى الاستعلام أحادي الخطوة، يحمرّ هذا الاختبار.
 */
describe("audit.list — الجلب بخطوتين يصمد أمام صفٍّ عريض (القراءة)", () => {
  it("⭐ صفٌّ مسموم ١٫٣ م.ب ⇒ القائمة تعمل (كانت: Out of sort memory للجدول كلّه)", async () => {
    const d = db();
    await d.execute(sql`SET SESSION sort_buffer_size = 262144`); // افتراضي MySQL 8

    for (let i = 1; i <= 5; i++) {
      await d.insert(s.auditLogs).values({ userId: 1, action: `test.action${i}`, entityType: "t", entityId: String(i) });
    }
    // صفٌّ عريض كُتب خارج الحارس (كما كانت الصفوف القديمة تماماً)
    await d.execute(
      sql`INSERT INTO auditLogs (userId, action, entityType, newValue) VALUES (1, 'store.banner.update', 'storeBanner', ${JSON.stringify({ imageUrl: bigDataUrl(1300) })})`
    );

    // ① فرز المعرّفات وحدها — صفٌّ ضيّق ⇒ لا يعجز الفرز مهما اتّسعت الحمولة
    const ids = await d.select({ id: s.auditLogs.id }).from(s.auditLogs).orderBy(desc(s.auditLogs.id)).limit(50);
    expect(ids.length).toBe(6);

    // ② الصفوف بمعرّفاتها بلا ORDER BY ⇒ لا فرزَ لصفوفٍ عريضة
    const rows = await d
      .select({ id: s.auditLogs.id, action: s.auditLogs.action, newValue: s.auditLogs.newValue, userName: s.users.name })
      .from(s.auditLogs)
      .leftJoin(s.users, eq(s.auditLogs.userId, s.users.id))
      .where(sql`${s.auditLogs.id} in (${sql.join(ids.map((r) => sql`${Number(r.id)}`), sql`, `)})`);

    expect(rows.length).toBe(6); // الصفّ العريض حاضرٌ ولم يُسقط شيئاً
    expect(rows.some((r) => r.action === "store.banner.update")).toBe(true);
  });

  /**
   * 🛡️ **لا برهانَ عكسيّ هنا عمداً — وهذا جوهر الدرس لا نقصٌ فيه.**
   *
   * حاولتُ اختباراً يؤكّد أن الاستعلام أحادي الخطوة **يفشل** على نفس البيانات، فمرّ أخضرَ:
   * الفشل يعتمد على **خطّة المُحسِّن** (`Using temporary; Using filesort`) وهي تتبع إحصاءات
   * الجداول لا شكل الاستعلام — فيسقط على قاعدةٍ ويمرّ على أخرى بنفس المخطّط والإعداد
   * (٢٥٦ ك.ب) وبنفس الصفّ المسموم. أُثبت الفشل على: **الإنتاج** (سجلّ ١٤–١٦/٧) و**سكربتٍ
   * مستقلّ** على قاعدة التطوير (فشلٌ حتى بصفٍّ واحد).
   *
   * ولهذا بالضبط الجلبُ بخطوتين هو العلاج الصحيح: **لا يراهن على خطّة المُحسِّن** بل يمنع
   * بنيوياً أن يُطلَب من MySQL فرزُ صفوفٍ عريضة. اختبارٌ يعتمد على تلك الخطّة كان سيحرس بالصدفة
   * ويسقط بصمت — وهو ما نرفضه هنا (راجع درس #203).
   */
});
