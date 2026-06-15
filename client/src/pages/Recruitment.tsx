/**
 * شاشة التوظيف — مسار المتقدّمين (Kanban) مجمَّعاً حسب المرحلة.
 * مساران للتقديم: رابط خارجي عام (/apply) يملؤه المتقدّم، أو استمارة ورقية يُدخلها الموظف.
 * بطاقة كل متقدّم: الاسم، الوظيفة، شارة المصدر، نجوم التقييم، الهاتف، وزر الانتقال للمرحلة التالية.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmpAvatar } from "@/lib/hr/ui";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import {
  APPLICANT_SOURCES,
  APPLICANT_STAGES,
  EMPLOYMENT_TYPES,
  HR_DEPARTMENTS,
  applicantSourceLabel,
  applicantStageLabel,
  employmentTypeLabel,
  vacancyAccent,
} from "@shared/hr";
import {
  Briefcase,
  ChevronLeft,
  Copy,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Link as LinkIcon,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";

const selectCls =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const STAGE_COLOR: Record<string, string> = {
  new: "#2563eb",
  review: "#ca8a04",
  interview: "#7c3aed",
  accepted: "#16a34a",
  rejected: "#dc2626",
  archived: "#64748b",
};

/** المرحلة التالية في المسار (للزر «نقل»). الرفض/الأرشيف نهايتان. */
const NEXT_STAGE: Record<string, string | null> = {
  new: "review",
  review: "interview",
  interview: "accepted",
  accepted: null,
  rejected: null,
  archived: null,
};

type Applicant = {
  id: number;
  name: string;
  jobTitle: string | null;
  source: string;
  stage: string;
  phone: string | null;
  rating: number | null;
};

function Stars({ rating }: { rating: number | null }) {
  const r = rating ?? 0;
  if (r <= 0) return <span className="text-muted-foreground text-[11px]">—</span>;
  return (
    <span className="inline-flex items-center text-amber-500" aria-label={`${r} نجوم`}>
      {Array.from({ length: r }, (_, k) => (
        <Star key={k} className="size-3" style={{ fill: "currentColor" }} />
      ))}
    </span>
  );
}

const PUBLIC_PATH = "/apply";

export default function Recruitment() {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState("vacancies");
  const [stage, setStage] = useState("");
  const [source, setSource] = useState("");
  const [q, setQ] = useState("");
  const [paperOpen, setPaperOpen] = useState(false);

  const input = useMemo(
    () => ({
      stage: (stage || undefined) as never,
      source: (source || undefined) as never,
      q: q.trim() || undefined,
    }),
    [stage, source, q],
  );
  const list = trpc.recruitment.list.useQuery(input);
  const rows = (list.data ?? []) as Applicant[];

  const publicUrl = (typeof window !== "undefined" ? window.location.origin : "") + PUBLIC_PATH;

  const externalCount = rows.filter((a) => a.source === "external").length;
  const paperCount = rows.filter((a) => a.source === "paper" || a.source === "archive").length;

  const move = trpc.recruitment.updateStage.useMutation({
    onSuccess: () => {
      notify.ok("نُقل المتقدّم");
      void utils.recruitment.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

  function copyLink() {
    navigator.clipboard
      ?.writeText(publicUrl)
      .then(() => notify.ok("نُسخ رابط التقديم"))
      .catch(() => notify.err("تعذّر النسخ"));
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">التوظيف</h1>
        <p className="text-sm text-muted-foreground mt-1">
          أعلِن الوظائف الشاغرة على المعرض العام، وتابِع المتقدّمين عبر مسار المراحل.
        </p>
      </div>

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
              <span className="text-primary"><LinkIcon className="size-5" /></span>
              <h3 className="font-semibold">التقديم عبر الرابط الخارجي</h3>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5 leading-6">
              شارك الرابط العام مع المتقدّمين. يملأ المتقدّم استمارة كاملة، فيصل طلبه مباشرة إلى مسار التوظيف
              (مرحلة «جديد») للمراجعة والمقابلة أو الأرشفة.
            </p>
            <div className="flex items-center gap-2 mt-3">
              <input
                readOnly
                value={publicUrl}
                dir="ltr"
                className="flex-1 h-8 rounded-md border border-input bg-muted px-2.5 text-xs tabular-nums font-mono"
                aria-label="رابط التقديم العام"
              />
              <Button size="sm" variant="outline" onClick={copyLink}>
                <Copy className="size-3.5" /> نسخ
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={PUBLIC_PATH} target="_blank" rel="noopener noreferrer">
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
              <span className="text-primary"><FileText className="size-5" /></span>
              <h3 className="font-semibold">الاستمارة الورقية</h3>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5 leading-6">
              يملأ المتقدّم استمارة ورقية يدوياً، ويُدخلها الموظف المختص لاحقاً إلى النظام، أو تُحفظ في الأرشيف
              للرجوع إليها عند الحاجة.
            </p>
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
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="بحث (اسم/وظيفة/هاتف/بريد)"
            className={selectCls + " w-56"}
            aria-label="بحث"
          />
          <select className={selectCls} value={stage} onChange={(e) => setStage(e.target.value)} aria-label="المرحلة">
            <option value="">كل المراحل</option>
            {APPLICANT_STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <select className={selectCls} value={source} onChange={(e) => setSource(e.target.value)} aria-label="المصدر">
            <option value="">كل المصادر</option>
            {APPLICANT_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </CardContent>
      </Card>

      {list.isError && (
        <Card><CardContent className="py-4 text-center text-rose-600 text-sm">
          تعذّر تحميل المتقدّمين. <button className="underline" onClick={() => list.refetch()}>إعادة المحاولة</button>
        </CardContent></Card>
      )}

      {/* مسار المتقدّمين (Kanban) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {APPLICANT_STAGES.map((st) => {
          const items = rows.filter((a) => a.stage === st.key);
          const color = STAGE_COLOR[st.key] ?? "#64748b";
          return (
            <div key={st.key} className="bg-muted/40 rounded-lg p-2.5 min-h-24">
              <div className="flex items-center justify-between mb-2.5 px-1">
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-xs font-semibold">{st.label}</span>
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums">{items.length}</span>
              </div>
              <div className="space-y-2">
                {items.map((a) => {
                  const next = NEXT_STAGE[a.stage];
                  return (
                    <div key={a.id} className="bg-card border border-border rounded-lg p-2.5 transition-shadow hover:shadow-sm">
                      <div className="flex items-center gap-2">
                        <EmpAvatar name={a.name} color={color} sizePx={28} />
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-medium truncate">{a.name}</div>
                          <div className="text-[10px] text-muted-foreground truncate">{a.jobTitle || "—"}</div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-2 text-[10px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          {a.source === "external" ? <LinkIcon className="size-3" /> : <FileText className="size-3" />}
                          {applicantSourceLabel(a.source)}
                        </span>
                        <Stars rating={a.rating} />
                      </div>
                      {a.phone && (
                        <div className="flex items-center gap-1 mt-1.5 text-[10px] text-muted-foreground" dir="ltr">
                          <Phone className="size-3 shrink-0" />
                          <span className="tabular-nums">{a.phone}</span>
                        </div>
                      )}
                      {next && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full mt-2 h-7 text-[11px]"
                          disabled={move.isPending}
                          onClick={() => move.mutate({ id: a.id, stage: next as never })}
                        >
                          نقل إلى «{applicantStageLabel(next)}» <ChevronLeft className="size-3.5" />
                        </Button>
                      )}
                      {a.stage !== "rejected" && a.stage !== "archived" && (
                        <div className="flex gap-1.5 mt-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="flex-1 h-6 text-[10px] text-rose-600 hover:text-rose-700"
                            disabled={move.isPending}
                            onClick={() => move.mutate({ id: a.id, stage: "rejected" })}
                          >
                            رفض
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="flex-1 h-6 text-[10px] text-muted-foreground"
                            disabled={move.isPending}
                            onClick={() => move.mutate({ id: a.id, stage: "archived" })}
                          >
                            أرشفة
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {items.length === 0 && (
                  <div className="text-[11px] text-muted-foreground text-center py-4">لا طلبات</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

          <PaperDialog open={paperOpen} onClose={() => setPaperOpen(false)} onSaved={() => void utils.recruitment.list.invalidate()} />
        </TabsContent>
      </Tabs>
    </div>
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
    setName(""); setJobTitle(""); setPhone(""); setEmail("");
    setExperience(""); setEducation(""); setSource("paper"); setStage("new");
    setRating(0); setNotes("");
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
      notes: notes.trim() || undefined,
      source,
      stage: stage as never,
      rating,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle>إدخال استمارة ورقية إلى النظام</DialogTitle>
        </DialogHeader>

        <div className="grid sm:grid-cols-2 gap-3.5">
          <div className="space-y-1.5">
            <Label>اسم المتقدّم <span className="text-rose-600">*</span></Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم الكامل" />
          </div>
          <div className="space-y-1.5">
            <Label>الهاتف</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" placeholder="07XX ..." />
          </div>
          <div className="space-y-1.5">
            <Label>الوظيفة المتقدّم لها</Label>
            <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="مثال: مصمم جرافيك" list="rec-jobs" />
            <datalist id="rec-jobs">
              {HR_DEPARTMENTS.map((d) => <option key={d} value={d} />)}
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
          <div className="space-y-1.5">
            <Label>المصدر</Label>
            <select className={selectCls + " w-full"} value={source} onChange={(e) => setSource(e.target.value as "paper" | "archive")}>
              <option value="paper">استمارة ورقية</option>
              <option value="archive">أرشيف</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>المرحلة</Label>
            <select className={selectCls + " w-full"} value={stage} onChange={(e) => setStage(e.target.value)}>
              {APPLICANT_STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>التقييم المبدئي</Label>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(rating === n ? 0 : n)}
                  className="p-0.5 text-amber-500"
                  aria-label={`${n} نجوم`}
                >
                  <Star className="size-5" style={{ fill: n <= rating ? "currentColor" : "transparent" }} />
                </button>
              ))}
              {rating > 0 && (
                <button type="button" className="text-xs text-muted-foreground ms-2" onClick={() => setRating(0)}>
                  مسح
                </button>
              )}
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>ملاحظات الموظف المختص</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="خبرات سابقة، مهارات…" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? "جارٍ الحفظ…" : "حفظ في مسار التوظيف"}
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
  sortOrder: number;
};

function VacanciesTab({ publicUrl }: { publicUrl: string }) {
  const utils = trpc.useUtils();
  const list = trpc.recruitment.vacancyList.useQuery();
  const counts = trpc.recruitment.vacancyCounts.useQuery();
  const rows = (list.data ?? []) as Vacancy[];
  const countMap = (counts.data ?? {}) as Record<string, number>;

  const [editing, setEditing] = useState<Vacancy | "new" | null>(null);
  const [confirmDel, setConfirmDel] = useState<Vacancy | null>(null);

  const publishedCount = rows.filter((v) => v.isPublished).length;

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
      setConfirmDel(null);
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
                <span className="text-primary"><Briefcase className="size-5" /></span>
                <h3 className="font-semibold">معرض الوظائف العام</h3>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 leading-6 max-w-xl">
                الوظائف المنشورة تظهر للزوّار في صفحة المعرض العام، فيتصفّحونها ويقدّمون عليها مباشرة —
                ويصل طلب كل متقدّم مربوطاً بالوظيفة إلى مسار «المتقدّمين».
              </p>
            </div>
            <Button onClick={() => setEditing("new")}>
              <Plus className="size-4" /> وظيفة جديدة
            </Button>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <input
              readOnly
              value={publicUrl}
              dir="ltr"
              className="flex-1 h-8 rounded-md border border-input bg-muted px-2.5 text-xs tabular-nums font-mono"
              aria-label="رابط المعرض العام"
            />
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

      {list.isError && (
        <Card><CardContent className="py-4 text-center text-rose-600 text-sm">
          تعذّر تحميل الوظائف. <button className="underline" onClick={() => list.refetch()}>إعادة المحاولة</button>
        </CardContent></Card>
      )}

      {!list.isLoading && rows.length === 0 && (
        <Card><CardContent className="py-10 text-center">
          <Briefcase className="size-8 mx-auto text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground mt-3">لا وظائف بعد. أضِف أول وظيفة لتظهر في المعرض العام.</p>
          <Button className="mt-4" onClick={() => setEditing("new")}><Plus className="size-4" /> وظيفة جديدة</Button>
        </CardContent></Card>
      )}

      {/* بطاقات الوظائف */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {rows.map((v) => {
          const ac = vacancyAccent(v.department);
          const applicants = countMap[String(v.id)] ?? 0;
          return (
            <Card key={v.id} className="overflow-hidden">
              <div className="relative h-24 flex items-end">
                {v.imageUrl ? (
                  <img src={v.imageUrl} alt={v.title} className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${ac.from}, ${ac.to})` }} />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                <div className="relative z-10 p-3 w-full flex items-center justify-between">
                  {v.department && <Badge className="bg-black/40 text-white border-white/30">{v.department}</Badge>}
                  <Badge variant={v.isPublished ? "default" : "secondary"} className={v.isPublished ? "bg-emerald-600" : ""}>
                    {v.isPublished ? "منشورة" : "مخفية"}
                  </Badge>
                </div>
              </div>
              <CardContent className="pt-3 space-y-2.5">
                <div className="font-semibold leading-tight">{v.title}</div>
                {v.summary && <p className="text-xs text-muted-foreground line-clamp-2 leading-5">{v.summary}</p>}
                <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1 bg-muted rounded px-1.5 py-0.5">
                    {employmentTypeLabel(v.employmentType)}
                  </span>
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
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer pt-2">
                    <Switch
                      checked={v.isPublished}
                      disabled={publish.isPending}
                      onCheckedChange={(c) => publish.mutate({ id: v.id, isPublished: c })}
                    />
                    نشر في المعرض
                  </label>
                  <div className="flex items-center gap-1 pt-2">
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(v)}>
                      <Pencil className="size-3.5" /> تعديل
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-rose-600 hover:text-rose-700" onClick={() => setConfirmDel(v)}>
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

      {/* تأكيد الحذف */}
      <Dialog open={!!confirmDel} onOpenChange={(o) => { if (!o) setConfirmDel(null); }}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader><DialogTitle>حذف الوظيفة</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground leading-7">
            هل تريد حذف وظيفة «{confirmDel?.title}»؟ ستختفي من المعرض، ويبقى المتقدّمون عليها في مسار التوظيف
            (بعنوان الوظيفة المحفوظ). لا يمكن التراجع.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(null)}>إلغاء</Button>
            <Button
              className="bg-rose-600 hover:bg-rose-700"
              disabled={del.isPending}
              onClick={() => confirmDel && del.mutate({ id: confirmDel.id })}
            >
              {del.isPending ? "جارٍ الحذف…" : "حذف نهائياً"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const [images, setImages] = useState<ImageItem[]>(
    vacancy?.imageUrl ? [{ id: "existing", dataUrl: vacancy.imageUrl, isPrimary: true }] : [],
  );

  const create = trpc.recruitment.vacancyCreate.useMutation({
    onSuccess: () => { notify.ok("أُنشئت الوظيفة"); onSaved(); onClose(); },
    onError: (e) => notify.err(e),
  });
  const update = trpc.recruitment.vacancyUpdate.useMutation({
    onSuccess: () => { notify.ok("حُفظت التعديلات"); onSaved(); onClose(); },
    onError: (e) => notify.err(e),
  });
  const pending = create.isPending || update.isPending;

  function submit() {
    if (!title.trim()) return notify.err("عنوان الوظيفة مطلوب");
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "تعديل وظيفة" : "وظيفة شاغرة جديدة"}</DialogTitle>
        </DialogHeader>

        <div className="grid sm:grid-cols-2 gap-3.5">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>عنوان الوظيفة <span className="text-rose-600">*</span></Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثال: مصمم جرافيك" />
          </div>
          <div className="space-y-1.5">
            <Label>القسم</Label>
            <Input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="اختر أو اكتب" list="vac-depts" />
            <datalist id="vac-depts">
              {HR_DEPARTMENTS.map((d) => <option key={d} value={d} />)}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label>نوع التعاقد</Label>
            <select className={selectCls + " w-full"} value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
              {EMPLOYMENT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>المكان / الفرع</Label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="مثال: الفرع الرئيسي" />
          </div>
          <div className="space-y-1.5">
            <Label>عدد الشواغر</Label>
            <Input type="number" min={1} value={openings} onChange={(e) => setOpenings(e.target.value)} dir="ltr" className="text-right" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>سطر تشويقي (يظهر على البطاقة)</Label>
            <Input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="جملة قصيرة جذّابة تلخّص الوظيفة" maxLength={200} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>الوصف</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="مهام الوظيفة وتفاصيلها…" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>المتطلّبات</Label>
            <Textarea value={requirements} onChange={(e) => setRequirements(e.target.value)} rows={3} placeholder="الخبرة والمهارات والمؤهلات المطلوبة…" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="flex items-center gap-1.5"><ImageIcon className="size-4" /> صورة الوظيفة (اختيارية)</Label>
            <ImageUploader
              value={images}
              onChange={setImages}
              maxItems={1}
              singlePrimary={false}
              hint="صورة واحدة تظهر أعلى بطاقة الوظيفة (بيئة العمل/القسم) — تُضغط تلقائياً"
            />
          </div>
          <div className="sm:col-span-2 flex items-center justify-between rounded-lg border p-3 bg-muted/30">
            <div>
              <div className="text-sm font-medium">نشر في المعرض العام</div>
              <div className="text-xs text-muted-foreground">عند التفعيل تظهر الوظيفة للزوّار في صفحة /apply</div>
            </div>
            <Switch checked={isPublished} onCheckedChange={setIsPublished} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "جارٍ الحفظ…" : isEdit ? "حفظ التعديلات" : "إنشاء الوظيفة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
