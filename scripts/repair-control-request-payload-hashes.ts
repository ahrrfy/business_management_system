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
 * والصفوفُ التي بصمتُها صحيحةٌ أصلاً لا تُكتَب.
 *
 * **مرّةٌ واحدة لكلّ قاعدة** (مراجعة Codex على #956، P1): بعد نجاح `--apply` تُسجَّل علامةُ
 * إتمامٍ في `idempotencyKeys` فلا يُعاد التوقيع على أيّ تعارضٍ مستقبليّ — وهو بالضبط ما وُضع
 * فحصُ البصمة عند الاعتماد ليكشفه. `--force` يتجاوز العلامة صراحةً (تشخيصٌ يدويّ فقط).
 * ويُنفَّذ من النشر **بعد** تبديل العمال (P2) كي لا يكتب عاملٌ قديم صفّاً قديم الختم بعد المسح.
 *
 * **تعدّد الشركات** (P2): مع `CONTROL_DATABASE_URL` يُطبَّق على كلّ قاعدة شركةٍ فعّالة داخل
 * سياقها (`runWithCompany`)، بنفس نهج `migrate-all-companies.mjs`.
 *
 * الاستعمال:  pnpm repair:control-request-hashes                       (معاينة — لا كتابة)
 *             pnpm repair:control-request-hashes -- --apply             (كتابة، مرّة واحدة)
 *             pnpm repair:control-request-hashes -- --apply --force     (تجاوز علامة الإتمام)
 */
import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import type { AnyMySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import {
  commissionRunApprovalRequests,
  deliveryCodWriteOffRequests,
  idempotencyKeys,
  salesControlRequests,
  workOrderControlRequests,
} from "../drizzle/schema";
import { closeDb, getDb, isMultiTenantModeActive, withTenantDb, type DB } from "../server/db";
import { idempotencyHash } from "../server/services/idempotency";
import { runWithCompany } from "../server/tenancy/context";
import { closeControlDb } from "../server/tenancy/controlDb";
import { listActiveCompanyConnections } from "../server/tenancy/registry";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

/** علامة الإتمام: (operation, clientRequestId) ثابتان لهذا الإصلاح بعينه — تغييرُ الصيغة مستقبلاً = مفتاحٌ جديد. */
const COMPLETION_OPERATION = "repair.control-request-hashes";
const COMPLETION_KEY = "2026-09-03-json-roundtrip-v1";

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

async function completionRecorded(db: DB): Promise<boolean> {
  const rows = await db
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.operation, COMPLETION_OPERATION),
        eq(idempotencyKeys.clientRequestId, COMPLETION_KEY),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** يعيد 0 عند النجاح، و1 حين بقي صفٌّ لم يُكتب. */
async function repairDatabase(db: DB, label: string): Promise<number> {
  if (!FORCE && (await completionRecorded(db))) {
    console.log(
      `   [${label}] ✓ الإصلاح مُتمَّم سلفاً في هذه القاعدة (${COMPLETION_KEY}) — لا مسح. (--force للتجاوز)`,
    );
    return 0;
  }
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
      if (
        t.snapshot &&
        row.snapshotHash != null &&
        idempotencyHash(row.snapshot) !== String(row.snapshotHash)
      ) {
        snapshotWarnings += 1;
        console.warn(
          `   [${label}] ⚠ ${t.name}#${id}: بصمة اللقطة لا تطابق المخزَّن — لن تُعاد كتابتها؛ الاعتماد سيَسِمه STALE ويُعاد طلبُه.`,
        );
      }
      if (recomputed === stored) continue;
      mismatched += 1;
      tableMismatch += 1;
      console.log(`   [${label}] • ${t.name}#${id}: ${stored.slice(0, 12)}… → ${recomputed.slice(0, 12)}…`);
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
      else console.warn(`   [${label}] ⚠ ${t.name}#${id}: لم يُكتب (تغيّر الصفّ أثناء الإصلاح) — أعد التشغيل.`);
    }
    console.log(`   [${label}] ${t.name}: ${rows.length} معلَّق · ${tableMismatch} بحاجة إلى إعادة ختم`);
  }
  const snapshotNote = snapshotWarnings ? ` · تحذيرات لقطة: ${snapshotWarnings}` : "";
  if (!APPLY) {
    console.log(`   [${label}] ✓ معاينة: ${mismatched} صفّاً بحاجة إلى إعادة ختم${snapshotNote}.`);
    return 0;
  }
  const complete = repaired === mismatched;
  console.log(`   [${label}] ✓ أُعيد ختم ${repaired} من ${mismatched} صفّاً${snapshotNote}.`);
  if (complete && !(await completionRecorded(db))) {
    await db.insert(idempotencyKeys).values({
      operation: COMPLETION_OPERATION,
      clientRequestId: COMPLETION_KEY,
      refId: repaired,
      payloadHash: null,
    });
    console.log(`   [${label}] ✓ سُجِّلت علامة الإتمام — لن يُعاد المسح في النشرات القادمة.`);
  }
  return complete ? 0 : 1;
}

async function main(): Promise<number> {
  console.log(
    `→ إعادة ختم بصمات طلبات التحكّم المعلَّقة (${APPLY ? "كتابة" : "معاينة فقط — أضف --apply للكتابة"}${FORCE ? " · --force" : ""})`,
  );
  if (isMultiTenantModeActive()) {
    const companies = await listActiveCompanyConnections();
    if (companies.length === 0) {
      console.log("• لا شركات فعّالة في قاعدة التحكّم — لا شيء لإصلاحه.");
      return 0;
    }
    let worst = 0;
    for (const company of companies) {
      const code = await withTenantDb(company.id, (db) =>
        runWithCompany(company.id, db, () => repairDatabase(db, company.code)),
      );
      worst = Math.max(worst, code);
    }
    return worst;
  }
  const db = getDb();
  if (!db) {
    console.error("⛔ DATABASE_URL غير مضبوط — لا قاعدة لإصلاحها.");
    return 1;
  }
  return repairDatabase(db, "single");
}

main()
  .then(async (code) => {
    await closeDb();
    await closeControlDb().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("✗ فشل إصلاح البصمات:", error);
    await closeDb().catch(() => undefined);
    await closeControlDb().catch(() => undefined);
    process.exit(1);
  });
