/** المسار الوحيد الذي يمكن فتحه عند إقلاع بارد بلا جلسة شبكة: استعادة مسودة Studio مشفرة. */
export const COLD_OFFLINE_STUDIO_PATH = "/catalog/image-studio";

export function isColdOfflineStudioRoute(location: string): boolean {
  return location.split("?", 1)[0] === COLD_OFFLINE_STUDIO_PATH;
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
