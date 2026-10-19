// أدوات مشتركة: تسلسل سعر الصرف، قفل صفّ الصيرفة، وترقيم عمليات الصيرفة. داخلية للحزمة فقط.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { desc, eq, like, sql } from "drizzle-orm";
import { exchangeHouses, exchangeTransactions } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { toDateStr } from "../money";
import { nextCounterValue } from "../numbering";

/** تسلسل لسعر صرف بمنزلتين أربع (decimal(15,4)). */
const toDbRate = (x: Decimal): string => x.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);

/** قفل صفّ الصيرفة وقراءته (يجب أن يسبق أي خصم لمنع السباق). */
async function lockHouse(tx: Tx, exchangeHouseId: number) {
  const rows = await tx
    .select()
    .from(exchangeHouses)
    .where(eq(exchangeHouses.id, exchangeHouseId))
    .for("update")
    .limit(1);
  const h = rows[0];
  if (!h) throw new TRPCError({ code: "NOT_FOUND", message: "الصيرفة غير موجودة" });
  if (!h.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الصيرفة معطَّلة" });
  return h;
}

/** توليد رقم عملية صيرفة فريد لكل (فرع×يوم): EX-{branch}-{YYYYMMDD}-{seq} عبر عدّاد documentCounters الذرّي لمنع السباق. */
async function nextTxnNumber(tx: Tx, branchId: number | null): Promise<string> {
  const b = branchId ?? 0;
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `EX-${b}-${ymd}-`;
  const counterKey = `exchange_${b}_${ymd}`;
  const seq = await nextCounterValue(tx, counterKey);
  return prefix + String(seq).padStart(5, "0");
}


export { toDbRate, lockHouse, nextTxnNumber };
