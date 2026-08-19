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
