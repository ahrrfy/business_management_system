/**
 * شاشة التوظيف — مسار المتقدّمين (Kanban) مجمَّعاً حسب المرحلة.
 * مساران للتقديم: رابط خارجي عام (/apply) يملؤه المتقدّم، أو استمارة ورقية يُدخلها الموظف.
 * بطاقة كل متقدّم: الاسم، الوظيفة، شارة المصدر، نجوم التقييم، الهاتف، وزر الانتقال للمرحلة التالية.
 */
import { Badge } from "@/components/ui/badge";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InfoField, InfoGrid } from "@/components/data-display/InfoGrid";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/PageState";
import { confirm, confirmDelete } from "@/lib/confirm";
import { Input } from "@/components/ui/input";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmpAvatar } from "@/lib/hr/ui";
import { exportRows } from "@/lib/export";
import { downloadApplicantCv } from "@/lib/applicantCvDownload";
import { fmtDate } from "@/lib/date";
import { notify } from "@/lib/notify";
import { careersUrl } from "@/lib/siteHosts";
import { trpc } from "@/lib/trpc";
import { APPLICANT_SOURCES, APPLICANT_STAGES, EMPLOYMENT_TYPES, HR_DEPARTMENTS, applicantSourceLabel, applicantStageLabel, employmentTypeLabel, vacancyAccent, type ApplicantStage } from "@shared/hr";
import { Briefcase, ChevronLeft, ChevronRight, Copy, Download, Eye, ExternalLink, FileSpreadsheet, FileText, GraduationCap, GripVertical, Image as ImageIcon, Link as LinkIcon, Mail, MapPin, Pencil, Phone, Plus, Star, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { selectClsSm } from "@/lib/ui/formStyles";
import { ACTION_LABELS } from "@shared/actionLabels";

const STAGE_COLOR: Record<string, string> = {
  new: "var(--status-pending)",
  review: "var(--stock-low)",
  interview: "var(--chart-check)",
  accepted: "var(--money-positive)",
  rejected: "var(--money-negative)",
  archived: "var(--muted-foreground)",
};

const PIPELINE_STAGES: ApplicantStage[] = ["new", "review", "interview", "accepted"];

function adjacentStage(stage: ApplicantStage, direction: "previous" | "next"): ApplicantStage | null {
  // الحالات النهائية لا تحمل تاريخاً للمرحلة السابقة؛ زر الإرجاع يعيدها للمراجعة،
  // بينما السحب يسمح باختيار المرحلة الدقيقة المطلوبة.
  if (stage === "rejected" || stage === "archived") return direction === "previous" ? "review" : null;
  const index = PIPELINE_STAGES.indexOf(stage);
  const target = direction === "previous" ? index - 1 : index + 1;
  return PIPELINE_STAGES[target] ?? null;
}

type Applicant = {
  id: number;
  name: string;
  jobTitle: string | null;
  source: string;
  stage: ApplicantStage;
  phone: string | null;
  rating: number | null;
  cvFileKey: string | null;
};

function Stars({ rating }: { rating: number | null }) {
  const r = rating ?? 0;
  if (r <= 0) return <span className="text-muted-foreground text-[11px]">—</span>;
  return (
    <span className="inline-flex items-center text-[var(--sem-warn)]" aria-label={`${r} نجوم`}>
      {Array.from({ length: r }, (_, k) => (
        <Star key={k} className="size-3" style={{ fill: "currentColor" }} />
      ))}
    </span>
  );
}

/**
 * رابط معرض الوظائف الذي يُشارَك مع المتقدّمين — **الدومين العام** (alarabiya.online) لا دومين
 * الشركة: صفحة التقديم خدمة عامة للناس (سياسة الدومينَين). كان يُبنى من `window.location.origin`
 * فيُنسَخ رابطُ نظامٍ داخليّ ويُنشر في إعلانات التوظيف.
 */
const PUBLIC_PATH = "/apply";

export default function Recruitment() {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState("vacancies");
  const [stage, setStage] = useState("");
  const [source, setSource] = useState("");
  const [vacancyFilter, setVacancyFilter] = useState("");
  const [q, setQ] = useState("");
  const [paperOpen, setPaperOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [draggedApplicantId, setDraggedApplicantId] = useState<number | null>(null);
  const [dropStage, setDropStage] = useState<ApplicantStage | null>(null);

  const vacancyOptsQ = trpc.recruitment.vacancyList.useQuery();

  const input = useMemo(
    () => ({
      stage: (stage || undefined) as never,
      source: (source || undefined) as never,
      q: q.trim() || undefined,
      vacancyId: vacancyFilter ? Number(vacancyFilter) : undefined,
    }),
    [stage, source, q, vacancyFilter],
  );
  const list = trpc.recruitment.list.useQuery(input);
  const rows = (list.data ?? []) as Applicant[];

  function exportApplicants() {
    exportRows(rows, {
      filename: "المتقدّمون",
      columns: [
        { key: "name", header: "الاسم" },
        { key: "jobTitle", header: "الوظيفة", map: (r) => r.jobTitle ?? "" },
        {
          key: "source",
          header: "المصدر",
          map: (r) => applicantSourceLabel(r.source),
        },
        {
          key: "stage",
          header: "المرحلة",
          map: (r) => applicantStageLabel(r.stage),
        },
        { key: "phone", header: "الهاتف", map: (r) => r.phone ?? "" },
        { key: "rating", header: "التقييم", map: (r) => r.rating ?? 0 },
      ],
    });
  }

  const publicUrl = careersUrl();

  const externalCount = rows.filter((a) => a.source === "external").length;
  const paperCount = rows.filter((a) => a.source === "paper" || a.source === "archive").length;

  const move = trpc.recruitment.updateStage.useMutation({
    onSuccess: () => {
      notify.ok("نُقل المتقدّم");
      void utils.recruitment.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  async function moveApplicantTo(applicant: Applicant, targetStage: ApplicantStage) {
    if (applicant.stage === targetStage || move.isPending) return;
    if (targetStage === "rejected" || targetStage === "archived") {
      const approved = await confirm({
        variant: "warning",
        title: targetStage === "rejected" ? "رفض المتقدّم" : "أرشفة المتقدّم",
        description: `نقل المتقدّم «${applicant.name}» إلى مرحلة «${applicantStageLabel(targetStage)}»؟`,
        confirmText: targetStage === "rejected" ? "رفض" : "أرشفة",
      });
      if (!approved) return;
    }
    move.mutate({ id: applicant.id, stage: targetStage });
  }

  function copyLink() {
    navigator.clipboard
      ?.writeText(publicUrl)
      .then(() => notify.ok("نُسخ رابط التقديم"))
      .catch(() => notify.err("تعذّر النسخ"));
  }

  return (
    <div className="space-y-4">
      <PageHeader title="التوظيف" description="أعلِن الوظائف الشاغرة على المعرض العام، وتابِع المتقدّمين عبر مسار المراحل." />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="vacancies">
            <Briefcase className="size-4 me-1.5" /> الوظائف الشاغرة
          </TabsTrigger>
          <TabsTrigger value="applicants">
            <Users className="size-4 me-1.5" /> المتقدّمون
          </TabsTrigger>
        </TabsList>

        <TabsContent value="vacancies" className="mt-4">
          <VacanciesTab publicUrl={publicUrl} />
        </TabsContent>

        <TabsContent value="applicants" className="mt-4 space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setPaperOpen(true)}>
              <Plus className="size-4" /> متقدّم (استمارة ورقية)
            </Button>
          </div>

          {/* المساران: الرابط الخارجي + الاستمارة الورقية */}
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <span className="text-primary">
                    <LinkIcon className="size-5" />
                  </span>
                  <h3 className="font-semibold">التقديم عبر الرابط الخارجي</h3>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5 leading-6">شارك الرابط العام مع المتقدّمين. يملأ المتقدّم استمارة كاملة، فيصل طلبه مباشرة إلى مسار التوظيف (مرحلة «جديد») للمراجعة والمقابلة أو الأرشفة.</p>
                <div className="flex items-center gap-2 mt-3">
                  <input readOnly value={publicUrl} dir="ltr" className="flex-1 h-8 rounded-md border border-input bg-muted px-2.5 text-xs tabular-nums font-mono" aria-label="رابط التقديم العام" />
                  <Button size="sm" variant="outline" onClick={copyLink}>
                    <Copy className="size-3.5" /> نسخ
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="size-3.5" /> فتح
                    </a>
                  </Button>
                </div>
                <div className="text-[11px] text-muted-foreground mt-2 tabular-nums" dir="rtl">
                  {externalCount} طلب وصل عبر الرابط
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <span className="text-primary">
                    <FileText className="size-5" />
                  </span>
                  <h3 className="font-semibold">الاستمارة الورقية</h3>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5 leading-6">يملأ المتقدّم استمارة ورقية يدوياً، ويُدخلها الموظف المختص لاحقاً إلى النظام، أو تُحفظ في الأرشيف للرجوع إليها عند الحاجة.</p>
                <div className="flex gap-2 mt-3">
                  <Button size="sm" onClick={() => setPaperOpen(true)}>
                    <Plus className="size-3.5" /> إدخال استمارة ورقية
                  </Button>
                </div>
                <div className="text-[11px] text-muted-foreground mt-3 tabular-nums" dir="rtl">
                  {paperCount} استمارة ورقية/مؤرشفة
                </div>
              </CardContent>
            </Card>
          </div>

          {/* الفلاتر */}
          <Card>
            <CardContent className="py-3 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground me-1">
                <Users className="size-4" /> المتقدّمون
                <span className="tabular-nums">({rows.length})</span>
              </div>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث (اسم/وظيفة/هاتف/بريد)" className={selectClsSm + " w-56"} aria-label="بحث" />
              <AppSelect className="h-9" value={stage} onValueChange={(next) => setStage(next)} aria-label="المرحلة">
                <option value="">كل المراحل</option>
                {APPLICANT_STAGES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </AppSelect>
              <AppSelect className="h-9" value={source} onValueChange={(next) => setSource(next)} aria-label="المصدر">
                <option value="">كل المصادر</option>
                {APPLICANT_SOURCES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </AppSelect>
              <AppSelect className="h-9" value={vacancyFilter} onValueChange={(next) => setVacancyFilter(next)} aria-label="الوظيفة">
                <option value="">كل الوظائف</option>
                {(vacancyOptsQ.data ?? []).map((v) => (
                  <option key={v.id} value={String(v.id)}>
                    {v.title}
                  </option>
                ))}
              </AppSelect>
              <Button size="sm" variant="outline" className="ms-auto" disabled={!rows.length} onClick={exportApplicants}>
                <FileSpreadsheet className="size-3.5" /> تصدير Excel
              </Button>
            </CardContent>
          </Card>

          {list.isError && <ErrorState message="تعذّر تحميل المتقدّمين." onRetry={() => list.refetch()} />}

          {/* مسار المتقدّمين (Kanban): السحب للفأرة + أزرار صريحة للمس/لوحة المفاتيح. */}
          <div className="space-y-2">
            <p className="text-xs leading-5 text-muted-foreground">اسحب بطاقة المتقدّم إلى المرحلة المطلوبة، أو استخدم زري «السابق» و«التالي» داخل البطاقة.</p>
            <div className="overflow-x-auto pb-2">
              <div className="grid min-w-[1560px] grid-cols-6 gap-3">
                {APPLICANT_STAGES.map((st) => {
                  const targetStage = st.key;
                  const items = rows.filter((a) => a.stage === targetStage);
                  const color = STAGE_COLOR[targetStage] ?? "#64748b";
                  const isDropTarget = draggedApplicantId != null && dropStage === targetStage;
                  return (
                    <section
                      key={targetStage}
                      aria-label={`مرحلة ${st.label}`}
                      onDragOver={(event) => {
                        if (draggedApplicantId == null) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDropStage(targetStage);
                      }}
                      onDragLeave={(event) => {
                        const nextTarget = event.relatedTarget;
                        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setDropStage((current) => (current === targetStage ? null : current));
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const transferredId = Number(event.dataTransfer.getData("text/plain"));
                        const applicantId = Number.isInteger(transferredId) && transferredId > 0 ? transferredId : draggedApplicantId;
                        const applicant = rows.find((row) => row.id === applicantId);
                        setDraggedApplicantId(null);
                        setDropStage(null);
                        if (applicant) void moveApplicantTo(applicant, targetStage);
                      }}
                      className={`min-h-52 rounded-lg border p-3 transition-colors ${isDropTarget ? "border-primary bg-primary/5" : "border-transparent bg-muted/40"}`}
                    >
                      <div className="mb-3 flex items-center justify-between px-0.5">
                        <div className="flex items-center gap-2">
                          <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
                          <span className="text-sm font-semibold">{st.label}</span>
                        </div>
                        <Badge variant="outline" className="h-6 min-w-6 justify-center px-1.5 tabular-nums">{items.length}</Badge>
                      </div>
                      <div className="space-y-2.5">
                        {items.map((a) => {
                          const previous = adjacentStage(a.stage, "previous");
                          const next = adjacentStage(a.stage, "next");
                          const isDragging = draggedApplicantId === a.id;
                          return (
                            <article
                              key={a.id}
                              draggable={!move.isPending}
                              onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", String(a.id));
                                setDraggedApplicantId(a.id);
                              }}
                              onDragEnd={() => {
                                setDraggedApplicantId(null);
                                setDropStage(null);
                              }}
                              className={`rounded-lg border border-border bg-card p-3 transition-[opacity,box-shadow] hover:shadow-sm ${isDragging ? "opacity-50" : "opacity-100"}`}
                            >
                              <div className="flex items-start gap-2.5">
                                <GripVertical aria-hidden className="mt-1 size-4 shrink-0 cursor-grab text-muted-foreground" />
                                <EmpAvatar name={a.name} color={color} sizePx={34} />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-semibold">{a.name}</div>
                                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{a.jobTitle || "تقديم عام"}</div>
                                </div>
                                <button type="button" onClick={() => setDetailId(a.id)} className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`تفاصيل ${a.name}`} title="عرض التفاصيل">
                                  <Eye className="size-4" />
                                </button>
                              </div>
                              <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                <span className="inline-flex min-w-0 items-center gap-1.5">
                                  {a.source === "external" ? <LinkIcon className="size-3.5 shrink-0" /> : <FileText className="size-3.5 shrink-0" />}
                                  <span className="truncate">{applicantSourceLabel(a.source)}</span>
                                </span>
                                <Stars rating={a.rating} />
                              </div>
                              {a.phone && (
                                <a href={`tel:${a.phone}`} className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-primary" dir="ltr">
                                  <Phone className="size-3.5 shrink-0" />
                                  <span className="tabular-nums">{a.phone}</span>
                                </a>
                              )}
                              {(previous || next) && (
                                <div className="mt-3 flex gap-2">
                                  {previous && (
                                    <Button size="sm" variant="outline" className="h-8 flex-1 px-2 text-xs" disabled={move.isPending} onClick={() => void moveApplicantTo(a, previous)} title={`نقل إلى ${applicantStageLabel(previous)}`}>
                                      <ChevronRight className="size-3.5" />
                                      {a.stage === "rejected" || a.stage === "archived" ? "إرجاع للمراجعة" : "السابق"}
                                    </Button>
                                  )}
                                  {next && (
                                    <Button size="sm" variant="outline" className="h-8 flex-1 px-2 text-xs" disabled={move.isPending} onClick={() => void moveApplicantTo(a, next)} title={`نقل إلى ${applicantStageLabel(next)}`}>
                                      {applicantStageLabel(next)} <ChevronLeft className="size-3.5" />
                                    </Button>
                                  )}
                                </div>
                              )}
                              {a.stage !== "rejected" && a.stage !== "archived" && (
                                <div className="mt-2 flex gap-2 border-t pt-2">
                                  <Button size="sm" variant="ghost" className="h-7 flex-1 text-xs text-destructive" disabled={move.isPending} onClick={() => void moveApplicantTo(a, "rejected")}>رفض</Button>
                                  <Button size="sm" variant="ghost" className="h-7 flex-1 text-xs text-muted-foreground" disabled={move.isPending} onClick={() => void moveApplicantTo(a, "archived")}>أرشفة</Button>
                                </div>
                              )}
                            </article>
                          );
                        })}
                        {items.length === 0 && (
                          <div className={`rounded-md border border-dashed px-3 py-8 text-center text-xs ${isDropTarget ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
                            {isDropTarget ? `أفلت هنا للنقل إلى «${st.label}»` : "لا طلبات"}
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          </div>

          <PaperDialog open={paperOpen} onClose={() => setPaperOpen(false)} onSaved={() => void utils.recruitment.list.invalidate()} />
          <ApplicantDetailDialog id={detailId} onClose={() => setDetailId(null)} vacancies={vacancyOptsQ.data ?? []} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ====================== حوار تفاصيل المتقدّم ====================== */
function ApplicantDetailDialog({ id, onClose, vacancies }: { id: number | null; onClose: () => void; vacancies: { id: number; title: string }[] }) {
  const q = trpc.recruitment.get.useQuery({ id: id ?? 0 }, { enabled: id != null });
  const [isDownloading, setIsDownloading] = useState(false);
  const a = q.data;
  const vacancyTitle = a?.vacancyId != null ? (vacancies.find((v) => v.id === a.vacancyId)?.title ?? null) : null;
  const positionTitle = vacancyTitle || a?.jobTitle || "تقديم عام";

  async function handleCvDownload() {
    if (!a?.cvFileKey || isDownloading) return;
    setIsDownloading(true);
    try {
      await downloadApplicantCv(a.cvFileKey, a.name);
      notify.ok("بدأ تنزيل السيرة الذاتية");
    } catch (error) {
      notify.err(error);
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <Dialog
      open={id != null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" dir="rtl">
        <DialogHeader>
          <DialogTitle>تفاصيل المتقدّم</DialogTitle>
        </DialogHeader>
        {q.isLoading ? (
          <LoadingState />
        ) : !a ? (
          <p className="text-sm text-muted-foreground py-4 text-center">تعذّر تحميل بيانات المتقدّم.</p>
        ) : (
          <div className="space-y-5">
            <header className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-center">
              <EmpAvatar name={a.name} sizePx={52} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-lg font-bold">{a.name}</div>
                <div className="mt-0.5 text-sm text-muted-foreground">{positionTitle}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant="outline" className="gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: STAGE_COLOR[a.stage] }} />
                    {applicantStageLabel(a.stage)}
                  </Badge>
                  <Badge variant="secondary">{applicantSourceLabel(a.source)}</Badge>
                </div>
              </div>
            </header>

            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><Phone aria-hidden className="size-4 text-muted-foreground" /> بيانات الاتصال</h3>
              <InfoGrid density="wide">
                <InfoField label="رقم الهاتف" kind="phone" value={a.phone ? <a href={`tel:${a.phone}`} className="hover:text-primary hover:underline">{a.phone}</a> : "غير مسجل"} />
                <InfoField label="البريد الإلكتروني" value={a.email ? <a href={`mailto:${a.email}`} className="break-all hover:text-primary hover:underline" dir="ltr">{a.email}</a> : "غير مسجل"} />
                <InfoField label={<span className="inline-flex items-center gap-1.5"><MapPin aria-hidden className="size-3.5" /> عنوان السكن / المنطقة</span>} value={a.residentialAddress || "غير مذكور"} span={2} />
              </InfoGrid>
            </section>

            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><Briefcase aria-hidden className="size-4 text-muted-foreground" /> بيانات الطلب والمؤهلات</h3>
              <InfoGrid density="wide">
                <InfoField label="الوظيفة المتقدّم لها" value={positionTitle} />
                <InfoField label="تاريخ التقديم" value={a.appliedDate ? fmtDate(a.appliedDate) : "غير مسجل"} kind="date" />
                <InfoField label="سنوات الخبرة" value={a.experience || "غير مذكورة"} />
                <InfoField label={<span className="inline-flex items-center gap-1.5"><GraduationCap aria-hidden className="size-3.5" /> المؤهل الدراسي</span>} value={a.education || "غير مذكور"} />
                <InfoField
                  label="الأعمال النموذجية"
                  span={2}
                  value={a.portfolioUrl ? <a href={a.portfolioUrl} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1.5 text-primary hover:underline" dir="ltr"><span className="truncate">{a.portfolioUrl}</span><ExternalLink aria-hidden className="size-3.5 shrink-0" /></a> : "غير مرفقة"}
                />
              </InfoGrid>
            </section>

            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><Star aria-hidden className="size-4 text-muted-foreground" /> التقييم والملاحظات</h3>
              <div className="rounded-lg border bg-muted/15 p-3">
                <div className="flex items-center justify-between gap-3 border-b pb-3">
                  <span className="text-xs font-medium text-muted-foreground">التقييم الأولي</span>
                  <Stars rating={a.rating} />
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-foreground">{a.notes || "لا توجد ملاحظات مسجلة."}</p>
              </div>
            </section>
          </div>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          {a?.cvFileKey ? (
            <Button type="button" onClick={() => void handleCvDownload()} disabled={isDownloading}>
              <Download aria-hidden className="size-4" /> {isDownloading ? ACTION_LABELS.downloading : "تنزيل السيرة الذاتية"}
            </Button>
          ) : <span />}
          <Button variant="outline" onClick={onClose}>
            إغلاق
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ====================== استمارة ورقية (إدخال الموظف) ====================== */
function PaperDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [experience, setExperience] = useState("");
  const [education, setEducation] = useState("");
  const [residentialAddress, setResidentialAddress] = useState("");
  const [portfolioUrl, setPortfolioUrl] = useState("");
  const [source, setSource] = useState<"paper" | "archive">("paper");
  const [stage, setStage] = useState<string>("new");
  const [rating, setRating] = useState(0);
  const [notes, setNotes] = useState("");

  const create = trpc.recruitment.create.useMutation({
    onSuccess: () => {
      notify.ok("حُفظ المتقدّم في مسار التوظيف");
      reset();
      onSaved();
      onClose();
    },
    onError: (e) => notify.err(e),
  });

  function reset() {
    setName("");
    setJobTitle("");
    setPhone("");
    setEmail("");
    setExperience("");
    setEducation("");
    setResidentialAddress("");
    setPortfolioUrl("");
    setSource("paper");
    setStage("new");
    setRating(0);
    setNotes("");
  }

  function submit() {
    if (!name.trim()) return notify.err("اسم المتقدّم مطلوب");
    create.mutate({
      name: name.trim(),
      jobTitle: jobTitle.trim() || undefined,
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      experience: experience.trim() || undefined,
      education: education.trim() || undefined,
      residentialAddress: residentialAddress.trim() || undefined,
      portfolioUrl: portfolioUrl.trim() || undefined,
      notes: notes.trim() || undefined,
      source,
      stage: stage as never,
      rating,
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>إدخال استمارة ورقية إلى النظام</DialogTitle>
        </DialogHeader>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          <div className="space-y-1.5">
            <Label>
              اسم المتقدّم <span className="text-destructive">*</span>
            </Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم الكامل" />
          </div>
          <div className="space-y-1.5">
            <Label>الهاتف</Label>
            <IntlPhoneInput value={phone} onChange={setPhone} ariaLabel="هاتف المرشح" />
          </div>
          <div className="space-y-1.5">
            <Label>الوظيفة المتقدّم لها</Label>
            <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="مثال: مصمم جرافيك" list="rec-jobs" />
            <datalist id="rec-jobs">
              {HR_DEPARTMENTS.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label>البريد الإلكتروني</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" type="email" placeholder="name@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label>الخبرة</Label>
            <Input value={experience} onChange={(e) => setExperience(e.target.value)} placeholder="مثال: ٣ سنوات" />
          </div>
          <div className="space-y-1.5">
            <Label>المؤهل الدراسي</Label>
            <Input value={education} onChange={(e) => setEducation(e.target.value)} placeholder="مثال: بكالوريوس" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>عنوان السكن / المنطقة</Label>
            <Input value={residentialAddress} onChange={(e) => setResidentialAddress(e.target.value)} maxLength={300} placeholder="مثال: بغداد — الكرادة" autoComplete="street-address" />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label>الأعمال النموذجية</Label>
            <Input value={portfolioUrl} onChange={(e) => setPortfolioUrl(e.target.value)} maxLength={500} type="url" dir="ltr" placeholder="https://portfolio.example.com" autoComplete="url" />
          </div>
          <div className="space-y-1.5">
            <Label>المصدر</Label>
            <AppSelect className={selectClsSm + " w-full"} value={source} onValueChange={(next) => setSource(next as "paper" | "archive")}>
              <option value="paper">استمارة ورقية</option>
              <option value="archive">أرشيف</option>
            </AppSelect>
          </div>
          <div className="space-y-1.5">
            <Label>المرحلة</Label>
            <AppSelect className={selectClsSm + " w-full"} value={stage} onValueChange={(next) => setStage(next)}>
              {APPLICANT_STAGES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label>التقييم المبدئي</Label>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setRating(rating === n ? 0 : n)} className="p-0.5 text-[var(--sem-warn)]" aria-label={`${n} نجوم`}>
                  <Star
                    className="size-5"
                    style={{
                      fill: n <= rating ? "currentColor" : "transparent",
                    }}
                  />
                </button>
              ))}
              {rating > 0 && (
                <button type="button" className="text-xs text-muted-foreground ms-2" onClick={() => setRating(0)}>
                  مسح
                </button>
              )}
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label>ملاحظات الموظف المختص</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="خبرات سابقة، مهارات…" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? ACTION_LABELS.saving : "حفظ في مسار التوظيف"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ====================== تبويب الوظائف الشاغرة (إدارة + نشر) ====================== */
type Vacancy = {
  id: number;
  title: string;
  department: string | null;
  employmentType: string;
  location: string | null;
  summary: string | null;
  description: string | null;
  requirements: string | null;
  openings: number;
  imageUrl: string | null;
  isPublished: boolean;
  publicPublicationStatus: "published" | "details_required" | "hidden";
  sortOrder: number;
};

function VacanciesTab({ publicUrl }: { publicUrl: string }) {
  const utils = trpc.useUtils();
  const list = trpc.recruitment.vacancyList.useQuery();
  const counts = trpc.recruitment.vacancyCounts.useQuery();
  const rows = (list.data ?? []) as Vacancy[];
  const countMap = (counts.data ?? {}) as Record<string, number>;

  const [editing, setEditing] = useState<Vacancy | "new" | null>(null);

  const publishedCount = rows.filter((v) => v.publicPublicationStatus === "published").length;

  const publish = trpc.recruitment.vacancyPublish.useMutation({
    onSuccess: () => {
      void utils.recruitment.vacancyList.invalidate();
      void utils.recruitment.openVacancies.invalidate();
    },
    onError: (e) => notify.err(e),
  });
  const del = trpc.recruitment.vacancyDelete.useMutation({
    onSuccess: () => {
      notify.ok("حُذفت الوظيفة");
      void utils.recruitment.vacancyList.invalidate();
      void utils.recruitment.openVacancies.invalidate();
      void utils.recruitment.vacancyCounts.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  function copyLink() {
    navigator.clipboard
      ?.writeText(publicUrl)
      .then(() => notify.ok("نُسخ رابط المعرض"))
      .catch(() => notify.err("تعذّر النسخ"));
  }

  return (
    <div className="space-y-4">
      {/* شريط الرابط العام + زر إضافة */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-primary">
                  <Briefcase className="size-5" />
                </span>
                <h3 className="font-semibold">معرض الوظائف العام</h3>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 leading-6 max-w-xl">الوظائف المنشورة تظهر للزوّار في صفحة المعرض العام، فيتصفّحونها ويقدّمون عليها مباشرة — ويصل طلب كل متقدّم مربوطاً بالوظيفة إلى مسار «المتقدّمين».</p>
            </div>
            <Button onClick={() => setEditing("new")}>
              <Plus className="size-4" /> وظيفة جديدة
            </Button>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <input readOnly value={publicUrl} dir="ltr" className="flex-1 h-8 rounded-md border border-input bg-muted px-2.5 text-xs tabular-nums font-mono" aria-label="رابط المعرض العام" />
            <Button size="sm" variant="outline" onClick={copyLink}>
              <Copy className="size-3.5" /> نسخ
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href={PUBLIC_PATH} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3.5" /> فتح المعرض
              </a>
            </Button>
          </div>
          <div className="text-[11px] text-muted-foreground mt-2 tabular-nums" dir="rtl">
            {rows.length} وظيفة · {publishedCount} منشورة
          </div>
        </CardContent>
      </Card>

      {list.isError && <ErrorState message="تعذّر تحميل الوظائف." onRetry={() => list.refetch()} />}

      {!list.isLoading && rows.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center">
            <Briefcase className="size-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground mt-3">لا وظائف بعد. أضِف أول وظيفة لتظهر في المعرض العام.</p>
            <Button className="mt-4" onClick={() => setEditing("new")}>
              <Plus className="size-4" /> وظيفة جديدة
            </Button>
          </CardContent>
        </Card>
      )}

      {/* بطاقات الوظائف */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {rows.map((v) => {
          const ac = vacancyAccent(v.department);
          const applicants = countMap[String(v.id)] ?? 0;
          const requiresDetails = v.publicPublicationStatus === "details_required";
          const publiclyPublished = v.publicPublicationStatus === "published";
          return (
            <Card key={v.id} className="overflow-hidden">
              <div className="relative h-24 flex items-end">
                {v.imageUrl ? (
                  <img src={v.imageUrl} alt={v.title} className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div
                    className="absolute inset-0"
                    style={{
                      background: `linear-gradient(135deg, ${ac.from}, ${ac.to})`,
                    }}
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                <div className="relative z-10 p-3 w-full flex items-center justify-between">
                  {v.department && <Badge className="bg-black/40 text-white border-white/30">{v.department}</Badge>}
                  <Badge variant={publiclyPublished ? "default" : "secondary"} className={publiclyPublished ? "badge-status-active border-transparent" : ""}>
                    {publiclyPublished ? "منشورة" : requiresDetails ? "تحتاج تفاصيل" : "مخفية"}
                  </Badge>
                </div>
              </div>
              <CardContent className="pt-3 space-y-2.5">
                <div className="font-semibold leading-tight">{v.title}</div>
                {v.summary && <p className="text-xs text-muted-foreground line-clamp-2 leading-5">{v.summary}</p>}
                <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1 bg-muted rounded px-1.5 py-0.5">{employmentTypeLabel(v.employmentType)}</span>
                  {v.location && (
                    <span className="inline-flex items-center gap-1 bg-muted rounded px-1.5 py-0.5">
                      <MapPin className="size-3" /> {v.location}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 bg-muted rounded px-1.5 py-0.5">
                    <Users className="size-3" /> {applicants} متقدّم
                  </span>
                </div>
                <div className="flex items-center justify-between pt-1 border-t">
                  <label className={`flex items-center gap-2 text-xs text-muted-foreground pt-2 ${requiresDetails ? "cursor-not-allowed" : "cursor-pointer"}`}>
                    <Switch checked={publiclyPublished} disabled={publish.isPending || requiresDetails} onCheckedChange={(c) => publish.mutate({ id: v.id, isPublished: c })} />
                    {requiresDetails ? "أكمل التفاصيل للنشر" : "نشر في المعرض"}
                  </label>
                  <div className="flex items-center gap-1 pt-2">
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(v)}>
                      <Pencil className="size-3.5" /> تعديل
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-destructive"
                      disabled={del.isPending}
                      onClick={async () => {
                        if (
                          !(await confirmDelete({
                            title: "حذف الوظيفة",
                            description: `حذف وظيفة «${v.title}» نهائياً؟ ستختفي من المعرض، ويبقى المتقدّمون عليها في مسار التوظيف (بعنوان الوظيفة المحفوظ). لا يمكن التراجع.`,
                            requireText: v.title,
                            confirmText: "حذف نهائياً",
                          }))
                        )
                          return;
                        del.mutate({ id: v.id });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {editing && (
        <VacancyDialog
          vacancy={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void utils.recruitment.vacancyList.invalidate();
            void utils.recruitment.openVacancies.invalidate();
          }}
        />
      )}
    </div>
  );
}

/* ====================== نافذة إنشاء/تعديل وظيفة ====================== */
function VacancyDialog({ vacancy, onClose, onSaved }: { vacancy: Vacancy | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!vacancy;
  const [title, setTitle] = useState(vacancy?.title ?? "");
  const [department, setDepartment] = useState(vacancy?.department ?? "");
  const [employmentType, setEmploymentType] = useState(vacancy?.employmentType ?? "full_time");
  const [location, setLocation] = useState(vacancy?.location ?? "");
  const [openings, setOpenings] = useState(String(vacancy?.openings ?? 1));
  const [summary, setSummary] = useState(vacancy?.summary ?? "");
  const [description, setDescription] = useState(vacancy?.description ?? "");
  const [requirements, setRequirements] = useState(vacancy?.requirements ?? "");
  const [isPublished, setIsPublished] = useState(vacancy?.isPublished ?? false);
  const [images, setImages] = useState<ImageItem[]>(vacancy?.imageUrl ? [{ id: "existing", dataUrl: vacancy.imageUrl, isPrimary: true }] : []);

  const create = trpc.recruitment.vacancyCreate.useMutation({
    onSuccess: () => {
      notify.ok("أُنشئت الوظيفة");
      onSaved();
      onClose();
    },
    onError: (e) => notify.err(e),
  });
  const update = trpc.recruitment.vacancyUpdate.useMutation({
    onSuccess: () => {
      notify.ok("حُفظت التعديلات");
      onSaved();
      onClose();
    },
    onError: (e) => notify.err(e),
  });
  const pending = create.isPending || update.isPending;

  function submit() {
    if (!title.trim()) return notify.err("عنوان الوظيفة مطلوب");
    if (isPublished && description.trim().length < 30) {
      return notify.err("لا يمكن نشر الوظيفة قبل كتابة وصف تفصيلي واضح لا يقل عن 30 حرفاً");
    }
    if (isPublished && requirements.trim().length < 10) {
      return notify.err("لا يمكن نشر الوظيفة قبل كتابة المتطلبات الأساسية بوضوح");
    }
    const payload = {
      title: title.trim(),
      department: department.trim() || undefined,
      employmentType: employmentType as never,
      location: location.trim() || undefined,
      openings: Math.max(1, parseInt(openings, 10) || 1),
      summary: summary.trim() || undefined,
      description: description.trim() || undefined,
      requirements: requirements.trim() || undefined,
      imageUrl: images[0]?.dataUrl || undefined,
      isPublished,
    };
    if (isEdit && vacancy) update.mutate({ id: vacancy.id, ...payload });
    else create.mutate(payload);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "تعديل وظيفة" : "وظيفة شاغرة جديدة"}</DialogTitle>
        </DialogHeader>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label>
              عنوان الوظيفة <span className="text-destructive">*</span>
            </Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: مصمم جرافيك" />
          </div>
          <div className="space-y-1.5">
            <Label>القسم</Label>
            <Input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="اختر أو اكتب" list="vac-depts" />
            <datalist id="vac-depts">
              {HR_DEPARTMENTS.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label>نوع التعاقد</Label>
            <AppSelect className={selectClsSm + " w-full"} value={employmentType} onValueChange={(next) => setEmploymentType(next)}>
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </AppSelect>
          </div>
          <div className="space-y-1.5">
            <Label>المكان / الفرع</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="مثال: الفرع الرئيسي" />
          </div>
          <div className="space-y-1.5">
            <Label>عدد الشواغر</Label>
            <Input type="number" min={1} value={openings} onChange={(e) => setOpenings(e.target.value)} dir="ltr" className="text-right" />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label>سطر تشويقي (يظهر على البطاقة)</Label>
            <Input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="جملة قصيرة جذّابة تلخّص الوظيفة" maxLength={200} />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label>الوصف {isPublished && <span className="text-destructive">*</span>}</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="مهام الوظيفة وتفاصيلها…" />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label>المتطلّبات {isPublished && <span className="text-destructive">*</span>}</Label>
            <Textarea value={requirements} onChange={(e) => setRequirements(e.target.value)} rows={3} placeholder="الخبرة والمهارات والمؤهلات المطلوبة…" />
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label className="flex items-center gap-1.5">
              <ImageIcon className="size-4" /> صورة الوظيفة (اختيارية)
            </Label>
            <ImageUploader value={images} onChange={setImages} maxItems={1} singlePrimary={false} hint="صورة واحدة تظهر أعلى بطاقة الوظيفة (بيئة العمل/القسم) — تُضغط تلقائياً" />
          </div>
          <div className="sm:col-span-2 lg:col-span-3 flex items-center justify-between rounded-lg border p-3 bg-muted/30">
            <div>
              <div className="text-sm font-medium">نشر في المعرض العام</div>
              <div className="text-xs text-muted-foreground">يلزم وصف تفصيلي ومتطلبات واضحة قبل النشر في صفحة /apply</div>
            </div>
            <Switch checked={isPublished} onCheckedChange={setIsPublished} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? ACTION_LABELS.saving : isEdit ? "حفظ التعديلات" : "إنشاء الوظيفة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
