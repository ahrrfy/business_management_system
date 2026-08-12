import { getCurrentCompanyId, runWithCompany } from "./context";
import { isMultiTenantModeActive, withTenantDb } from "../db";
import { logger } from "../logger";
import { listActiveCompanyConnections } from "./registry";

/**
 * يشغّل دورة خلفية مرة لكل شركة فعّالة. التنفيذ تسلسلي عمداً كي لا تُفتح تجمعات كل
 * الشركات دفعة واحدة، ويحمل كل تشغيل lease وسياق ALS كاملين حتى نهايته.
 */
export async function runAcrossActiveTenants<T>(
  job: string,
  operation: () => Promise<T>,
): Promise<T[]> {
  if (!isMultiTenantModeActive() || getCurrentCompanyId() != null) {
    return [await operation()];
  }

  const companies = await listActiveCompanyConnections();
  const results: T[] = [];
  for (const company of companies) {
    try {
      const result = await withTenantDb(company.id, (db) =>
        runWithCompany(company.id, db, operation),
      );
      results.push(result);
    } catch (error) {
      logger.error({ err: error, companyId: company.id, job }, "tenant.background_job.failed");
    }
  }
  return results;
}
