import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { voucherCategories } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import {
  isVoucherCategoryRoleCompatible,
  type VoucherCategoryDirection,
  type VoucherCategoryPostingRole,
} from "../../../shared/voucherCategoryAccounting";

export function assertVoucherCategoryDefinition(input: {
  direction: VoucherCategoryDirection;
  postingRole: string | null | undefined;
  isActive?: boolean;
  name?: string;
}): asserts input is typeof input & { postingRole: VoucherCategoryPostingRole } {
  const label = input.name?.trim() ? ` «${input.name.trim()}»` : "";
  if (!input.postingRole) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `فئة السند${label} بلا حساب مقابل معتمد — عيّن الحساب المحاسبي من إدارة الفئات قبل استعمالها`,
    });
  }
  if (!isVoucherCategoryRoleCompatible(input.direction, input.postingRole)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `الحساب المقابل المختار لا يتوافق مع اتجاه فئة السند${label}`,
    });
  }
}

export async function loadVoucherCategoryForPosting(
  tx: Tx,
  categoryId: number,
  direction: "IN" | "OUT",
  options: { allowInactive?: boolean; lock?: boolean } = {},
) {
  let query = tx
    .select()
    .from(voucherCategories)
    .where(eq(voucherCategories.id, categoryId));
  const rows = options.lock
    ? await query.for("update").limit(1)
    : await query.limit(1);
  const category = rows[0];
  if (!category) {
    throw new TRPCError({ code: "NOT_FOUND", message: "فئة السند غير موجودة" });
  }
  if (!options.allowInactive && !category.isActive) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `فئة «${category.name}» معطّلة`,
    });
  }
  if (category.direction !== "BOTH" && category.direction !== direction) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `فئة «${category.name}» مخصّصة لسندات ${category.direction === "IN" ? "القبض" : "الصرف"} فقط`,
    });
  }
  assertVoucherCategoryDefinition({
    direction: category.direction,
    postingRole: category.postingRole,
    isActive: category.isActive,
    name: category.name,
  });
  return {
    ...category,
    postingRole: category.postingRole as VoucherCategoryPostingRole,
  };
}

export interface VoucherCategoryMappingIssue {
  id: number;
  name: string;
  reason: "UNMAPPED" | "INCOMPATIBLE" | "ACCOUNT_INACTIVE";
}

/**
 * تصنيف بوابة ACTIVE خالص وقابل للاختبار. الفئة المعطلة غير المستعملة لا
 * تحجب القطع؛ أمّا المستعملة تاريخياً فتبقى ضمن التدقيق حتى بعد تعطيلها.
 */
export function findVoucherCategoryMappingIssues(
  categories: ReadonlyArray<{
    id: number | bigint;
    name: string;
    direction: VoucherCategoryDirection;
    postingRole: string | null;
    isActive: boolean;
  }>,
  usedCategoryIds: ReadonlySet<number>,
  activeAccountRoles?: ReadonlySet<string>,
): VoucherCategoryMappingIssue[] {
  const issues: VoucherCategoryMappingIssue[] = [];
  for (const category of categories) {
    const id = Number(category.id);
    if (!category.isActive && !usedCategoryIds.has(id)) continue;
    if (!category.postingRole) {
      issues.push({ id, name: category.name, reason: "UNMAPPED" });
      continue;
    }
    if (!isVoucherCategoryRoleCompatible(category.direction, category.postingRole)) {
      issues.push({ id, name: category.name, reason: "INCOMPATIBLE" });
      continue;
    }
    if (activeAccountRoles && !activeAccountRoles.has(category.postingRole)) {
      issues.push({ id, name: category.name, reason: "ACCOUNT_INACTIVE" });
    }
  }
  return issues;
}
