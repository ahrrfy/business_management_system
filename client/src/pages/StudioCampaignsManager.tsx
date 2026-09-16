/**
 * شاشة إدارة حملات استوديو المنتجات — مستقلّةٌ عن استوديو المنتجات نفسه.
 *
 * الحاجة (المالك ٢٨/٨): «لا أستطيع التحكم في الحملات — يجب أن أستطيع بشكل سلس إنشاء
 * حملة أو إيقافها أو اعتمادها». الأزرار كانت موجودةً كلَّها **داخل** استوديو المنتجات
 * (شاشةٌ من ٢٥٣٨ سطراً)، لا تظهر إلّا بعد اختيار الحملة من قائمةٍ منسدلةٍ ضمن قسمٍ داخليّ.
 * الاكتشافُ صفر. هذه الشاشة تضع كل الحملات في **جدولٍ واحد** بإجراءاتٍ داخل الصف.
 *
 * المسؤوليّات:
 *   • عرض كل حملات الاستوديو (مع فلترٍ بالحالة والاسم).
 *   • إجراءاتٌ داخل السطر: تفعيل · إيقاف مؤقّت · استئناف · إكمال · إلغاء.
 *   • ربطٌ ذكيّ لاستوديو المنتجات مع تحديد الحملة (`?campaign=<id>`) لعمق تحرير الفريق
 *     والمصوّرين المؤقّتين والطابور (يبقى مكانه الأنسب — بلوحاته البصريّة الكاملة).
 *
 * الحدود:
 *   • **لا نُنشئ حملة هنا** — لأنّ منشئ الحملة تسبقُه معاينةٌ (previewCampaignBacklog)
 *     وتتبعُه توليدٌ للطابور واختيارُ مصوّرين، وكلاهما وثيقُ الصلة بشاشة الاستوديو حيث
 *     يبدأ العمل الفعليّ فوراً. زرٌّ «إنشاء حملة» يوجّه هناك مع مرساة `#new-campaign`.
 *   • **لا Drawer تفاصيلٍ عميقة هنا** — تفاصيل الحملة (لوحة، مصوّرون، مؤشّرات) تبقى في
 *     الاستوديو حيث لها كل السياق. الشاشة هنا مركزُ **الحوكمة** لا الاستهلاك.
 */
import { Link } from "wouter";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSelect } from "@/components/ui/AppSelect";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";
import {
  STUDIO_CAMPAIGN_STATUS_AR,
  STUDIO_CAMPAIGN_STATUS_VARIANT,
  type StudioCampaignStatus,
} from "@shared/studioCampaignStatus";
import {
  AlertTriangle,
  CalendarPlus,
  CheckCircle2,
  ExternalLink,
  Filter,
  Loader2,
  PauseCircle,
  PlayCircle,
  Plus,
  Search,
  Users,
  UserSquare,
  XCircle,
} from "lucide-react";

type StatusFilter = "ALL" | StudioCampaignStatus;

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  ALL: "الكل",
  ...STUDIO_CAMPAIGN_STATUS_AR,
};

/**
 * وصفٌ لطيفٌ لنطاق الحملة — أوجزُ للعرض من `scopeKind` الخام.
 * `CATEGORIES` (متعدّد) مضافةٌ منذ هجرة 0269 مع `CATEGORY` (واحد) للتوافق.
 */
const SCOPE_LABEL: Record<string, string> = {
  ALL: "كل الكتالوج",
  CATEGORY: "فئة واحدة",
  CATEGORIES: "عدّة فئات",
  PRODUCTS: "منتجات مختارة",
};

/**
 * حالةُ ميقاتٍ صغيرة تُصنَّف نصّياً لتلوين العرض ولا تدخل في المنطق:
 *   • overdue  — تجاوز الآن، وحالةُ الحملة نشطة/موقوفة.
 *   • soon     — أقلّ من ٧ أيام. تنبيهٌ ناعمٌ للمدير.
 *   • ok       — آنٍ ومتّسع.
 * الحملة المكتملة/الملغاة لا تُعرَض هنا محتاجةً تصنيفاً — تظلّ رمادية.
 */
function classifyDueAt(dueAt: unknown, status: StudioCampaignStatus): "overdue" | "soon" | "ok" | "none" {
  if (dueAt == null) return "none";
  if (status === "COMPLETED" || status === "CANCELLED") return "none";
  const d = new Date(dueAt as string | Date).getTime();
  if (!Number.isFinite(d)) return "none";
  const diffMs = d - Date.now();
  const day = 86_400_000;
  if (diffMs < 0) return "overdue";
  if (diffMs < 7 * day) return "soon";
  return "ok";
}

/**
 * حفظ فلاتر الشاشة في localStorage (٢٩/٨، تناظر مع S13 في كاشف الفجوات):
 * حالة + فرع + بحث تُستعاد عند فتح الشاشة لاحقاً. المفتاح بنسخةٍ (v1) يتيح ترقيةً مستقبلية
 * بلا كسرِ مستخدمٍ يحمل شكلاً قديماً — رفضٌ صامتٌ + عودةٌ للافتراضيّ. Storage معطَّل
 * (Safari Private) يُعالَج بـtry/catch — لا كسرَ على مسارٍ غير حاسم.
 */
const CAMPAIGNS_FILTERS_KEY = "studio.campaigns-manager.filters.v1";
type PersistedCampaignFilters = { status: StatusFilter; branch: "ALL" | number; search: string };
const DEFAULT_CAMPAIGN_FILTERS: PersistedCampaignFilters = { status: "ALL", branch: "ALL", search: "" };

function loadPersistedCampaignFilters(): PersistedCampaignFilters {
  if (typeof window === "undefined") return DEFAULT_CAMPAIGN_FILTERS;
  try {
    const raw = window.localStorage.getItem(CAMPAIGNS_FILTERS_KEY);
    if (!raw) return DEFAULT_CAMPAIGN_FILTERS;
    const parsed = JSON.parse(raw) as Partial<PersistedCampaignFilters>;
    // تحقّقٌ ضيّق: `status` ضمن القيم المعروفة، `branch` رقمٌ أو "ALL"، `search` نصٌّ محدود.
    const status = typeof parsed.status === "string" && (parsed.status === "ALL" || parsed.status in STUDIO_CAMPAIGN_STATUS_AR) ? (parsed.status as StatusFilter) : DEFAULT_CAMPAIGN_FILTERS.status;
    const branch = parsed.branch === "ALL" || (typeof parsed.branch === "number" && Number.isSafeInteger(parsed.branch) && parsed.branch > 0) ? parsed.branch : DEFAULT_CAMPAIGN_FILTERS.branch;
    const search = typeof parsed.search === "string" ? parsed.search.slice(0, 80) : "";
    return { status, branch, search };
  } catch {
    return DEFAULT_CAMPAIGN_FILTERS;
  }
}

function persistCampaignFilters(filters: PersistedCampaignFilters): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CAMPAIGNS_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // تخطٍّ صامت — النقطة ليست حاسمة.
  }
}

export default function StudioCampaignsManager() {
  // ٢٩/٨ (تناظر مع S13 في كاشف الفجوات): فلاتر شاشة الإدارة تُحفَظ في localStorage كي
  // لا يُعيد المدير ضبطها كلّ زيارة. المفتاح بنسخةٍ (v1) يسمح ترقيةً لاحقة بلا كسر.
  const initialFilters = useMemo(() => loadPersistedCampaignFilters(), []);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialFilters.status);
  const [branchFilter, setBranchFilter] = useState<"ALL" | number>(initialFilters.branch);
  const [search, setSearch] = useState(initialFilters.search);
  useEffect(() => {
    persistCampaignFilters({ status: statusFilter, branch: branchFilter, search });
  }, [statusFilter, branchFilter, search]);
  const [cancelReason, setCancelReason] = useState<Record<number, string>>({});
  const [openReasonFor, setOpenReasonFor] = useState<number | null>(null);
  // ٢٩/٨ (بلاغ مالك: «ألغيت الحملات ولكن مازالت تظهر مهام مسندة»): خيار المدير الصريح
  // لإلغاء المهام المُسنَدة والقيدَ عملها مع الحملة — بلا هذا يبقى عمل الموظف قائماً
  // (السلوك التاريخيّ الآمن). القرار بحسب الحملة.
  const [cascadeAssigned, setCascadeAssigned] = useState<Record<number, boolean>>({});
  const utils = trpc.useUtils();

  // صلاحيّةُ المدير مطلوبةٌ لأداء الشاشة: كلّ mutations تُرفَض بـ`productStudioManagerProcedure`
  // إن حمّلها المدقّق/print_operator (مراجعة Codex P2). `dashboard.canManage` هو المصدر الوحيد
  // للحقيقة (يوسّع `isManager` بأدوارٍ مخصّصة وأعلام المالك) — نستعمله لتقييد الاستعلامات
  // وعرضِ رسالةٍ صريحةٍ لغير المدير بدلاً من شاشةٍ معطَّلة تُرجع FORBIDDEN عن كل زر.
  const dashboard = trpc.productStudio.dashboard.useQuery(undefined, { staleTime: 60_000 });
  const canManage = dashboard.data?.canManage === true;

  const campaigns = trpc.productStudio.campaigns.useQuery(undefined, {
    staleTime: 30_000,
    // `listStudioCampaigns` يرفض غير المدير/المدقّق — لا نستدعيه قبل معرفة الصلاحية.
    enabled: canManage,
  });
  // قائمة الفروع النشطة — تُستعمل لعرض اسم الفرع بدل «#N» ولفلترٍ يُعرَض حين يعبر
  // المستخدم الفروعَ (له حملاتٌ من فرعَين+). للمستخدم أحاديّ الفرع القائمة تكفيها
  // القيمة الوحيدة ⇒ لا فائدةَ في إظهار الفلتر.
  const branches = trpc.branches.list.useQuery(undefined, { staleTime: 5 * 60_000, enabled: canManage });
  const branchNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of branches.data ?? []) m.set(Number(b.id), b.name);
    return m;
  }, [branches.data]);
  const distinctCampaignBranches = useMemo(() => {
    const s = new Set<number>();
    for (const c of campaigns.data ?? []) s.add(Number(c.branchId));
    return Array.from(s);
  }, [campaigns.data]);
  const showBranchFilter = distinctCampaignBranches.length > 1;

  // إلغاءُ طابور حملةٍ تجاوزت العتبة (٥٠٠ مهمّة/معاملة) لا يكتمل في نداءٍ واحد. بعد
  // الانتقال إلى CANCELLED نفقد أزرارَ الإلغاء (الحالةُ نهائيّة) فتبقى الطابور المتبقّي
  // شاغلاً `activeSlot` وقابلاً للسحب بالباركود عبر `claimStudioProductByBarcode`
  // (يعمل على أيّ حالة — حرّاسه على المهمّة لا الحملة، فقد أضفنا حارس PAUSED صريحاً).
  // مراجعة Codex P1: الحلّ استكمالُ الإلغاء عبر `bulkCancelStudioBacklog` (يقبل أيّ حالة
  // للحملة) في حلقةٍ حتى `remaining === 0`. سقفُ عشرين محاولةٍ = ١٠٠٠٠ مهمّة، فوق سقف
  // `MAX_CAMPAIGN_PRODUCTS = 5000` — حمايةٌ من حلقةٍ لا تنتهي إن انكسر عقد التقلّص.
  const cancelBacklog = trpc.productStudio.cancelCampaignBacklog.useMutation();
  const finishCancellation = async (campaignId: number, seedReason: string, cascade: boolean) => {
    const clean = seedReason.trim().length >= 5 ? seedReason.trim() : "استكمال إلغاء طابور الحملة";
    let sweptExtra = 0;
    for (let i = 0; i < 20; i++) {
      // ٢٩/٨: cascade يُمرَّر إلى الـsweep حتى لا يتوقّف عند غير المسنَد بينما اختار المدير الحذف الكلّيّ.
      const res = await cancelBacklog.mutateAsync({ campaignId, reason: clean, cascadeAssigned: cascade });
      sweptExtra += res.cancelledCount;
      if (res.remaining === 0) return { swept: true, extra: sweptExtra };
    }
    return { swept: false, extra: sweptExtra };
  };

  // تمديدُ الموعد السريع للحملات المتأخّرة (٢٩/٨) — بدلاً من فتح محرّر التفاصيل في
  // الاستوديو، زرٌّ داخل السطر يستدعي `updateCampaignDetails` بموعدٍ = اليومَ + ٧ أيام
  // من الوقت الحاليّ. يبقى محرّر التفاصيل متاحاً لتعديلاتٍ أدقّ في الاستوديو.
  const updateDetails = trpc.productStudio.updateCampaignDetails.useMutation({
    onSuccess: async () => {
      notify.ok("مُدِّد الموعد ٧ أيام");
      await utils.productStudio.campaigns.invalidate();
    },
    onError: (err) => notify.err(err),
  });
  const extendDueBySevenDays = (campaignId: number) => {
    const next = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    updateDetails.mutate({ campaignId, dueAt: next });
  };

  const transition = trpc.productStudio.transitionCampaign.useMutation({
    onSuccess: async (result, variables) => {
      const status = result.status as StudioCampaignStatus;
      if (result.status === "CANCELLED" && result.remainingTasks > 0) {
        notify.info(`أُلغيت الحملة و${result.cancelledTasks} مهمة — جارٍ إتمام ${result.remainingTasks}+ متبقّية…`);
        try {
          const done = await finishCancellation(variables.campaignId, variables.reason ?? "", variables.cascadeAssignedTasks === true);
          notify.ok(
            done.swept
              ? `اكتمل إلغاء الحملة — ${result.cancelledTasks + done.extra} مهمّة`
              : `أُلغي ${result.cancelledTasks + done.extra} مهمّة؛ تبقّى المزيد — أعد المحاولة`,
          );
        } catch (e) {
          notify.err(e);
        }
      } else {
        notify.ok(
          result.status === "CANCELLED"
            ? `أُلغيت الحملة و${result.cancelledTasks} مهمة من طابورها`
            : `تحوّلت الحملة إلى ${STUDIO_CAMPAIGN_STATUS_AR[status]}`,
        );
      }
      await utils.productStudio.campaigns.invalidate();
    },
    onError: (err) => notify.err(err),
  });

  const filtered = useMemo(() => {
    const rows = campaigns.data ?? [];
    const q = search.trim().toLowerCase();
    return rows.filter((c) => {
      if (statusFilter !== "ALL" && c.status !== statusFilter) return false;
      if (branchFilter !== "ALL" && Number(c.branchId) !== branchFilter) return false;
      if (q && !c.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [campaigns.data, statusFilter, branchFilter, search]);

  // إحصاءٌ سريع لكل حالة — يُبرز حجم الحملات النشطة/المُوقَفة في الشريط العلويّ بلا فتح جدول.
  const statusCounts = useMemo(() => {
    const rows = campaigns.data ?? [];
    const acc: Record<StudioCampaignStatus, number> = { DRAFT: 0, ACTIVE: 0, PAUSED: 0, COMPLETED: 0, CANCELLED: 0 };
    for (const c of rows) acc[c.status as StudioCampaignStatus] = (acc[c.status as StudioCampaignStatus] ?? 0) + 1;
    return acc;
  }, [campaigns.data]);

  // حملاتٌ تجاوزت موعد الاستحقاق وما زالت نشطة/موقوفة — تحتاج قراراً إدارياً: إمّا
  // تمديدُ الموعد أو الإكمال/الإلغاء. تُبرَز في شريطٍ منفصلٍ فوق الجدول لأنّ اكتشافها
  // بالبحث في العمود الرمادي ضئيلٌ حتى مع تلوين السطر.
  const overdueCampaigns = useMemo(() => {
    return (campaigns.data ?? []).filter((c) => classifyDueAt(c.dueAt, c.status as StudioCampaignStatus) === "overdue");
  }, [campaigns.data]);

  // النوع مضيَّق: DRAFT حالةُ ابتداءٍ فقط لا هدفٌ للانتقال — الخادم يقبل الأربعة فقط.
  const runTransition = (campaignId: number, status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED", reason?: string, cascade?: boolean) => {
    transition.mutate({ campaignId, status, ...(reason ? { reason } : {}), ...(cascade === true ? { cascadeAssignedTasks: true } : {}) });
  };

  // بوّابةُ صلاحيّة صريحة قبل الرَندر: `StudioRouteAccess` يفتح للمدقّق وprint_operator
  // (READ)، لكنّ كلّ إجراءٍ هنا mutation يحتاج FULL. عرضُ الشاشة كاملةً لهم يخدعهم بأزرارٍ
  // تفشل بـFORBIDDEN عند النقر (مراجعة Codex P2). الرسالة صريحةٌ وتُرجع القراءة إلى مكانها
  // الطبيعيّ (الاستوديو نفسه) بلا فقدان الوصول.
  if (dashboard.data && !canManage) {
    return (
      <div className="space-y-4">
        <PageHeader title="إدارة حملات التصوير" backHref="/catalog/image-studio" backLabel="استوديو المنتجات" />
        <Card>
          <CardContent className="space-y-2 p-6 text-center">
            <p className="text-sm font-medium">هذه الشاشة لإدارة الحملات — تحتاج صلاحيّة كاملة على وحدة استوديو المنتجات</p>
            <p className="text-xs text-muted-foreground">للقراءة والاستعراض توجّه إلى استوديو المنتجات — تجد فيه لوحات الحملة وطابورها.</p>
            <Button asChild variant="outline" className="mt-2 min-h-11">
              <Link href="/catalog/image-studio">فتح استوديو المنتجات</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="إدارة حملات التصوير"
        backHref="/catalog/image-studio"
        backLabel="استوديو المنتجات"
        actions={
          <Button asChild className="min-h-11">
            <Link href="/catalog/image-studio#new-campaign">
              <Plus aria-hidden className="size-4" /> إنشاء حملة جديدة
            </Link>
          </Button>
        }
      />

      {/* تنبيه الحملات المتأخّرة — يظهر فقط حين يوجد ما يستحقّ قراراً. نقرةٌ عليه
          تُصفّي الجدول على المتأخّرة (statusFilter=ACTIVE، وترتيبُ الجدول يبرزها).
          يستخدم `--sem-neg` كي يتّسق مع تلوين السطر ووسم «متأخّرة». */}
      {overdueCampaigns.length > 0 && (
        <button
          type="button"
          onClick={() => setStatusFilter("ACTIVE")}
          className="flex w-full items-center justify-between gap-3 rounded-md border border-[var(--sem-neg)]/40 bg-[var(--sem-neg)]/5 p-3 text-start transition-colors hover:bg-[var(--sem-neg)]/10"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-[var(--sem-neg)]">
            <AlertTriangle aria-hidden className="size-4" />
            {overdueCampaigns.length === 1
              ? "حملةٌ واحدة تجاوزت موعد الاستحقاق"
              : `${overdueCampaigns.length} حملات تجاوزت موعد الاستحقاق`}
          </span>
          <span className="text-xs text-muted-foreground">
            انقر لتصفية الجدول · مدِّد الموعد أو أكمل أو ألغِ
          </span>
        </button>
      )}

      {/* شريط عدّادات بالحالة — كثيفٌ (text-base) لأنّه بيانُ سياقٍ لا رأس شاشة. */}
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {(Object.keys(STUDIO_CAMPAIGN_STATUS_AR) as StudioCampaignStatus[]).map((s) => {
          const active = statusFilter === s;
          return (
            <button
              key={s}
              type="button"
              className={`min-h-11 rounded-md border p-2 text-start transition-colors ${active ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
              onClick={() => setStatusFilter(active ? "ALL" : s)}
              title={`تصفية بحالة ${STUDIO_CAMPAIGN_STATUS_AR[s]}`}
            >
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Badge variant={STUDIO_CAMPAIGN_STATUS_VARIANT[s]} className="px-1.5 py-0">
                  {STUDIO_CAMPAIGN_STATUS_AR[s]}
                </Badge>
              </div>
              <div className="mt-0.5 text-base font-bold">{statusCounts[s] ?? 0}</div>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
            <Filter aria-hidden className="size-4" /> الحملات ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className={`grid gap-2 ${showBranchFilter ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
            <div className="space-y-1.5">
              <Label htmlFor="campaigns-search">بحث باسم الحملة</Label>
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute end-2 top-3 size-4 text-muted-foreground" />
                <Input id="campaigns-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="اكتب جزءاً من الاسم" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campaigns-status">الحالة</Label>
              <AppSelect id="campaigns-status" value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                {(Object.keys(STATUS_FILTER_LABELS) as StatusFilter[]).map((k) => (
                  <option key={k} value={k}>{STATUS_FILTER_LABELS[k]}</option>
                ))}
              </AppSelect>
            </div>
            {/* فلترُ الفرع يظهر لمن يعبر الفروع فعلاً — قائمةٌ فيها فرعان+ من الحملات
                القائمة. للمستخدم أحاديّ الفرع يبقى الحقلُ مخفياً بلا ضجيج. */}
            {showBranchFilter && (
              <div className="space-y-1.5">
                <Label htmlFor="campaigns-branch">الفرع</Label>
                <AppSelect
                  id="campaigns-branch"
                  value={branchFilter === "ALL" ? "ALL" : String(branchFilter)}
                  onValueChange={(v) => setBranchFilter(v === "ALL" ? "ALL" : Number(v))}
                >
                  <option value="ALL">كل الفروع</option>
                  {distinctCampaignBranches.map((bid) => (
                    <option key={bid} value={String(bid)}>{branchNameById.get(bid) ?? `فرع #${bid}`}</option>
                  ))}
                </AppSelect>
              </div>
            )}
          </div>

          {campaigns.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">{ACTION_LABELS.loading}</p>}
          {campaigns.isError && <p role="alert" className="text-sm text-destructive">تعذّر جلب الحملات — أعد المحاولة.</p>}
          {!campaigns.isLoading && filtered.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              لا حملاتٍ بهذه الفلاتر —{" "}
              <Link href="/catalog/image-studio#new-campaign" className="underline underline-offset-2">أنشئ حملةً جديدة</Link>.
            </p>
          )}

          {filtered.length > 0 && (
            <ul className="space-y-2">
              {filtered.map((c) => {
                const status = c.status as StudioCampaignStatus;
                const isMutating = transition.isPending && transition.variables?.campaignId === Number(c.id);
                const reason = cancelReason[Number(c.id)] ?? "";
                const reasonOpen = openReasonFor === Number(c.id);
                const branchName = branchNameById.get(Number(c.branchId)) ?? `فرع #${c.branchId}`;
                const dueClass = classifyDueAt(c.dueAt, status);
                const dueColor =
                  dueClass === "overdue"
                    ? "text-[var(--sem-neg)] font-semibold"
                    : dueClass === "soon"
                      ? "text-[var(--sem-warn)]"
                      : "text-muted-foreground";
                return (
                  <li key={Number(c.id)} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 truncate text-sm font-semibold">{c.name}</span>
                          <Badge variant={STUDIO_CAMPAIGN_STATUS_VARIANT[status]}>{STUDIO_CAMPAIGN_STATUS_AR[status]}</Badge>
                          {c.requiredImages > 1 && (
                            <Badge variant="outline" className="text-[10px]">{c.requiredImages} صور مطلوبة</Badge>
                          )}
                          {dueClass === "overdue" && <Badge variant="danger" className="text-[10px]">متأخّرة</Badge>}
                        </div>
                        <p className="flex flex-wrap items-center gap-1 text-xs">
                          <span className="text-muted-foreground">
                            {branchName} · نطاق: {SCOPE_LABEL[c.scopeKind as string] ?? c.scopeKind}
                          </span>
                          {c.dueAt && (
                            <span className={dueColor}>
                              {" · "}
                              {dueClass === "overdue" ? "انتهت" : dueClass === "soon" ? "تنتهي" : "ينتهي"}{" "}
                              {new Date(c.dueAt as unknown as string | Date).toLocaleDateString("ar-IQ-u-nu-latn")}
                            </span>
                          )}
                        </p>
                        {/* الملكيّة والفريق (٢٩/٨): اسمُ المُنشئ + عدد المصوّرين — يكشفان
                            بلمحةٍ من صاحبُ الحملة ومن يعمل فيها بلا فتح تفاصيل الاستوديو.
                            صفرُ مصوّرين حالةٌ حقيقيّة (طابور محفوظ لكن بلا فريق) — تُبرَز
                            بشارةٍ تحذيرية لأنّ المصوّر لن يستطيع سحب مسحاً جديداً بلا عضوية. */}
                        <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          {c.createdByName && (
                            <span className="inline-flex items-center gap-1">
                              <UserSquare aria-hidden className="size-3" /> {c.createdByName}
                            </span>
                          )}
                          <span className={`inline-flex items-center gap-1 ${Number(c.assigneeCount ?? 0) === 0 && (status === "ACTIVE" || status === "DRAFT") ? "text-[var(--sem-warn)] font-medium" : ""}`}>
                            <Users aria-hidden className="size-3" /> {Number(c.assigneeCount ?? 0)} مصوّر
                            {Number(c.assigneeCount ?? 0) === 0 && (status === "ACTIVE" || status === "DRAFT") ? " — أضِف فريقاً" : ""}
                          </span>
                        </p>
                      </div>

                      <div className="flex shrink-0 flex-wrap gap-1.5">
                        {status === "DRAFT" && (
                          <Button size="sm" className="min-h-9" disabled={isMutating} onClick={() => runTransition(Number(c.id), "ACTIVE")}>
                            <PlayCircle aria-hidden className="size-4" /> تفعيل
                          </Button>
                        )}
                        {status === "ACTIVE" && (
                          <Button size="sm" variant="outline" className="min-h-9" disabled={isMutating} onClick={() => runTransition(Number(c.id), "PAUSED")} title="تجميد ذكيّ — المهام المُسنَدة تبقى قابلةً للإتمام">
                            <PauseCircle aria-hidden className="size-4" /> إيقاف مؤقّت
                          </Button>
                        )}
                        {status === "PAUSED" && (
                          <Button size="sm" className="min-h-9" disabled={isMutating} onClick={() => runTransition(Number(c.id), "ACTIVE")}>
                            <PlayCircle aria-hidden className="size-4" /> استئناف
                          </Button>
                        )}
                        {(status === "ACTIVE" || status === "PAUSED") && (
                          <Button size="sm" variant="outline" className="min-h-9" disabled={isMutating} onClick={() => runTransition(Number(c.id), "COMPLETED")}>
                            <CheckCircle2 aria-hidden className="size-4" /> إكمال
                          </Button>
                        )}
                        {/* «+٧ أيام» للحملات المتأخّرة (٢٩/٨) — بدلاً من فتح محرّر
                            التفاصيل في الاستوديو، تمديدٌ سريع بضغطةٍ واحدة إلى وقتنا+٧د. */}
                        {dueClass === "overdue" && (status === "ACTIVE" || status === "PAUSED") && (
                          <Button size="sm" variant="outline" className="min-h-9" disabled={updateDetails.isPending} onClick={() => extendDueBySevenDays(Number(c.id))} title="مدِّد موعد الاستحقاق 7 أيام من الآن">
                            <CalendarPlus aria-hidden className="size-4" /> +7 أيام
                          </Button>
                        )}
                        {(status === "DRAFT" || status === "ACTIVE" || status === "PAUSED") && (
                          <Button size="sm" variant="outline" className="min-h-9" onClick={() => setOpenReasonFor((cur) => (cur === Number(c.id) ? null : Number(c.id)))}>
                            <XCircle aria-hidden className="size-4" /> {reasonOpen ? "إخفاء الإلغاء" : "إلغاء"}
                          </Button>
                        )}
                        <Button asChild size="sm" variant="ghost" className="min-h-9" title="فتح الحملة في الاستوديو (تحرير الفريق والطابور والمؤشّرات)">
                          <Link href={`/catalog/image-studio?campaign=${Number(c.id)}`}>
                            <ExternalLink aria-hidden className="size-4" /> تفاصيل
                          </Link>
                        </Button>
                        {isMutating && <Loader2 aria-hidden className="size-4 animate-spin self-center" />}
                      </div>
                    </div>

                    {reasonOpen && (status === "DRAFT" || status === "ACTIVE" || status === "PAUSED") && (
                      <div className="mt-3 space-y-2 rounded-md border bg-muted/20 p-3">
                        <Label htmlFor={`cancel-reason-${c.id}`} className="text-xs">
                          سبب الإلغاء (≥ ٥ أحرف) — يُنسَخ على كل مهمة طابور تُلغى مع الحملة
                        </Label>
                        <Textarea
                          id={`cancel-reason-${c.id}`}
                          rows={2}
                          value={reason}
                          onChange={(e) => setCancelReason((cur) => ({ ...cur, [Number(c.id)]: e.target.value }))}
                          placeholder="مثال: تغيّر خطّة التصوير — أُلغيت الحملة لصالح حملةٍ أوسع"
                        />
                        {/* ٢٩/٨ (بلاغ مالك): خيار إلغاء المهام المسنَدة والقيدَ عملها أيضاً.
                            الافتراضيّ مُعطَّل كي لا يمحوَ عملَ الموظف بالخطأ — تفعيلٌ صريح. */}
                        <label className="flex items-start gap-2 rounded border border-dashed border-[var(--sem-warn)]/40 bg-[var(--sem-warn)]/5 p-2 text-xs">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 shrink-0"
                            checked={cascadeAssigned[Number(c.id)] === true}
                            onChange={(e) => setCascadeAssigned((cur) => ({ ...cur, [Number(c.id)]: e.target.checked }))}
                          />
                          <span>
                            <span className="font-medium text-[var(--sem-warn)]">أَلغِ المهام المسنَدة والقيدَ عملها أيضاً</span>
                            <span className="block text-[10.5px] text-muted-foreground">
                              افتراضياً يُلغى الطابور غير المسنَد فقط، ويبقى عمل الموظف قابلاً للإتمام. فعِّل هذا الخيار إن أردتَ إلغاءَ الحملة كلّياً بلا استثناء (لا رجعة، تشمل PENDING_REVIEW).
                            </span>
                          </span>
                        </label>
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" className="min-h-9" onClick={() => setOpenReasonFor(null)}>
                            إلغاء
                          </Button>
                          <Button
                            size="sm"
                            className="min-h-9"
                            disabled={isMutating || reason.trim().length < 5}
                            onClick={() => {
                              runTransition(Number(c.id), "CANCELLED", reason.trim(), cascadeAssigned[Number(c.id)] === true);
                              setOpenReasonFor(null);
                            }}
                          >
                            تأكيد الإلغاء
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
