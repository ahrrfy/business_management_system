/** إغلاق وردية استقبالٍ عالقة في قاعدة التطوير كي تفتح موظّفة الاستقبال ورديتها. تطويريّ محض. */
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { getDb } from "../server/db";
import { closeShift, computeExpectedCash } from "../server/services/shiftService";

if (!/_dev(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("قاعدة غير تطويرية"); process.exit(1); }
const db = getDb()!;

async function main() {
  const open = await db.select().from(s.shifts).where(eq(s.shifts.status, "OPEN"));
  for (const sh of open) {
    let counted = "0";
    try { counted = String(await computeExpectedCash(Number(sh.id))); } catch { counted = String(sh.expectedCash ?? "0"); }
    await closeShift({ shiftId: Number(sh.id), countedCash: counted },
      { userId: Number(sh.userId), branchId: Number(sh.branchId), role: "admin" } as never);
    console.log(`أُغلقت الوردية #${sh.id} (مستخدم ${sh.userId}, ${sh.shiftType}) بنقدٍ معدود ${counted}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
