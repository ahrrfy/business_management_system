import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { activateSupplier, createSupplier, deactivateSupplier, getSupplier, listSuppliers, updateSupplier } from "../supplierService";

const actor = { userId: 1, branchId: 1 };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["purchaseOrders", "suppliers"]) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
beforeEach(reset);

describe("الموردون CRUD", () => {
  it("إنشاء + قراءة + قائمة", async () => {
    const { supplierId } = await createSupplier({ name: "مكتبة الرشيد", phone: "0770", city: "بغداد" }, actor);
    const got = await getSupplier(supplierId);
    expect(got?.name).toBe("مكتبة الرشيد");
    const { rows, total } = await listSuppliers({});
    expect(total).toBe(1);
    expect(rows[0].city).toBe("بغداد");
  });

  it("اسم فارغ يُرفض", async () => {
    await expect(createSupplier({ name: "  " }, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("تكرار الهاتف يُرفض", async () => {
    await createSupplier({ name: "أ", phone: "0771" }, actor);
    await expect(createSupplier({ name: "ب", phone: "0771" }, actor)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("تعديل يحفظ الحقول", async () => {
    const { supplierId } = await createSupplier({ name: "أ" }, actor);
    await updateSupplier({ supplierId, paymentTerms: "آجل ٣٠ يوم", city: "البصرة" }, actor);
    const got = await getSupplier(supplierId);
    expect(got?.paymentTerms).toBe("آجل ٣٠ يوم");
    expect(got?.city).toBe("البصرة");
  });

  it("تعطيل ثم تفعيل (بلا رصيد)", async () => {
    const { supplierId } = await createSupplier({ name: "أ" }, actor);
    await deactivateSupplier(supplierId, actor);
    expect((await getSupplier(supplierId))?.isActive).toBeFalsy();
    await activateSupplier(supplierId, actor);
    expect((await getSupplier(supplierId))?.isActive).toBeTruthy();
  });

  it("تعطيل مورّد عليه رصيد يُرفض", async () => {
    const { supplierId } = await createSupplier({ name: "أ" }, actor);
    await db().update(s.suppliers).set({ currentBalance: "300.00" }).where(sql`id = ${supplierId}`);
    await expect(deactivateSupplier(supplierId, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("البحث يستثني المعطّلين افتراضياً", async () => {
    const { supplierId } = await createSupplier({ name: "معطّل" }, actor);
    await deactivateSupplier(supplierId, actor);
    expect((await listSuppliers({})).total).toBe(0);
    expect((await listSuppliers({ includeInactive: true })).total).toBe(1);
  });

  it("D2 (١/٧): البحث بالاسم يتجاوز الهمزات/التاء المربوطة عبر searchNorm", async () => {
    await createSupplier({ name: "شركة الأمانة للتجارة" }, actor);
    await createSupplier({ name: "مكتبة الرشيد" }, actor);
    const noHamza = await listSuppliers({ q: "الامانه" });
    expect(noHamza.total).toBe(1);
    expect(noHamza.rows[0].name).toBe("شركة الأمانة للتجارة");
  });

  it("T3.2 (إصلاح إلزامي): بحث محلي «0770…» يجد مورداً مخزَّناً E.164 «+9647702…» — انحدار بحث الهاتف", async () => {
    // ⚠️ الاسم بلا شدّة عمداً (بذور الاختبار تُكتب بلا شدّات — searchNorm المولَّد لا يطوي
    // التشكيل، فشدّة في نص الاستعلام JS-normalized تُسقَط بينما تبقى في العمود المخزَّن).
    await createSupplier({ name: "مورد الهاتف", phone: "07702123456" }, actor);
    await createSupplier({ name: "آخر", phone: "07709999999" }, actor);
    const byLocal = await listSuppliers({ q: "07702123456" });
    expect(byLocal.rows).toHaveLength(1);
    expect(byLocal.rows[0].name).toBe("مورد الهاتف");
    const byIntlPartial = await listSuppliers({ q: "+9647702" });
    expect(byIntlPartial.rows).toHaveLength(1);
    expect(byIntlPartial.rows[0].name).toBe("مورد الهاتف");
    const byName = await listSuppliers({ q: "مورد الهاتف" });
    expect(byName.rows).toHaveLength(1);
  });
});
