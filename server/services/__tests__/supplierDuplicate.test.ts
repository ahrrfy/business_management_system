// dup-detect (٢٠/٧): كشف التكرار الحيّ للمورّدين findSimilarSuppliers — مرآة كاشف العميل
// على نواة similarMatch (أغلبية الكلمات على searchNorm + لاحقة هاتف + شمول المعطَّلين).
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { findSimilarSuppliers } from "../supplierService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await d.execute(sql.raw("TRUNCATE TABLE `suppliers`"));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

/** بذرة مباشرة (القراءة لا تحتاج مسار الإنشاء الكامل) — أسماء بفخاخ إملاء وهواتف دولية. */
async function seedSuppliers() {
  const d = db();
  await d.insert(s.suppliers).values([
    { id: 1, name: "شركة المعارف للأختام", phone: "+9647701112233", city: "بغداد", supplierCategory: "محلي" },
    { id: 2, name: "مطبعة الرشيد الحديثة", phone: "+9647809998877" },
    // بلا تشكيل: العمود المولَّد (0039) لا يجرّد الحركات — «مورّد» بالشدة لا يطابق «مورد».
    { id: 3, name: "مورد معطل قديم", isActive: false },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedSuppliers();
});

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

describe("findSimilarSuppliers (كشف التكرار الحيّ للمورّدين)", () => {
  it("الاسم يطابق مطبَّعاً عربياً: «شركه المعارف» تجد «شركة المعارف للأختام»", async () => {
    const rows = await findSimilarSuppliers({ name: "شركه المعارف" });
    expect(ids(rows)).toContain(1);
    expect(rows.find((r) => r.id === 1)?.matchedOn).toBe("name");
  });

  it("ترتيب كلمات مختلف يُمسَك بالأغلبية: «المعارف شركة» تجد المخزَّن", async () => {
    const rows = await findSimilarSuppliers({ name: "المعارف شركة" });
    expect(ids(rows)).toContain(1);
  });

  it("الهاتف بصيغة محلية 07xx يجد المخزَّن دولياً +9647xx (لاحقة)", async () => {
    const rows = await findSimilarSuppliers({ phones: ["0770 111 2233"] });
    expect(ids(rows)).toContain(1);
    expect(ids(rows)).not.toContain(2);
    expect(rows.find((r) => r.id === 1)?.matchedOn).toBe("phone");
  });

  it("تطابق الاسم والهاتف معاً ⇒ matchedOn=both", async () => {
    const rows = await findSimilarSuppliers({ name: "المعارف", phones: ["07701112233"] });
    expect(rows.find((r) => r.id === 1)?.matchedOn).toBe("both");
  });

  it("يشمل المورّدين المعطَّلين (موجود لكنه معطَّل = أهم تحذير)", async () => {
    const rows = await findSimilarSuppliers({ name: "مورد معطل" });
    const hit = rows.find((r) => r.id === 3);
    expect(hit).toBeTruthy();
    expect(hit?.isActive).toBe(false);
  });

  it("مدخل قصير/فارغ ⇒ لا استعلام ولا نتائج", async () => {
    expect(await findSimilarSuppliers({})).toEqual([]);
    expect(await findSimilarSuppliers({ name: "أ" })).toEqual([]);
    expect(await findSimilarSuppliers({ phones: ["077"] })).toEqual([]);
  });

  it("لا مطابقة زائفة لاسم/هاتف مختلفين", async () => {
    const rows = await findSimilarSuppliers({ name: "الوراقة الذهبية", phones: ["0751 000 0000"] });
    expect(rows).toEqual([]);
  });

  it("لا يُعيد أرصدة ولا حقولاً بنكية (أقلّ امتيازاً)", async () => {
    const rows = await findSimilarSuppliers({ name: "شركه المعارف" });
    const hit = rows.find((r) => r.id === 1) as Record<string, unknown> | undefined;
    expect(hit).toBeTruthy();
    expect(hit).not.toHaveProperty("currentBalance");
    expect(hit).not.toHaveProperty("iban");
  });
});
