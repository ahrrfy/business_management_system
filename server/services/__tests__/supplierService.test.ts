import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { activateSupplier, createSupplier, deactivateSupplier, getSupplier, listSuppliers, updateSupplier } from "../supplierService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1 };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  await truncateTables(["purchaseOrders", "suppliers"]);
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
});
