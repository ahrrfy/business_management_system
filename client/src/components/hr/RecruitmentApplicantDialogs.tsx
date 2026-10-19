/** حوارات المتقدّمين في شاشة التوظيف — حوار تفاصيل المتقدّم + حوار إدخال الاستمارة الورقية الشامل. */
import { Badge } from "@/components/ui/badge";
import { AppSelect } from "@/components/ui/AppSelect";
import { Button } from "@/components/ui/button";
import { InfoField, InfoGrid } from "@/components/data-display/InfoGrid";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MoneyInput } from "@/components/form/MoneyInput";
import { LoadingState } from "@/components/PageState";
import { Input } from "@/components/ui/input";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmpAvatar } from "@/lib/hr/ui";
import { downloadApplicantCv } from "@/lib/applicantCvDownload";
import { fmtDate } from "@/lib/date";
import { formatIqd } from "@/lib/money";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import {
  APPLICANT_AVAILABILITY_STATUSES, APPLICANT_EXPERIENCE_LEVELS, APPLICANT_PREFERRED_BRANCHES,
  APPLICANT_SHIFT_PREFERENCES, APPLICANT_STAGES, DEGREES, EMPLOYMENT_TYPES, GENDERS,
  HR_DEPARTMENTS, IRAQ_GOVERNORATES, MARITAL_STATUSES, applicantAvailabilityLabel,
  applicantShiftLabel, applicantSourceLabel, applicantStageLabel, employmentTypeLabel, type ApplicantStage,
} from "@shared/hr";
import { Briefcase, Download, ExternalLink, GraduationCap, MapPin, Phone, Star, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { selectClsSm } from "@/lib/ui/formStyles";
import { ACTION_LABELS } from "@shared/actionLabels";

const MAX_CV_BYTES = 2 * 1024 * 1024;
const PDF_MIME = "application/pdf" as const;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baghdad" }).format(new Date());

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(binary);
}

export const STAGE_COLOR: Record<string, string> = {
  new: "var(--status-pending)", review: "var(--stock-low)", interview: "var(--chart-check)",
  accepted: "var(--money-positive)", rejected: "var(--money-negative)", archived: "var(--muted-foreground)",
};

export type Applicant = {
  id: number; name: string; jobTitle: string | null; branchId: number | null; vacancyId: number | null;
  source: string; stage: ApplicantStage; appliedDate: string | null; phone: string | null;
  whatsappPhone: string | null; email: string | null; birthDate: string | null; gender: string | null;
  maritalStatus: string | null; governorate: string | null; district: string | null; degree: string | null;
  major: string | null; availabilityStatus: string | null; experience: string | null;
  previousEmployer: string | null; education: string | null; skills: string | null;
  residentialAddress: string | null; department: string | null; preferredBranch: string | null;
  employmentType: string | null; shiftPreference: string | null; expectedSalary: string | null;
  availableFrom: string | null; portfolioUrl: string | null; rating: number | null;
  interviewDate: string | null; rejectionReason: string | null; notes: string | null; cvFileKey: string | null;
  convertedEmployeeId: number | null;
};

export function Stars({ rating }: { rating: number | null }) {
  const r = rating ?? 0;
  if (r <= 0) return <span className="text-muted-foreground text-[11px]">—</span>;
  return (
    <span className="inline-flex items-center text-[var(--sem-warn)]" aria-label={`${r} نجوم`}>
      {Array.from({ length: r }, (_, k) => <Star key={k} className="size-3" style={{ fill: "currentColor" }} />)}
    </span>
  );
}

/* ====================== حوار تفاصيل المتقدّم ====================== */
export function ApplicantDetailDialog({
  id, onClose, vacancies, onConvertToEmployee, onOpenEmployee,
}: {
  id: number | null; onClose: () => void; vacancies: { id: number; title: string }[];
  onConvertToEmployee: (applicantId: number) => void; onOpenEmployee?: (employeeId: number) => void;
}) {
  const utils = trpc.useUtils();
  const q = trpc.recruitment.get.useQuery({ id: id ?? 0 }, { enabled: id != null });
  const [isDownloading, setIsDownloading] = useState(false);
  const a = q.data as Applicant | null | undefined;
  const [rating, setRating] = useState(0);
  const [stage, setStage] = useState<ApplicantStage>("new");
  const [interviewDate, setInterviewDate] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!a) return;
    setStage(a.stage); setInterviewDate(a.interviewDate ?? "");
    setRejectionReason(a.rejectionReason ?? ""); setNotes(a.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.id]);

  useEffect(() => { if (a) setRating(a.rating ?? 0); }, [a?.id, a?.rating]);

  const saveReview = trpc.recruitment.setRating.useMutation({
    onSuccess: () => {
      notify.ok("حُفظت بيانات التقييم والمراجعة");
      void utils.recruitment.get.invalidate({ id: id ?? 0 });
      void utils.recruitment.list.invalidate();
    },
    onError: (e) => notify.err(e),
  });

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

  function handleQuickRating(nextRating: number) {
    if (!a) return;
    const r = rating === nextRating ? 0 : nextRating;
    setRating(r);
    saveReview.mutate({ id: a.id, rating: r });
  }

  return (
    <Dialog open={id != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" dir="rtl">
        <DialogHeader><DialogTitle>تفاصيل المتقدّم</DialogTitle></DialogHeader>
        {q.isLoading ? <LoadingState /> : !a ? (
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
                  {a.department && <Badge variant="outline">{a.department}</Badge>}
                </div>
              </div>
              {a.convertedEmployeeId != null ? (
                <Button size="sm" variant="secondary" onClick={() => onOpenEmployee?.(a.convertedEmployeeId!)}>
                  <UserPlus className="size-4" /> عُيِّن كموظف (#{a.convertedEmployeeId})
                </Button>
              ) : (
                <Button size="sm" variant="default" onClick={() => onConvertToEmployee(a.id)}>
                  <UserPlus className="size-4" /> تعيين كموظف
                </Button>
              )}
            </header>
            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><Phone aria-hidden className="size-4 text-muted-foreground" /> البيانات الشخصية والتواصل</h3>
              <InfoGrid density="wide">
                <InfoField label="رقم الهاتف الأساسي" kind="phone" value={a.phone ? <a href={`tel:${a.phone}`} className="hover:text-primary hover:underline">{a.phone}</a> : "غير مسجل"} />
                <InfoField label="واتساب / هاتف بديل" kind="phone" value={a.whatsappPhone ? <a href={`tel:${a.whatsappPhone}`} className="hover:text-primary hover:underline">{a.whatsappPhone}</a> : "غير مسجل"} />
                <InfoField label="البريد الإلكتروني" value={a.email ? <a href={`mailto:${a.email}`} className="break-all hover:text-primary hover:underline" dir="ltr">{a.email}</a> : "غير مسجل"} />
                <InfoField label="تاريخ الميلاد" kind="date" value={a.birthDate ? fmtDate(a.birthDate) : "غير مذكور"} />
                <InfoField label="الجنس" value={a.gender || "غير مذكور"} />
                <InfoField label="الحالة الاجتماعية" value={a.maritalStatus || "غير مذكورة"} />
                <InfoField label="المحافظة" value={a.governorate || "غير مذكورة"} />
                <InfoField label="القضاء / المنطقة" value={a.district || "غير مذكور"} />
                <InfoField label={<span className="inline-flex items-center gap-1.5"><MapPin aria-hidden className="size-3.5" /> عنوان السكن التفصيلي</span>} value={a.residentialAddress || "غير مذكور"} span={2} />
              </InfoGrid>
            </section>
            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><GraduationCap aria-hidden className="size-4 text-muted-foreground" /> المؤهل العلمي والخبرة والمهارات</h3>
              <InfoGrid density="wide">
                <InfoField label="التحصيل الدراسي" value={a.degree || "غير مذكور"} />
                <InfoField label="التخصص الدراسي" value={a.major || "غير مذكور"} />
                <InfoField label="الجامعة / المعهد وسنة التخرج" value={a.education || "غير مذكور"} />
                <InfoField label="حالة التفرّغ الحالية" value={a.availabilityStatus ? applicantAvailabilityLabel(a.availabilityStatus) : "غير مذكورة"} />
                <InfoField label="سنوات الخبرة" value={a.experience || "غير مذكورة"} />
                <InfoField label="آخر جهة عمل / مسمى سابق" value={a.previousEmployer || "غير مذكور"} />
                <InfoField label="المهارات والبرامج المتقنة" value={a.skills || "غير مذكورة"} span={2} />
                <InfoField label="الأعمال النموذجية" span={2} value={a.portfolioUrl ? <a href={a.portfolioUrl} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1.5 text-primary hover:underline" dir="ltr"><span className="truncate">{a.portfolioUrl}</span><ExternalLink aria-hidden className="size-3.5 shrink-0" /></a> : "غير مرفقة"} />
              </InfoGrid>
            </section>
            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><Briefcase aria-hidden className="size-4 text-muted-foreground" /> تفضيلات الوظيفة والدوام</h3>
              <InfoGrid density="wide">
                <InfoField label="الوظيفة المتقدّم لها" value={positionTitle} />
                <InfoField label="القسم المفضّل" value={a.department || "غير محدد"} />
                <InfoField label="الفرع المفضّل للعمل" value={a.preferredBranch || "أي فرع متاح"} />
                <InfoField label="نوع الدوام" value={a.employmentType ? employmentTypeLabel(a.employmentType) : "غير محدد"} />
                <InfoField label="الشفت المفضّل" value={a.shiftPreference ? applicantShiftLabel(a.shiftPreference) : "غير محدد"} />
                <InfoField label="الراتب الشهري المتوقع" value={a.expectedSalary ? formatIqd(a.expectedSalary) : "غير محدد"} />
                <InfoField label="تاريخ الجاهزية للمباشرة" kind="date" value={a.availableFrom ? fmtDate(a.availableFrom) : "فوراً / غير محدد"} />
                <InfoField label="تاريخ التقديم" value={a.appliedDate ? fmtDate(a.appliedDate) : "غير مسجل"} kind="date" />
              </InfoGrid>
            </section>
            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><Star aria-hidden className="size-4 text-muted-foreground" /> التقييم والمراجعة الإدارية</h3>
              <div className="rounded-lg border bg-muted/15 p-3 space-y-3">
                <div className="flex items-center justify-between gap-3 border-b pb-3">
                  <span className="text-xs font-medium text-muted-foreground">التقييم الأولي (اضغط للتعديل)</span>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} type="button" onClick={() => handleQuickRating(n)} disabled={saveReview.isPending} className="p-0.5 text-[var(--sem-warn)] hover:scale-110 transition-transform" aria-label={`${n} نجوم`}>
                        <Star className="size-4" style={{ fill: n <= rating ? "currentColor" : "transparent" }} />
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid sm:grid-cols-3 gap-3">
                  <div className="space-y-1"><Label className="text-xs">المرحلة الحالية</Label><AppSelect className={selectClsSm + " w-full"} value={stage} onValueChange={(next) => setStage(next as ApplicantStage)}>{APPLICANT_STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</AppSelect></div>
                  <div className="space-y-1"><Label className="text-xs">موعد المقابلة</Label><Input type="date" value={interviewDate} onChange={(e) => setInterviewDate(e.target.value)} /></div>
                  <div className="space-y-1"><Label className="text-xs">سبب الرفض / الاعتذار (عند الرفض)</Label><Input value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} placeholder="اختياري — يُحفظ في سجل المتقدّم" maxLength={500} /></div>
                </div>
                <div className="space-y-1"><Label className="text-xs">ملاحظات المتقدّم والموارد البشرية</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="ملاحظات المقابلة، التقييم الفني، أو نبذة المتقدّم…" /></div>
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => saveReview.mutate({ id: a.id, rating, stage, notes: notes.trim() || null, interviewDate: interviewDate.trim() || null, rejectionReason: rejectionReason.trim() || null })} disabled={saveReview.isPending}>
                    {saveReview.isPending ? ACTION_LABELS.saving : "حفظ التقييم والملاحظات"}
                  </Button>
                </div>
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
          <Button variant="outline" onClick={onClose}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ====================== استمارة ورقية (إدخال الموظف) ====================== */
export function PaperDialog({
  open, onClose, onSaved, vacancies, branches, canChooseCompanyWide = false,
}: {
  open: boolean; onClose: () => void; onSaved: () => void;
  vacancies: { id: number; title: string; department: string | null; employmentType: string; branchId?: number | null }[];
  branches: { id: number; name: string }[]; canChooseCompanyWide?: boolean;
}) {
  const defaultBranchId = !canChooseCompanyWide && branches[0]?.id ? String(branches[0].id) : "";
  const [name, setName] = useState(""); const [vacancyId, setVacancyId] = useState("");
  const [branchId, setBranchId] = useState(defaultBranchId); const [jobTitle, setJobTitle] = useState("");
  const [department, setDepartment] = useState(""); const [appliedDate, setAppliedDate] = useState(() => todayIso());
  const [phone, setPhone] = useState(""); const [whatsappPhone, setWhatsappPhone] = useState("");
  const [email, setEmail] = useState(""); const [birthDate, setBirthDate] = useState("");
  const [gender, setGender] = useState(""); const [maritalStatus, setMaritalStatus] = useState("");
  const [governorate, setGovernorate] = useState("بغداد"); const [district, setDistrict] = useState("");
  const [residentialAddress, setResidentialAddress] = useState(""); const [degree, setDegree] = useState("");
  const [major, setMajor] = useState(""); const [education, setEducation] = useState("");
  const [availabilityStatus, setAvailabilityStatus] = useState("available"); const [experience, setExperience] = useState("");
  const [previousEmployer, setPreviousEmployer] = useState(""); const [skills, setSkills] = useState("");
  const [preferredBranch, setPreferredBranch] = useState(""); const [employmentType, setEmploymentType] = useState("full_time");
  const [shiftPreference, setShiftPreference] = useState("both"); const [expectedSalary, setExpectedSalary] = useState("");
  const [availableFrom, setAvailableFrom] = useState(""); const [portfolioUrl, setPortfolioUrl] = useState("");
  const [source, setSource] = useState<"paper" | "archive">("paper"); const [stage, setStage] = useState<string>("new");
  const [rating, setRating] = useState(0); const [interviewDate, setInterviewDate] = useState("");
  const [notes, setNotes] = useState(""); const [cvFile, setCvFile] = useState<File | null>(null);
  const [encodingCv, setEncodingCv] = useState(false);

  useEffect(() => {
    if (!canChooseCompanyWide) {
      const locked = branches[0]?.id ? String(branches[0].id) : "";
      if (branchId !== locked) setBranchId(locked);
    } else if (!open && branchId !== "") {
      setBranchId("");
    }
  }, [canChooseCompanyWide, branches, branchId, open]);

  const create = trpc.recruitment.create.useMutation({
    onSuccess: () => { notify.ok("حُفظ المتقدّم في مسار التوظيف"); reset(); onSaved(); onClose(); },
    onError: (e) => notify.err(e),
  });

  function reset() {
    setName(""); setVacancyId(""); setBranchId(defaultBranchId); setJobTitle(""); setDepartment("");
    setAppliedDate(todayIso()); setPhone(""); setWhatsappPhone(""); setEmail(""); setBirthDate("");
    setGender(""); setMaritalStatus(""); setGovernorate("بغداد"); setDistrict(""); setResidentialAddress("");
    setDegree(""); setMajor(""); setEducation(""); setAvailabilityStatus("available"); setExperience("");
    setPreviousEmployer(""); setSkills(""); setPreferredBranch(""); setEmploymentType("full_time");
    setShiftPreference("both"); setExpectedSalary(""); setAvailableFrom(""); setPortfolioUrl("");
    setSource("paper"); setStage("new"); setRating(0); setInterviewDate(""); setNotes(""); setCvFile(null);
  }

  function selectCv(file: File | undefined, input: HTMLInputElement) {
    if (!file) { setCvFile(null); return; }
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".pdf") && !lower.endsWith(".docx")) {
      setCvFile(null); input.value = ""; notify.err("يسمح بإرفاق PDF أو DOCX فقط"); return;
    }
    if (file.size < 1 || file.size > MAX_CV_BYTES) {
      setCvFile(null); input.value = ""; notify.err("يجب ألا يتجاوز حجم السيرة الذاتية 2MB"); return;
    }
    setCvFile(file);
  }

  async function submit() {
    if (!name.trim()) return notify.err("اسم المتقدّم مطلوب");
    let cv: { fileName: string; mimeType: typeof PDF_MIME | typeof DOCX_MIME; base64: string } | undefined;
    if (cvFile) {
      setEncodingCv(true);
      try {
        const isDocx = cvFile.name.toLowerCase().endsWith(".docx");
        cv = { fileName: cvFile.name, mimeType: isDocx ? DOCX_MIME : PDF_MIME, base64: await fileToBase64(cvFile) };
      } catch {
        notify.err("تعذّرت قراءة ملف السيرة الذاتية"); return;
      } finally {
        setEncodingCv(false);
      }
    }
    create.mutate({
      name: name.trim(), vacancyId: vacancyId ? Number(vacancyId) : undefined,
      branchId: branchId ? Number(branchId) : undefined, jobTitle: jobTitle.trim() || undefined,
      department: department.trim() || undefined, appliedDate: appliedDate.trim() || undefined,
      phone: phone.trim() || undefined, whatsappPhone: whatsappPhone.trim() || undefined,
      email: email.trim() || undefined, birthDate: birthDate.trim() || undefined,
      gender: (gender || undefined) as never, maritalStatus: (maritalStatus || undefined) as never,
      governorate: governorate.trim() || undefined, district: district.trim() || undefined,
      residentialAddress: residentialAddress.trim() || undefined, degree: (degree || undefined) as never,
      major: major.trim() || undefined, education: education.trim() || undefined,
      availabilityStatus: (availabilityStatus || undefined) as never, experience: experience.trim() || undefined,
      previousEmployer: previousEmployer.trim() || undefined, skills: skills.trim() || undefined,
      preferredBranch: preferredBranch.trim() || undefined, employmentType: (employmentType || undefined) as never,
      shiftPreference: (shiftPreference || undefined) as never, expectedSalary: expectedSalary.trim() || undefined,
      availableFrom: availableFrom.trim() || undefined, portfolioUrl: portfolioUrl.trim() || undefined,
      interviewDate: interviewDate.trim() || undefined, notes: notes.trim() || undefined,
      source, stage: stage as never, rating, cv,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>إدخال استمارة ورقية إلى النظام</DialogTitle></DialogHeader>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          <div className="space-y-1.5"><Label>اسم المتقدّم الرباعي <span className="text-destructive">*</span></Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم الكامل" /></div>
          <div className="space-y-1.5"><Label>الهاتف الأساسي</Label><IntlPhoneInput value={phone} onChange={setPhone} ariaLabel="هاتف المرشح" /></div>
          <div className="space-y-1.5"><Label>رقم واتساب / هاتف بديل</Label><IntlPhoneInput value={whatsappPhone} onChange={setWhatsappPhone} ariaLabel="واتساب المرشح" /></div>
          <div className="space-y-1.5"><Label>البريد الإلكتروني</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" type="email" placeholder="name@example.com" /></div>
          <div className="space-y-1.5"><Label>تاريخ الميلاد</Label><Input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>الجنس</Label><AppSelect className={selectClsSm + " w-full"} value={gender} onValueChange={setGender}><option value="">— اختر —</option>{GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>الحالة الاجتماعية</Label><AppSelect className={selectClsSm + " w-full"} value={maritalStatus} onValueChange={setMaritalStatus}><option value="">— اختر —</option>{MARITAL_STATUSES.map((m) => <option key={m} value={m}>{m}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>المحافظة</Label><AppSelect className={selectClsSm + " w-full"} value={governorate} onValueChange={setGovernorate}><option value="">— اختر المحافظة —</option>{IRAQ_GOVERNORATES.map((g) => <option key={g} value={g}>{g}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>القضاء / المنطقة</Label><Input value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="مثال: الكرادة، الدورة" /></div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3"><Label>عنوان السكن التفصيلي / أقرب نقطة دالة</Label><Input value={residentialAddress} onChange={(e) => setResidentialAddress(e.target.value)} maxLength={300} placeholder="مثال: بغداد — الكرادة — قرب ساحة كهرمانة" autoComplete="street-address" /></div>
          <div className="space-y-1.5"><Label>التحصيل الدراسي</Label><AppSelect className={selectClsSm + " w-full"} value={degree} onValueChange={setDegree}><option value="">— اختر المؤهل —</option>{DEGREES.map((d) => <option key={d} value={d}>{d}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>التخصص الدراسي</Label><Input value={major} onChange={(e) => setMajor(e.target.value)} placeholder="مثال: تصميم كرافيك، محاسبة" /></div>
          <div className="space-y-1.5"><Label>الجامعة / المعهد وسنة التخرج</Label><Input value={education} onChange={(e) => setEducation(e.target.value)} placeholder="مثال: جامعة بغداد — ٢٠٢٢" /></div>
          <div className="space-y-1.5"><Label>حالة التفرّغ الحالية</Label><AppSelect className={selectClsSm + " w-full"} value={availabilityStatus} onValueChange={setAvailabilityStatus}>{APPLICANT_AVAILABILITY_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>سنوات الخبرة</Label><Input value={experience} onChange={(e) => setExperience(e.target.value)} list="rec-exp-levels" placeholder="مثال: ٣ – ٥ سنوات" /><datalist id="rec-exp-levels">{APPLICANT_EXPERIENCE_LEVELS.map((lvl) => <option key={lvl} value={lvl} />)}</datalist></div>
          <div className="space-y-1.5"><Label>آخر جهة عمل / مسمى سابق</Label><Input value={previousEmployer} onChange={(e) => setPreviousEmployer(e.target.value)} placeholder="اسم الشركة أو المطبعة السابقة" /></div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3"><Label>المهارات والبرامج المتقنة</Label><Input value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="مثال: Photoshop, Illustrator, Excel، مبيعات، كاشير" /></div>
          <div className="space-y-1.5"><Label>ربط بوظيفة شاغرة (اختياري)</Label><AppSelect className={selectClsSm + " w-full"} value={vacancyId} onValueChange={(next) => { setVacancyId(next); const found = vacancies.find((v) => String(v.id) === next); if (found) { setJobTitle(found.title.slice(0, 100)); if (found.department) setDepartment(found.department); if (found.employmentType) setEmploymentType(found.employmentType); if (canChooseCompanyWide && found.branchId != null) setBranchId(String(found.branchId)); } }}><option value="">— تقديم عام (بدون شاغر محدد) —</option>{vacancies.map((v) => <option key={v.id} value={String(v.id)}>{v.title}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>الوظيفة المتقدّم لها</Label><Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} maxLength={100} placeholder="مثال: مصمم جرافيك" list="rec-jobs" /><datalist id="rec-jobs">{HR_DEPARTMENTS.map((d) => <option key={d} value={d} />)}</datalist></div>
          <div className="space-y-1.5"><Label>القسم المفضّل</Label><AppSelect className={selectClsSm + " w-full"} value={department} onValueChange={setDepartment}><option value="">— اختر القسم —</option>{HR_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>فرع المتابعة الإدارية</Label><AppSelect className={selectClsSm + " w-full"} value={branchId} onValueChange={setBranchId} disabled={!canChooseCompanyWide}>{canChooseCompanyWide && <option value="">— عام للشركة —</option>}{branches.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>الفرع المفضّل للمتقدّم</Label><AppSelect className={selectClsSm + " w-full"} value={preferredBranch} onValueChange={setPreferredBranch}><option value="">— أي فرع متاح —</option>{APPLICANT_PREFERRED_BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>نوع الدوام</Label><AppSelect className={selectClsSm + " w-full"} value={employmentType} onValueChange={setEmploymentType}>{EMPLOYMENT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>الشفت المفضّل</Label><AppSelect className={selectClsSm + " w-full"} value={shiftPreference} onValueChange={setShiftPreference}>{APPLICANT_SHIFT_PREFERENCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>الراتب الشهري المتوقع (د.ع)</Label><MoneyInput value={expectedSalary} onChange={setExpectedSalary} decimals={0} placeholder="مثال: 600,000" /></div>
          <div className="space-y-1.5"><Label>تاريخ الجاهزية للمباشرة</Label><Input type="date" value={availableFrom} onChange={(e) => setAvailableFrom(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>تاريخ التقديم الورقي</Label><Input type="date" value={appliedDate} onChange={(e) => setAppliedDate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>المصدر</Label><AppSelect className={selectClsSm + " w-full"} value={source} onValueChange={(next) => setSource(next as "paper" | "archive")}><option value="paper">استمارة ورقية</option><option value="archive">أرشيف</option></AppSelect></div>
          <div className="space-y-1.5"><Label>المرحلة</Label><AppSelect className={selectClsSm + " w-full"} value={stage} onValueChange={(next) => setStage(next)}>{APPLICANT_STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</AppSelect></div>
          <div className="space-y-1.5"><Label>موعد المقابلة (اختياري)</Label><Input type="date" value={interviewDate} onChange={(e) => setInterviewDate(e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>الأعمال النموذجية (Portfolio)</Label><Input value={portfolioUrl} onChange={(e) => setPortfolioUrl(e.target.value)} maxLength={500} type="url" dir="ltr" placeholder="https://portfolio.example.com" autoComplete="url" /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>مرفق السيرة الذاتية / الاستمارة الممسوحة (PDF أو DOCX حتى 2MB)</Label><Input type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => selectCv(event.currentTarget.files?.[0], event.currentTarget)} /></div>
          <div className="space-y-1.5">
            <Label>التقييم المبدئي</Label>
            <div className="flex items-center gap-1 pt-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setRating(rating === n ? 0 : n)} className="p-0.5 text-[var(--sem-warn)]" aria-label={`${n} نجوم`}>
                  <Star className="size-5" style={{ fill: n <= rating ? "currentColor" : "transparent" }} />
                </button>
              ))}
              {rating > 0 && <button type="button" className="text-xs text-muted-foreground ms-2" onClick={() => setRating(0)}>مسح</button>}
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3"><Label>ملاحظات الموظف المختص</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="خبرات سابقة، مهارات، انطباع أولي…" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={() => void submit()} disabled={create.isPending || encodingCv}>{create.isPending || encodingCv ? ACTION_LABELS.saving : "حفظ في مسار التوظيف"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
