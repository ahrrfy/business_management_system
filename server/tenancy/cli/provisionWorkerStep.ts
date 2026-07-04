import "dotenv/config";
import { readFileSync } from "node:fs";
import { closeControlDb } from "../controlDb";
import {
  claimNextPendingRequest,
  markProvisionRequestDone,
  markProvisionRequestFailed,
} from "../provisionRequests";

/**
 * نقطة دخول CLI صغيرة تُستدعى من `scripts/company-provision-worker.mjs` (عبر tsx) —
 * كل عمليات قاعدة التحكّم المكتوبة بـDrizzle/TS (فكّ التشفير، التحديث الشرطي الذرّي)
 * تعيش هنا؛ العامل نفسه (.mjs خام) يتولّى فقط التوفير الفعلي (docker/عمليات فرعية).
 * نفس نمط registerCompany.ts (ملف JSON مؤقّت لا وسيط CLI خام — يتفادى إفساد الاقتباس
 * على ويندوز عبر execFileSync بـshell:true).
 *
 * الأوامر:
 *   claim-next                      → يطبع JSON لطلبٍ مُطالَبٍ به (مع كلمة المرور مفكوكة
 *                                      التشفير) أو null إن لم يوجد طلب PENDING.
 *   mark-done <ملف JSON {id,companyId}>
 *   mark-failed <ملف JSON {id,errorMessage}>
 */
async function main() {
  const [, , command, payloadPath] = process.argv;

  if (command === "claim-next") {
    const claimed = await claimNextPendingRequest();
    console.log(JSON.stringify(claimed));
    return;
  }

  if (command === "mark-done") {
    if (!payloadPath) throw new Error("mark-done يتطلّب مسار ملف JSON {id, companyId}");
    const { id, companyId } = JSON.parse(readFileSync(payloadPath, "utf8"));
    await markProvisionRequestDone(id, companyId);
    return;
  }

  if (command === "mark-failed") {
    if (!payloadPath) throw new Error("mark-failed يتطلّب مسار ملف JSON {id, errorMessage}");
    const { id, errorMessage } = JSON.parse(readFileSync(payloadPath, "utf8"));
    await markProvisionRequestFailed(id, errorMessage);
    return;
  }

  throw new Error(`أمر غير معروف: ${command} (المتاح: claim-next | mark-done | mark-failed)`);
}

main()
  .then(() => closeControlDb())
  .catch(async (e) => {
    console.error("✗ فشل provisionWorkerStep:", e?.message ?? e);
    await closeControlDb();
    process.exit(1);
  });
