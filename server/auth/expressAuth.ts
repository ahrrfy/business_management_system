import type { Request } from "express";
import { getSessionContext } from "./session";
import {
  normalizeOwnerAuthority,
  resolveCustomRole,
  type AuthUser,
} from "../context";
import { twoFactorEnrollmentRequired } from "../trpc";

export type ExpressAuthResult =
  | {
      ok: true;
      user: AuthUser;
      sessionId: number | null;
    }
  | {
      ok: false;
      status: 401 | 403;
      error: string;
    };

export interface ExpressAuthOptions {
  /** السماح بالجلسات التي لم تُكمل بعد تغيير كلمة المرور المؤقتة أو تفعيل 2FA (مثل تحرير SSE للـ PWA فقط). */
  allowPendingOnboarding?: boolean;
}

/**
 * بوابة مصادقة موحّدة لمسارات Express خارج tRPC:
 * تُطبِّق حلّ الدور المخصص (`resolveCustomRole`)، قفل الدور المعطّل (`roleLockedByInactiveCustomRole`)،
 * حظر الحساب الملزم بتغيير كلمة المرور المؤقتة (`mustChangePassword`)، وإلزام المصادقة الثنائية (`2FA`).
 */
export async function authenticateExpressRequest(
  req: Request,
  options?: ExpressAuthOptions,
): Promise<ExpressAuthResult> {
  let sessionCtx: Awaited<ReturnType<typeof getSessionContext>>;
  try {
    sessionCtx = await getSessionContext(req);
  } catch {
    return { ok: false, status: 401, error: "جلسة غير صالحة أو منتهية الصلاحية." };
  }

  const rawUser = sessionCtx.user;
  if (!rawUser) {
    return { ok: false, status: 401, error: "يلزم تسجيل الدخول." };
  }

  const user = rawUser as AuthUser;
  if (user.isOwner) {
    normalizeOwnerAuthority(user);
  } else {
    await resolveCustomRole(user);
  }

  if (user.roleLockedByInactiveCustomRole) {
    return {
      ok: false,
      status: 403,
      error: "تم تعطيل الدور المخصص المرتبط بهذا الحساب؛ راجع مسؤول النظام.",
    };
  }

  if (!options?.allowPendingOnboarding) {
    if (user.mustChangePassword) {
      return {
        ok: false,
        status: 403,
        error: "يجب تغيير كلمة المرور المؤقتة قبل المتابعة.",
      };
    }
    if (twoFactorEnrollmentRequired(user)) {
      return {
        ok: false,
        status: 403,
        error: "يلزم تفعيل المصادقة الثنائية (2FA) للمتابعة — سياسة إلزامية للمدير/المشرف.",
      };
    }
  }

  return {
    ok: true,
    user,
    sessionId: sessionCtx.sessionId,
  };
}
