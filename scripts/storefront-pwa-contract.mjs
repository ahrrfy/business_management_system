export const STOREFRONT_SHELL_CHUNK_GLOB =
  "assets/{Storefront,framework,data-client,ui-vendor,icons,observability,offline-store,charts,onlineOrderStatus,money,governorates,whatsapp,TurnstileWidget,IntlPhoneInput,date,invoiceStatus,intlPhone,numberNormalize}-*.js";

/** Workbox CacheFirst is allowed only for server routes whose response is public. */
export function storefrontPublicImageCacheMatcher({ request, url }) {
  // Keep the matcher self-contained: Workbox serializes this function into sw.js.
  return request?.method === "GET" && [
    /^\/api\/img\/banner\/[^/]+\/[^/]+$/,
    /^\/api\/img\/product\/[^/]+$/,
    /^\/api\/img\/company\/[^/]+\/product\/[^/]+$/,
  ].some((pattern) => pattern.test(url.pathname));
}

/** Auth-derived image responses must always reach the server and its current authorization gate. */
export function storefrontPrivateImageNetworkMatcher({ url }) {
  // Keep the matcher self-contained: Workbox serializes this function into sw.js.
  return [
    /^\/api\/img\/inventory-product\/[^/]+$/,
    /^\/api\/img\/count-product\/[^/]+\/[^/]+$/,
    /^\/api\/img\/kiosk-product\/[^/]+$/,
  ].some((pattern) => pattern.test(url.pathname));
}
