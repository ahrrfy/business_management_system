/** المسار الوحيد الذي يمكن فتحه عند إقلاع بارد بلا جلسة شبكة: استعادة مسودة Studio مشفرة. */
export const COLD_OFFLINE_STUDIO_PATH = "/catalog/image-studio";
const STUDIO_LOCAL_ROLES = new Set([
  "admin",
  "manager",
  "print_operator",
  "auditor",
]);

export function isColdOfflineStudioRoute(location: string): boolean {
  return location.split("?", 1)[0] === COLD_OFFLINE_STUDIO_PATH;
}

/**
 * يربط إذن Studio البارد بثلاثة أدلة محلية معاً: PIN هذه الجلسة، ملف الجهاز،
 * وهوية المسودة المشفّرة. الهوية وحدها ليست تصريحاً.
 */
export function coldOfflineStudioActor({
  pinVerified,
  profile,
  draftIdentityUserId,
}: {
  pinVerified: boolean;
  profile: { userId: number; role: string; hasPin: boolean } | null;
  draftIdentityUserId: number | null;
}): { userId: number; role: string } | null {
  if (
    !pinVerified ||
    !profile?.hasPin ||
    profile.userId !== draftIdentityUserId ||
    !STUDIO_LOCAL_ROLES.has(profile.role)
  )
    return null;
  return { userId: profile.userId, role: profile.role };
}

/** يكتب الحقلـات العامة لملف PIN فقط؛ PIN لا ينشأ ولا ينتقل من الجلسة. */
export function studioOfflineProfileInput(user: {
  id: number;
  name: string | null | undefined;
  email?: string | null;
  role: string | null | undefined;
  branchId: number | null | undefined;
}) {
  return {
    id: Number(user.id),
    name: user.name?.trim() || user.email?.trim() || "",
    role: user.role ?? "",
    branchId: user.branchId ?? null,
  };
}

/** AppLayout لا يوقف auth.me إلا بعد أن يثبت المسار وPIN وملف جلسة محلي. */
export function shouldSkipColdStudioAuth({
  location,
  offline,
  pinVerified,
  localProfile,
}: {
  location: string;
  offline: boolean;
  pinVerified: boolean;
  localProfile: { userId: number; role: string } | null;
}): boolean {
  return (
    isColdOfflineStudioRoute(location) &&
    offline &&
    pinVerified &&
    localProfile != null
  );
}

/**
 * الفصل بين التحرير المحلي والسلطة البعيدة متعمّد: الهوية المشفرة تساعد في إيجاد
 * المسودة فقط، ولا تسمح بطلب خادم أو مخزن أو مزود AI.
 */
export function studioOfflineCapabilities({
  offline,
  storageReady,
}: {
  offline: boolean;
  storageReady: boolean | undefined;
}) {
  return {
    canEditLocalDraft: offline || storageReady === true,
    canCallServer: !offline,
    canUseProviderOrStorage: !offline && storageReady === true,
  };
}
