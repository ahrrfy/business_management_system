/**
 * مسار Pro لاستوديو صور المنتجات: قصّ الخلفية عبر remove.bg — شريحة ٥ (Pro).
 *
 * أمانة صارمة (§١١.٢): remove.bg **قصٌّ (segmentation) لا توليد** ⇒ بكسلات المنتج تبقى حرفياً؛
 * نستقبل قصّاً شفّافاً (PNG بقناة alpha) ثم تُركّبه الواجهة على قالب الاستوديو الأبيض بظلٍّ حتميّ
 * (finishCutFromCutout) — تماماً كمسار CUT المجاني، بمُخرَجٍ واحد.
 *
 * التصميم:
 *   - `callRemovebg(apiKey, imageBase64, opts)` **نقيّ**: المفتاح مُمرَّر (لا يقرأ إعدادات) ⇒ قابل
 *     للاختبار بـfetch مُموَّه. أخطاء مصنّفة (RemovebgError.kind) ليقرّر المستدعي التدهور لـFLATTEN.
 *   - لا يُخزَّن المفتاح هنا إطلاقاً؛ الإعدادات المشفّرة في imageStudioSettingsService.
 *
 * لا نُمرّر bg_color ⇒ نستقبل شفّافاً لنُركّب نحن (أبيض + ظلّ). size=auto (رصيد=صورة واحدة؛ المفتاح
 * المجاني يُرجِع دقّة معاينة منخفضة حتماً — كافٍ للحكم على دقّة القصّ لا للإنتاج).
 */

const REMOVEBG_ENDPOINT = "https://api.remove.bg/v1.0/removebg";
const REMOVEBG_ACCOUNT_ENDPOINT = "https://api.remove.bg/v1.0/account";

/** تصنيف أخطاء remove.bg — يقود قرار التدهور في الواجهة (كلّها ⇒ FLATTEN آمن). */
export type RemovebgErrorKind =
  | "AUTH" // 403 — مفتاح خاطئ/ملغى
  | "OUT_OF_CREDITS" // 402 — نفد الرصيد
  | "RATE_LIMITED" // 429 — تجاوز الحدّ
  | "BAD_INPUT" // 400 — صورة غير صالحة/لا خلفية للقصّ
  | "SERVICE" // 5xx أو غير متوقّع
  | "NETWORK"; // فشل الوصول للخدمة أصلاً

export class RemovebgError extends Error {
  constructor(
    public readonly kind: RemovebgErrorKind,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemovebgError";
  }
}

export interface RemovebgResult {
  /** بايتات PNG بقناة alpha (القصّ الشفّاف). */
  cutout: Buffer;
  /** ما اقتُطِع من الرصيد (من ترويسة X-Credits-Charged) — للعرض/المراقبة. */
  creditsCharged: number | null;
  width: number | null;
  height: number | null;
}

export interface CallRemovebgOptions {
  /** حجم المخرَج: auto (افتراضي) | preview | full. المفتاح المجاني معاينةٌ حتماً. */
  size?: "auto" | "preview" | "full";
  /** لِحقن fetch مُموَّه في الاختبار (افتراضياً fetch العام). */
  fetchImpl?: typeof fetch;
}

/**
 * يقصّ خلفية صورة عبر remove.bg. `imageBase64` = base64 خام (بلا بادئة data:).
 * يرمي `RemovebgError` عند أي فشل ⇒ يتدهور المستدعي لـFLATTEN.
 */
export async function callRemovebg(
  apiKey: string,
  imageBase64: string,
  opts: CallRemovebgOptions = {},
): Promise<RemovebgResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams();
  body.set("image_file_b64", imageBase64);
  body.set("size", opts.size ?? "auto");
  body.set("format", "png"); // PNG ⇒ قناة alpha (شفّاف) لنُركّب نحن على أبيض + ظلّ.

  let res: Response;
  try {
    res = await doFetch(REMOVEBG_ENDPOINT, {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        Accept: "image/png, application/json",
      },
      body,
    });
  } catch (e: any) {
    throw new RemovebgError("NETWORK", 0, `تعذّر الوصول لـremove.bg: ${e?.message ?? "خطأ شبكة"}`);
  }

  if (res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new RemovebgError("SERVICE", res.status, "remove.bg أعاد جسماً فارغاً");
    }
    const credits = Number(res.headers.get("X-Credits-Charged"));
    const w = Number(res.headers.get("X-Width"));
    const h = Number(res.headers.get("X-Height"));
    return {
      cutout: buf,
      creditsCharged: Number.isFinite(credits) ? credits : null,
      width: Number.isFinite(w) && w > 0 ? w : null,
      height: Number.isFinite(h) && h > 0 ? h : null,
    };
  }

  // خطأ: نستخرج رسالة remove.bg (JSON {errors:[{title,code}]}) للتشخيص.
  let detail = "";
  try {
    const j = (await res.json()) as { errors?: Array<{ title?: string; code?: string }> };
    detail = j?.errors?.[0]?.title ?? j?.errors?.[0]?.code ?? "";
  } catch {
    detail = await res.text().catch(() => "");
  }
  detail = String(detail).slice(0, 300);

  const kind: RemovebgErrorKind =
    res.status === 402 ? "OUT_OF_CREDITS" :
    res.status === 403 ? "AUTH" :
    res.status === 429 ? "RATE_LIMITED" :
    res.status === 400 ? "BAD_INPUT" :
    "SERVICE";
  throw new RemovebgError(kind, res.status, detail || `remove.bg ${res.status}`);
}

/** رسالة عربية موجزة لكل تصنيف — للعرض في الواجهة/السجلّ (لا تُسرّب المفتاح). */
export function removebgErrorMessageAr(kind: RemovebgErrorKind): string {
  switch (kind) {
    case "AUTH":
      return "مفتاح remove.bg خاطئ أو ملغى — تحقّق من الإعدادات.";
    case "OUT_OF_CREDITS":
      return "نفد رصيد remove.bg — أعد الشحن أو استُعمل المسار المجاني.";
    case "RATE_LIMITED":
      return "تجاوزتَ حدّ الطلبات على remove.bg — أعد المحاولة بعد قليل.";
    case "BAD_INPUT":
      return "الصورة غير صالحة للقصّ (لا موضوع واضح على خلفية).";
    case "NETWORK":
      return "تعذّر الوصول لخدمة remove.bg.";
    case "SERVICE":
    default:
      return "خطأ مؤقّت من remove.bg.";
  }
}

export interface RemovebgAccount {
  /** إجمالي الرصيد المتبقّي (اشتراك + دفع-حسب-الاستخدام). */
  totalCredits: number | null;
  /** نداءات API المجانية المتبقّية هذا الشهر (المفتاح المجاني). */
  freeApiCalls: number | null;
}

/**
 * يتحقّق من صلاحية المفتاح ويجلب الرصيد **بلا اقتطاع أي رصيد** (GET /account).
 * يُستعمَل لزرّ «فحص الاتصال» في الإعدادات. يرمي RemovebgError عند مفتاح خاطئ/تعطّل.
 */
export async function getRemovebgAccount(
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<RemovebgAccount> {
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(REMOVEBG_ACCOUNT_ENDPOINT, {
      method: "GET",
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    });
  } catch (e: any) {
    throw new RemovebgError("NETWORK", 0, `تعذّر الوصول لـremove.bg: ${e?.message ?? "خطأ شبكة"}`);
  }
  if (!res.ok) {
    const kind: RemovebgErrorKind =
      res.status === 403 ? "AUTH" : res.status === 429 ? "RATE_LIMITED" : "SERVICE";
    throw new RemovebgError(kind, res.status, `remove.bg /account ${res.status}`);
  }
  const j = (await res.json().catch(() => ({}))) as {
    data?: { attributes?: { credits?: { total?: number }; api?: { free_calls?: number } } };
  };
  const attrs = j?.data?.attributes;
  const total = attrs?.credits?.total;
  const free = attrs?.api?.free_calls;
  return {
    totalCredits: typeof total === "number" ? total : null,
    freeApiCalls: typeof free === "number" ? free : null,
  };
}
