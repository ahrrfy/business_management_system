// بحث المورّدين — كان **يسقط بخطأ نحويّ في SQL** من ١٧/٨ إلى ٢١/٨ بلا أن يمسكه اختبار:
// `ESCAPE '\\'` في القالب النصّي يُنتج `ESCAPE '\'` في SQL، وهو نصٌّ غير منتهٍ عند MySQL.
// لم يكن للمسار أيُّ اختبارٍ **يُشغّل** الاستعلام فعلاً ⇒ لا `tsc` يراه (نصٌّ داخل قالب)
// ولا مراجعةٌ بشرية. الحارس الوحيد الممكن هو تشغيله على قاعدةٍ حقيقية.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getSupplierSummary } from "../supplierOperationsService";

const TABLES = ["suppliers"];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db().insert(s.suppliers).values([
    { id: 1, name: "قرطاسية برهم", phone: "07701234567", currentBalance: "1600880.42", supplierKind: "REGULAR" },
    { id: 2, name: "مكتبة النور", phone: "07809876543", currentBalance: "-50000.00", supplierKind: "REGULAR" },
    { id: 3, name: "مودِع أمانة", currentBalance: "0.00", supplierKind: "CONSIGNOR" },
  ]);
});

describe("ملخّص المورّدين — البحث النصّي", () => {
  it("يُنفّذ استعلام البحث بلا خطأ نحويّ ويُصفّي فعلاً", async () => {
    // قبل الإصلاح كان هذا النداء يرمي: You have an error in your SQL syntax … near '\'
    const hit = await getSupplierSummary({ q: "برهم" });
    expect(hit.total).toBe(1);
    expect(hit.payableIqd).toBe("1600880.42");
    expect(hit.highestPayable?.supplierId).toBe(1);

    const miss = await getSupplierSummary({ q: "لا-وجود-له" });
    expect(miss.total).toBe(0);
    expect(miss.highestPayable).toBeNull();
  });

  it("يبحث بالهاتف وبآخر عشر خانات منه", async () => {
    expect((await getSupplierSummary({ q: "07809876543" })).total).toBe(1);
    expect((await getSupplierSummary({ q: "7809876543" })).total).toBe(1);
  });

  it("يُعامل `%` و`_` و`!` و`\\` كنصٍّ لا كحروف بدل", async () => {
    await db().update(s.suppliers).set({ name: "خصم 100% نهائي" }).where(eq(s.suppliers.id, 2));
    // الحجّة كلّها هنا: لو مرّت `%` خاماً لطابقت **الثلاثة**؛ وهي مُهرَّبة فتُطابق حاملها وحده.
    expect((await getSupplierSummary({ q: "%" })).total).toBe(1);
    expect((await getSupplierSummary({ q: "100%" })).total).toBe(1);
    // ولا مورّد يحمل هذه الحروف نصّاً ⇒ صفر (وليس «كل شيء» ولا خطأً نحوياً).
    expect((await getSupplierSummary({ q: "_" })).total).toBe(0);
    // `!` هو حرف الهروب نفسه ⇒ يجب أن يُهرَّب هو الآخر وإلّا انكسر الاستعلام.
    expect((await getSupplierSummary({ q: "!" })).total).toBe(0);
    expect((await getSupplierSummary({ q: "\\" })).total).toBe(0);
  });

  it("البحث بلا مصطلح يُرجع الجميع (لا شرط LIKE أصلاً)", async () => {
    const all = await getSupplierSummary({});
    expect(all.total).toBe(3);
    expect(all.regular).toBe(2);
    expect(all.consignors).toBe(1);
  });
});
