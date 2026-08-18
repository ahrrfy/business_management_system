/** عقد عام مشترك؛ لا أسرار هنا أو في أي حزمة متصفح. */
export const STOREFRONT_TURNSTILE_ACTION = "storefront_order_verify";
export const STOREFRONT_TURNSTILE_SCRIPT_ORIGIN = "https://challenges.cloudflare.com";
export const STOREFRONT_TURNSTILE_SCRIPT_URL =
  `${STOREFRONT_TURNSTILE_SCRIPT_ORIGIN}/turnstile/v0/api.js?render=explicit`;
export const STOREFRONT_TURNSTILE_TOKEN_MAX_LENGTH = 2_048;
