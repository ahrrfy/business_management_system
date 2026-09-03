/**
 * إعادةُ ختم بصمات حمولات طلبات التحكّم **المعلَّقة** بعد إصلاح `idempotencyHash` (٣/٩/٢٦).
 *
 * الجذر: كانت البصمة تُحسب على كائن JS الخامّ (المفتاح `undefined` ⇒ `"key":null`) بينما
 * تُخزَّن الحمولة في عمود JSON يُسقط ذلك المفتاح ⇒ كلُّ طلبٍ معلَّق أُنشئ قبل الإصلاح يحمل
 * بصمةً لا تستطيع أيُّ قراءةٍ من القاعدة إعادةَ إنتاجها، فيُرفض اعتمادُه إلى الأبد
 * («حمولة الطلب لا تطابق بصمتها المحفوظة») — طريقٌ مسدود لا مخرجَ منه إلا سحبُ الطلب وإعادتُه.
 *
 * الإصلاح: إعادةُ الختم من الحمولة **المخزَّنة** — وهي بعينها ما سيُنفَّذ عند الاعتماد — للصفوف
 * PENDING وحدها، وطباعةُ كلّ صفٍّ (القديم → الجديد) في سجلّ النشر. الصفوفُ المحسومة لا تُمَسّ،
 * والصفوفُ التي بصمتُها صحيحةٌ أصلاً لا تُكتَب. السكربت idempotent: إعادةُ تشغيله بعد النجاح
 * تُطبع «لا شيء».
 *
 * الاستعمال:  pnpm repair:control-request-hashes              (معاينة — لا كتابة)
 *             pnpm repair:control-request-hashes -- --apply    (كتابة)
 * يُستدعى تلقائياً من `scripts/deploy.mjs` (الخطوة 5/12) بعد الهجرات.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import type { AnyMySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import {
  commissionRunApprovalRequests,
  deliveryCodWriteOffRequests,
  salesControlRequests,
  workOrderControlRequests,
} from "../drizzle/schema";
import { closeDb, getDb } from "../server/db";
import { idempotencyHash } from "../server/services/idempotency";

const APPLY = process.argv.includes("--apply");

interface Target {
  name: string;
  table: MySqlTable;
  id: AnyMySqlColumn;
  status: AnyMySqlColumn;
  payload: AnyMySqlColumn;
  payloadHash: AnyMySqlColumn;
  /** لقطة الفاتورة (مبيعات فقط): تُفحص وتُبلَّغ ولا تُعاد كتابتها — الاختلاف فيها يُوسم STALE بأمان. */
  snapshot?: { column: AnyMySqlColumn; hash: AnyMySqlColumn };
}

const TARGETS: Target[] = [
  {
    name: "salesControlRequests",
    table: salesControlRequests,
    id: salesControlRequests.id,
    status: salesControlRequests.status,
    payload: salesControlRequests.payload,
    payloadHash: salesControlRequests.payloadHash,
    snapshot: { column: salesControlRequests.invoiceSnapshot, hash: salesControlRequests.snapshotHash },
  },
  {
    name: "workOrderControlRequests",
    table: workOrderControlRequests,
    id: workOrderControlRequests.id,
    status: workOrderControlRequests.status,
    payload: workOrderControlRequests.payload,
    payloadHash: workOrderControlRequests.payloadHash,
  },
  {
    name: "deliveryCodWriteOffRequests",
    table: deliveryCodWriteOffRequests,
    id: deliveryCodWriteOffRequests.id,
    status: deliveryCodWriteOffRequests.status,
    payload: deliveryCodWriteOffRequests.payload,
    payloadHash: deliveryCodWriteOffRequests.payloadHash,
  },
  {
    name: "commissionRunApprovalRequests",
    table: commissionRunApprovalRequests,
    id: commissionRunApprovalRequests.id,
    status: commissionRunApprovalRequests.status,
    payload: commissionRunApprovalRequests.payload,
    payloadHash: commissionRunApprovalRequests.payloadHash,
  },
];

async function main(): Promise<number> {
  const db = getDb();
  if (!db) {
    console.error("⛔ DATABASE_URL غير مضبوط (أو وضع تعدّد الشركات مفعَّل) — لا قاعدة لإصلاحها.");
    return 1;
  }
  console.log(`→ إعادة ختم بصمات طلبات التحكّم المعلَّقة (${APPLY ? "كتابة" : "معاينة فقط — أضف --apply للكتابة"})`);
  let mismatched = 0;
  let repaired = 0;
  let snapshotWarnings = 0;
  for (const t of TARGETS) {
    const rows = await db
      .select({
        id: t.id,
        payload: t.payload,
        payloadHash: t.payloadHash,
        ...(t.snapshot ? { snapshot: t.snapshot.column, snapshotHash: t.snapshot.hash } : {}),
      })
      .from(t.table)
      .where(eq(t.status, "PENDING"));
    let tableMismatch = 0;
    for (const row of rows as Array<Record<string, unknown>>) {
      const id = Number(row.id);
      const stored = String(row.payloadHash);
      const recomputed = idempotencyHash(row.payload);
      if (t.snapshot && row.snapshotHash != null && idempotencyHash(row.snapshot) !== String(row.snapshotHash)) {
        snapshotWarnings += 1;
        console.warn(`   ⚠ ${t.name}#${id}: بصمة اللقطة لا تطابق المخزَّن — لن تُعاد كتابتها؛ الاعتماد سيَسِمه STALE ويُعاد طلبُه.`);
      }
      if (recomputed === stored) continue;
      mismatched += 1;
      tableMismatch += 1;
      console.log(`   • ${t.name}#${id}: ${stored.slice(0, 12)}… → ${recomputed.slice(0, 12)}…`);
      if (!APPLY) continue;
      // شرطُ التطابق على القديم يجعل الكتابة ذرّيةً حتى لو تسابق اعتمادٌ/سحبٌ متزامن.
      const result = await db.execute(
        sql`UPDATE ${t.table} SET ${sql.identifier(t.payloadHash.name)} = ${recomputed}
            WHERE ${sql.identifier(t.id.name)} = ${id}
              AND ${sql.identifier(t.payloadHash.name)} = ${stored}
              AND ${sql.identifier(t.status.name)} = 'PENDING'`,
      );
      const affected = Number((result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
      if (affected === 1) repaired += 1;
      else console.warn(`   ⚠ ${t.name}#${id}: لم يُكتب (تغيّر الصفّ أثناء الإصلاح) — أعد التشغيل.`);
    }
    console.log(`   ${t.name}: ${rows.length} معلَّق · ${tableMismatch} بحاجة إلى إعادة ختم`);
  }
  console.log(
    APPLY
      ? `✓ أُعيد ختم ${repaired} من ${mismatched} صفّاً${snapshotWarnings ? ` · تحذيرات لقطة: ${snapshotWarnings}` : ""}.`
      : `✓ معاينة: ${mismatched} صفّاً بحاجة إلى إعادة ختم${snapshotWarnings ? ` · تحذيرات لقطة: ${snapshotWarnings}` : ""}.`,
  );
  return APPLY && repaired !== mismatched ? 1 : 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("✗ فشل إصلاح البصمات:", error);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
