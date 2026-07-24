/**
 * الطبقة الدنيا للاتصال بـWhatsApp Cloud API (ومزوّدين متوافقين حياديّاً عبر apiBaseUrl) — شريحة #١
 * (نواة Cloud API). مسؤوليتها فقط: بناء الطلب HTTP وتفكيك الاستجابة بلا رمي ولا تصنيف؛ التصنيف
 * (قابل لإعادة المحاولة/دائم) مسؤولية sendService.classifyGraphError.
 */

/** إصدار Graph API المثبَّت — لا تُرفَع بلا قرار مالك صريح (مطابقة verifyWhatsAppConnection القائمة
 *  في integrationService.ts، v18.0 أيضاً). */
export const GRAPH_VERSION = "v18.0";

/** الحدّ الأدنى من بيانات التكامل اللازمة لضرب Graph API — حياديّة عن شكل channelIntegrations الكامل
 *  (فكّ التشفير مسؤولية المستدعي — outboxService.getActiveWaIntegration). */
export interface GraphIntegration {
  accessToken: string;
  phoneNumberId: string;
  /** null/غياب = graph.facebook.com الافتراضي (Meta). مُخصَّص = مزوّد متوافق آخر (حياديّة المزوّد). */
  apiBaseUrl?: string | null;
}

/** قاعدة الـAPI لتكامل مُعطى — تُزيل «/» الزائدة، وتُطبِّق افتراضي Meta عند الغياب. */
export function graphBaseUrl(integration: { apiBaseUrl?: string | null }): string {
  return integration.apiBaseUrl?.replace(/\/$/, "") ?? "https://graph.facebook.com";
}

export interface GraphFetchInit {
  method?: "GET" | "POST" | "DELETE";
  /** جسم JSON — يُسلسَل تلقائياً؛ لا تُمرِّر نصّاً مُسلسَلاً مسبقاً. */
  body?: Record<string, unknown>;
}

export interface GraphFetchResult {
  /** true فقط حين ردّ HTTP 2xx فعلياً (فشل الشبكة ⇒ false وstatus=0). */
  ok: boolean;
  /** 0 يعني فشل شبكة (استثناء fetch) لا رمزاً حقيقياً من الخادم. */
  status: number;
  /** جسم الاستجابة مفكوكاً (JSON) أو null لو تعذّر التفكيك/الجسم فارغ. */
  body: unknown;
}

/**
 * يضرب Graph API ويعيد النتيجة مفكوكة بلا رمي أبداً (لا على فشل شبكة ولا على 4xx/5xx) — التصنيف
 * (قابل لإعادة المحاولة/دائم/يستحقّ الإيقاف) مسؤولية المستدعي (classifyGraphError في sendService.ts).
 * fetchImpl قابل للحقن في الاختبار (افتراضياً fetch العام).
 */
export async function graphFetch(
  integration: { accessToken: string; apiBaseUrl?: string | null },
  path: string,
  init: GraphFetchInit = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GraphFetchResult> {
  const url = `${graphBaseUrl(integration)}/${GRAPH_VERSION}${path}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${integration.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (e: any) {
    // فشل شبكة (DNS/timeout/انقطاع) — لا رمي، نُعيد status=0 ليُصنَّف retryable دائماً.
    return { ok: false, status: 0, body: { error: { message: e?.message ?? "تعذّر الوصول لـWhatsApp Cloud API" } } };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}
