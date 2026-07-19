/**
 * اختبار trackOnlineOrder — تتبّع طلب المتجر بالرقم + الهاتف. الإصلاح: الهاتف المخزَّن E.164،
 * فنُوحّد المُدخَل (normalizeStorePhone) قبل المطابقة كي يُطابق زبونٌ يُدخل صيغته المحلّية «0770…».
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { trackOnlineOrder } from "../onlineOrderService";

const TABLES = ["onlineOrderItems", "onlineOrders", "customers", "branches"];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

beforeEach(async () => {
  await reset();
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  // الهاتف مخزَّنٌ بصيغة E.164 (كما يكتبه إنشاء الطلب عبر normalizeStorePhone).
  await d.insert(s.customers).values({ id: 1, name: "زبون", phone: "+9647701234567" });
  await d.insert(s.onlineOrders).values({
    orderNumber: "ORD-9",
    customerId: 1,
    branchId: 1,
    subtotal: "100.00",
    shippingCost: "5.00",
    taxAmount: "0",
    total: "105.00",
    status: "CONFIRMED",
    governorate: "baghdad",
  });
});

describe("trackOnlineOrder — توحيد الهاتف قبل المطابقة", () => {
  it("الصيغة المحلّية «07701234567» تُطابق المخزَّن E.164", async () => {
    const r = await trackOnlineOrder("ORD-9", "07701234567");
    expect(r).toBeTruthy();
    expect(r!.orderNumber).toBe("ORD-9");
    expect(r!.status).toBe("CONFIRMED");
    expect(r!.total).toBe("105.00");
  });

  it("صيغ متعددة للهاتف نفسه تُطابق كلّها", async () => {
    for (const p of ["+9647701234567", "9647701234567", "00964 770 123 4567", "0770-123-4567", "7701234567"]) {
      expect(await trackOnlineOrder("ORD-9", p)).toBeTruthy();
    }
  });

  it("هاتفٌ مختلف ⇒ null (لا تسريب طلبٍ لرقمٍ لا يملكه)", async () => {
    expect(await trackOnlineOrder("ORD-9", "07709999999")).toBeNull();
  });

  it("رقم طلبٍ غير موجود ⇒ null", async () => {
    expect(await trackOnlineOrder("ORD-404", "07701234567")).toBeNull();
  });
});
