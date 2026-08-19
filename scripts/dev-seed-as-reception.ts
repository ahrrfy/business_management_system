/** طلبان باسم موظّفة الاستقبال — لرؤية الشاشات بعينها. تطويريّ محض. */
import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { getDb } from "../server/db";
import { openShift } from "../server/services/shiftService";
import { createWorkOrder } from "../server/services/workOrder/create";
import { deliverWorkOrder } from "../server/services/workOrder/deliver";

if (!/_dev(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("قاعدة غير تطويرية"); process.exit(1); }
const db = getDb()!;
const SARA = { userId: 3, branchId: 1, role: "cashier" as const };

async function main() {
  const cust = (await db.select().from(s.customers).where(isNull(s.customers.creditLimit)).limit(2));
  const open = (await db.select().from(s.shifts)
    .where(and(eq(s.shifts.shiftType, "RECEPTION"), eq(s.shifts.status, "OPEN"), eq(s.shifts.branchId, 1))).limit(1))[0];
  if (open && Number(open.userId) !== 3) {
    console.log(`وردية استقبال مفتوحة لمستخدم آخر (#${open.userId}) — الطلبات ستُنشأ بلا وردية.`);
  } else if (!open) {
    await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, SARA);
    console.log("فُتحت وردية استقبال لسارة");
  }

  // ① أمرٌ قيد التنفيذ (يظهر في الكانبان، بلا فاتورة بعد).
  const a = await createWorkOrder({
    branchId: 1, customerId: Number(cust[0].id), title: "بنر إعلاني ٣×٢ متر", quantity: 1,
    salePrice: "85000.00", deposit: "25000.00", paymentMethod: "CASH", materials: [],
    receptionChannel: "WHATSAPP", channelHandle: "+9647701112233", priority: "URGENT",
    clientRequestId: "sara-wo-1",
  } as never, SARA);
  await db.update(s.workOrders).set({ status: "IN_PROGRESS" })
    .where(eq(s.workOrders.id, Number((a as { workOrderId: number }).workOrderId)));

  // ② أمرٌ سُلّم ⇒ فاتورةٌ باسمها تظهر في «المبيعات».
  const b = await createWorkOrder({
    branchId: 1, customerId: Number(cust[1]?.id ?? cust[0].id), title: "طباعة كتالوج ٥٠ نسخة", quantity: 50,
    salePrice: "120000.00", deposit: "0", materials: [],
    receptionChannel: "PHONE", channelHandle: "+9647702223344",
    clientRequestId: "sara-wo-2",
  } as never, SARA);
  const bId = Number((b as { workOrderId: number }).workOrderId);
  await db.update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, bId));
  await deliverWorkOrder({ workOrderId: bId, payment: { amount: "60000.00", method: "CASH" } }, SARA);

  const rows = await db.select({ n: s.workOrders.orderNumber, st: s.workOrders.status, by: s.workOrders.createdBy, inv: s.workOrders.invoiceId })
    .from(s.workOrders);
  console.table(rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
