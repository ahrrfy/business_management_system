/**
 * قوالب Meta (Message Templates) — مركز واتساب الأعمال، S4 (T4.1).
 *
 * المَنطق: قَوالِب Cloud API هِي الوَسيلة الوَحيدة لِلإرسال خارِج نافِذة الردّ الحُرّ (٢٤ ساعة) — تَذكيرات
 * آجِلة/إشعارات جاهِزية/حَملات (T4.2/S5). syncTemplatesFromGraph تَسحَب القَوالِب المُسَجَّلة عَلى WABA
 * عَبر GET /{wabaId}/message_templates وَتُخَزّنها upsert في waTemplates (idempotent — إعادة التَشغيل
 * تُحَدّث لا تُكَرّر، المُطابَقة عَلى uq_wa_template_name_lang). getUsableTemplate تُرجِع القالِب فَقط
 * إِن كان APPROVED فِعلياً عِند Meta (لا نُرسِل بِقالِب مَرفوض/مُعَلَّق — يَرفضه Meta بِخَطأ دائم).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { channelIntegrations, waTemplates, type WaTemplate } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { decryptSecret } from "../cryptoService";
import { requireDb, withTx } from "../tx";
import { graphFetch, type GraphFetchResult } from "./graph";

// ── جلب التكامل النشط (accessToken مفكوك + wabaId + apiBaseUrl) ────────────────

export interface WaTemplateIntegration {
  accessToken: string;
  apiBaseUrl: string | null;
  wabaId: string | null;
}

function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decryptSecret(ciphertext);
  } catch {
    return null;
  }
}

/** يجلب تَكامُل واتساب ACTIVE لِفَرع مُعطى (accessToken مَفكوك + wabaId + apiBaseUrl) — null لَو لا
 *  تَكامُل ACTIVE أَو تَعذَّر فَكّ accessToken. يُستَهلَك مِن integrationRouter.syncTemplates. */
export async function getActiveWaTemplateIntegration(branchId: number): Promise<WaTemplateIntegration | null> {
  const db = getDb();
  if (!db) return null;
  const row = (
    await db
      .select({
        encAccess: channelIntegrations.encryptedAccessToken,
        wabaId: channelIntegrations.wabaId,
        apiBaseUrl: channelIntegrations.apiBaseUrl,
      })
      .from(channelIntegrations)
      .where(and(
        eq(channelIntegrations.branchId, branchId),
        eq(channelIntegrations.channel, "WHATSAPP"),
        eq(channelIntegrations.status, "ACTIVE"),
      ))
      .limit(1)
  )[0];
  if (!row) return null;
  const accessToken = safeDecrypt(row.encAccess);
  if (!accessToken) return null;
  return { accessToken, apiBaseUrl: row.apiBaseUrl ?? null, wabaId: row.wabaId ?? null };
}

// ── مزامنة القوالب من Graph API ─────────────────────────────────────────────────

type TemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";
type TemplateStatusValue = "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED";

const VALID_CATEGORY = new Set<string>(["MARKETING", "UTILITY", "AUTHENTICATION"]);
const VALID_STATUS = new Set<string>(["PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"]);

interface GraphTemplateComponent {
  type?: string;
  text?: string;
  [key: string]: unknown;
}
interface GraphTemplateRow {
  name?: string;
  language?: string;
  category?: string;
  status?: string;
  components?: GraphTemplateComponent[];
  quality_score?: { score?: string | null } | string | null;
}
interface GraphTemplatesResponse {
  data?: GraphTemplateRow[];
}

function normalizeCategory(v: string | undefined): TemplateCategory {
  return v && VALID_CATEGORY.has(v) ? (v as TemplateCategory) : "UTILITY";
}
function normalizeStatus(v: string | undefined): TemplateStatusValue {
  return v && VALID_STATUS.has(v) ? (v as TemplateStatusValue) : "PENDING";
}
/** جسم القالب (components[type=BODY].text) — النصّ الوحيد القابل للتعبئة (الرأس/التذييل/الأزرار
 *  خارج النطاق حالياً؛ componentsJson يحفظ البنية الكاملة لاستهلاك لاحق عند الحاجة). */
function extractBodyText(components: GraphTemplateComponent[] | undefined): string | null {
  const body = components?.find((c) => c.type === "BODY");
  return typeof body?.text === "string" ? body.text : null;
}
/** عدد {{n}} في نصّ الجسم — عدد المتغيّرات الواجب تعبئتها عند الإرسال (ليس تفرّدها، بل عدد الظهورات
 *  — Meta تفرض تسلسلاً {{1}}..{{n}} بلا تكرار عادةً، فالعدّ = عدد المتغيّرات فعلياً). */
function countVariables(bodyText: string | null): number {
  if (!bodyText) return 0;
  return (bodyText.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length;
}
function extractQualityScore(row: GraphTemplateRow): string | null {
  const q = row.quality_score;
  if (!q) return null;
  if (typeof q === "string") return q;
  return q.score ?? null;
}

export interface SyncTemplatesResult {
  synced: number;
  approved: number;
}

/**
 * يسحب قوالب حساب واتساب الأعمال (WABA) عبر Graph API ويُخزّنها upsert في waTemplates.
 * idempotent: نفس القالب (name+language) يُحدَّث لا يُكرَّر (uq_wa_template_name_lang).
 * fetchImpl قابل للحقن للاختبار (نمط graph.ts — افتراضياً fetch العام).
 */
export async function syncTemplatesFromGraph(
  integration: { accessToken: string; apiBaseUrl?: string | null; wabaId: string | null },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SyncTemplatesResult> {
  if (!integration.wabaId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "WABA ID غير مضبوط — أدخله في الإعدادات.",
    });
  }

  const res: GraphFetchResult = await graphFetch(
    integration,
    `/${encodeURIComponent(integration.wabaId)}/message_templates?limit=100`,
    { method: "GET" },
    fetchImpl,
  );
  if (!res.ok) {
    const body = res.body as { error?: { message?: string } } | null;
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `تعذّرت مزامنة القوالب من Meta (HTTP ${res.status}): ${body?.error?.message ?? "خطأ غير معروف"}`,
    });
  }

  const rows = ((res.body as GraphTemplatesResponse | null)?.data ?? []).filter(
    (r): r is GraphTemplateRow & { name: string; language: string } => !!r.name && !!r.language,
  );

  let approved = 0;
  await withTx(async (tx) => {
    for (const row of rows) {
      const category = normalizeCategory(row.category);
      const templateStatus = normalizeStatus(row.status);
      const bodyText = extractBodyText(row.components);
      const variableCount = countVariables(bodyText);
      const qualityScore = extractQualityScore(row);
      if (templateStatus === "APPROVED") approved += 1;

      const values = {
        name: row.name,
        language: row.language,
        category,
        templateStatus,
        bodyText,
        componentsJson: row.components ?? null,
        variableCount,
        qualityScore,
        syncedAt: new Date(),
      };
      await tx
        .insert(waTemplates)
        .values(values)
        .onDuplicateKeyUpdate({
          set: {
            category,
            templateStatus,
            bodyText,
            componentsJson: row.components ?? null,
            variableCount,
            qualityScore,
            syncedAt: new Date(),
          },
        });
    }
  });

  return { synced: rows.length, approved };
}

// ── قراءة القوالب (للعرض واختيار الإرسال) ───────────────────────────────────────

export interface ListTemplatesFilter {
  category?: TemplateCategory;
  statusFilter?: TemplateStatusValue;
}

/** يقرأ waTemplates (للعرض واختيار الإرسال في شاشة الحملات — T4.3/S5). أحدث مُزامَنة أولاً. */
export async function listTemplates(filter: ListTemplatesFilter = {}): Promise<WaTemplate[]> {
  const db = requireDb();
  const conditions = [
    filter.category ? eq(waTemplates.category, filter.category) : undefined,
    filter.statusFilter ? eq(waTemplates.templateStatus, filter.statusFilter) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c != null);
  return db
    .select()
    .from(waTemplates)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(waTemplates.updatedAt));
}

/** يعيد القالب فقط إن كان APPROVED فعلياً — للإرسال الآمن (T4.2/S5). أي حالة أخرى (بما فيها عدم
 *  الوجود) ⇒ null، لا رمي: المستدعي يقرّر البديل (رفض الإرسال/طابور انتظار اعتماد). */
export async function getUsableTemplate(name: string, language: string): Promise<WaTemplate | null> {
  const db = requireDb();
  const row = (
    await db
      .select()
      .from(waTemplates)
      .where(and(eq(waTemplates.name, name), eq(waTemplates.language, language)))
      .limit(1)
  )[0];
  if (!row || row.templateStatus !== "APPROVED") return null;
  return row;
}
