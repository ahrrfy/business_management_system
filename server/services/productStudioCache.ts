import { logger } from "../logger";

export interface CacheInvalidationRecord {
  companyId: number;
  productIds: number[];
  channels: ("catalog.adminList" | "catalog.posList" | "kiosk.banner" | "storefront")[];
  timestamp: string;
}

const recentInvalidations: CacheInvalidationRecord[] = [];

export function getRecentCacheInvalidations(): CacheInvalidationRecord[] {
  return [...recentInvalidations];
}

export function clearRecentCacheInvalidations(): void {
  recentInvalidations.length = 0;
}

/**
 * إبطال وتحديث كاش المنتجات عبر الأنظمة (جدول المنتجات، نقاط البيع، الراية، المتجر)
 */
export function invalidateProductStudioCaches(
  companyId: number,
  productIds: number[],
): {
  success: boolean;
  invalidatedChannels: string[];
  productCount: number;
  timestamp: string;
} {
  const channels: ("catalog.adminList" | "catalog.posList" | "kiosk.banner" | "storefront")[] = [
    "catalog.adminList",
    "catalog.posList",
    "kiosk.banner",
    "storefront",
  ];
  const uniqueProductIds = Array.from(new Set(productIds.map(Number))).filter(
    (id) => Number.isFinite(id) && id > 0,
  );
  const record: CacheInvalidationRecord = {
    companyId: Number(companyId),
    productIds: uniqueProductIds,
    channels,
    timestamp: new Date().toISOString(),
  };

  recentInvalidations.push(record);
  if (recentInvalidations.length > 500) {
    recentInvalidations.splice(0, recentInvalidations.length - 500);
  }

  logger.info(
    { companyId, productCount: uniqueProductIds.length, channels },
    "product studio multi-system cache invalidation dispatched",
  );

  return {
    success: true,
    invalidatedChannels: channels,
    productCount: uniqueProductIds.length,
    timestamp: record.timestamp,
  };
}
