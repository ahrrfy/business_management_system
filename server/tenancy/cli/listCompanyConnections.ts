import "dotenv/config";
import { listActiveCompanyConnections } from "../registry";
import { closeControlDb } from "../controlDb";

/**
 * نقطة دخول CLI صغيرة تُستدعى من scripts/backup.mjs (وضع --all-companies) لجلب
 * قائمة (رمز + عنوان اتصال كامل) لكل شركة فعّالة، عبر tsx (registry.ts وحدة TS).
 * تطبع JSON فقط (سطر واحد) — لا شيء آخر في stdout حتى تبقى قابلة للتحليل مباشرة.
 */
async function main() {
  const rows = await listActiveCompanyConnections();
  console.log(JSON.stringify(rows.map((r) => ({ code: r.code, connectionUrl: r.connectionUrl }))));
}

main()
  .then(() => closeControlDb())
  .catch(async (e) => {
    console.error("✗ فشل جلب قائمة اتصالات الشركات:", e?.message ?? e);
    await closeControlDb();
    process.exit(1);
  });
