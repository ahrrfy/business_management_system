const CV_PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_CV_BYTES = 2 * 1024 * 1024;
const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ApplicantCvDownload = {
  blob: Blob;
  filename: string;
};

function safeApplicantName(value: string): string {
  return (
    value
      .normalize("NFC")
      .replace(
        /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*;]/g,
        "_",
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "المتقدم"
  );
}

function downloadExtension(
  contentType: string | null,
): ".pdf" | ".docx" | null {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === PDF_MIME) return ".pdf";
  if (normalized === DOCX_MIME) return ".docx";
  return null;
}

function responseError(status: number): Error {
  if (status === 401)
    return new Error(
      "انتهت جلسة الدخول. سجّل الدخول ثم أعد تنزيل السيرة الذاتية.",
    );
  if (status === 403) return new Error("لا تملك صلاحية تنزيل ملفات المتقدمين.");
  if (status === 404)
    return new Error("ملف السيرة الذاتية غير موجود أو لا يتبع فرعك.");
  return new Error(`تعذّر تنزيل السيرة الذاتية (${status}). حاول مرة أخرى.`);
}

/**
 * يجلب السيرة داخل جلسة التطبيق نفسها. هذا يمنع مدير التنزيل الخارجي من إعادة فتح
 * رابط محمي بلا كوكي الجلسة وإظهار نافذة اسم مستخدم/كلمة مرور مستقلة.
 */
export async function fetchApplicantCv(
  publicKey: string,
  applicantName: string,
  fetcher: Fetcher = globalThis.fetch,
): Promise<ApplicantCvDownload> {
  if (!CV_PUBLIC_KEY_RE.test(publicKey))
    throw new Error("معرّف ملف السيرة الذاتية غير صالح.");

  const response = await fetcher(
    `/api/hr/applicant-cv/${encodeURIComponent(publicKey)}`,
    {
      method: "GET",
      credentials: "same-origin",
      headers: {
        Accept: `${PDF_MIME}, ${DOCX_MIME}`,
      },
    },
  );
  if (!response.ok) throw responseError(response.status);

  const extension = downloadExtension(response.headers.get("Content-Type"));
  if (!extension)
    throw new Error("استجاب الخادم بنوع ملف غير مسموح للسيرة الذاتية.");

  const blob = await response.blob();
  if (blob.size < 1 || blob.size > MAX_CV_BYTES) {
    throw new Error("حجم ملف السيرة الذاتية المستلم غير صالح.");
  }

  return {
    blob,
    filename: `السيرة الذاتية - ${safeApplicantName(applicantName)}${extension}`,
  };
}

/** ينزّل Blob محلياً بعد اكتمال الجلب المصادَق، فلا يتعامل مدير التنزيل مع رابط الخادم. */
export async function downloadApplicantCv(
  publicKey: string,
  applicantName: string,
): Promise<void> {
  const file = await fetchApplicantCv(publicKey, applicantName);
  const objectUrl = URL.createObjectURL(file.blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = file.filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
