/**
 * /apply — معرض الوظائف الشاغرة + استمارة التقديم **العامّة** (خارج تخطيط التطبيق، بلا تسجيل دخول).
 *
 * صفحة مكشوفة لأي زائر: واجهة تعريفية سينمائية (بطل + قيم العمل) ثمّ معرض بطاقات
 * للوظائف المنشورة (trpc.recruitment.openVacancies)، والنقر على «قدّم الآن» يفتح نافذة
 * التقديم مربوطةً بالوظيفة (vacancyId) — أو تقديماً عامّاً. الإرسال عبر trpc.recruitment.submit.
 *
 * مستقلّة بتنسيقها كلّياً: <style> داخلي (CSP: style-src unsafe-inline مسموح) + رسوم SVG
 * داخلية وصور data: فقط — بلا أي مورد خارجي ⇒ تعمل دون إنترنت وتتوافق مع سياسة CSP.
 */
import { useMemo, useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { errMsg } from "@/lib/notify";
import { employmentTypeLabel, vacancyAccent } from "@shared/hr";
import { Check } from "lucide-react";

const COMPANY = "الرؤية العربية للتجارة العامة";
const SUBTITLE = "المكتبة العربية للطباعة والقرطاسية";

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
};

/* ============================ الأنماط (مُحقَّنة مرّة) ============================ */
const CSS = `
.cj-root{--ink:#0b0d16;--ink2:#141826;--accent:#5b63f5;--accent2:#8b5cf6;
  min-height:100vh;background:#0b0d16;color:#e9ecf5;direction:rtl;
  font-family:"Cairo",system-ui,sans-serif;overflow-x:hidden}
.cj-root *{box-sizing:border-box}

/* الشريط العلوي */
.cj-nav{position:sticky;top:0;z-index:30;display:flex;align-items:center;justify-content:space-between;
  gap:12px;padding:14px clamp(16px,4vw,48px);
  background:rgba(11,13,22,.72);backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,.07)}
.cj-brand{display:flex;flex-direction:column;line-height:1.3}
.cj-brand b{font-size:clamp(14px,2.4vw,17px);font-weight:900;color:#fff}
.cj-brand span{font-size:11.5px;color:#9aa0b8}

/* الأزرار */
.cj-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;
  font-family:inherit;font-weight:800;font-size:14.5px;border-radius:12px;padding:11px 20px;
  border:1px solid transparent;transition:transform .14s,box-shadow .2s,background .2s,border-color .2s;white-space:nowrap}
.cj-btn:active{transform:translateY(1px)}
.cj-btn-primary{background:linear-gradient(120deg,var(--accent),var(--accent2));color:#fff;
  box-shadow:0 12px 30px -10px rgba(91,99,245,.7)}
.cj-btn-primary:hover{transform:translateY(-2px);box-shadow:0 18px 40px -12px rgba(91,99,245,.85)}
.cj-btn-ghost{background:rgba(255,255,255,.06);color:#e9ecf5;border-color:rgba(255,255,255,.14)}
.cj-btn-ghost:hover{background:rgba(255,255,255,.12)}
.cj-btn-sm{padding:9px 16px;font-size:13.5px;border-radius:10px}

/* البطل */
.cj-hero{position:relative;padding:clamp(56px,9vw,120px) clamp(16px,4vw,48px) clamp(48px,7vw,90px);overflow:hidden}
.cj-hero-bg{position:absolute;inset:0;z-index:0}
.cj-blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.55;animation:cj-float 14s ease-in-out infinite}
.cj-grid-overlay{position:absolute;inset:0;background-image:
  linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),
  linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);
  background-size:46px 46px;mask-image:radial-gradient(ellipse 80% 60% at 50% 30%,#000 30%,transparent 75%)}
.cj-hero-inner{position:relative;z-index:2;max-width:1180px;margin:0 auto;
  display:grid;grid-template-columns:1.15fr .85fr;gap:clamp(24px,4vw,56px);align-items:center}
.cj-eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#c7c9f7;
  background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.32);padding:7px 14px;border-radius:999px;margin-bottom:20px}
.cj-eyebrow i{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.22)}
.cj-h1{font-size:clamp(30px,5.4vw,56px);font-weight:900;line-height:1.18;margin:0;color:#fff;letter-spacing:-.5px}
.cj-h1 em{font-style:normal;background:linear-gradient(120deg,#a78bfa,#60a5fa);-webkit-background-clip:text;
  background-clip:text;color:transparent}
.cj-lead{font-size:clamp(15px,2.3vw,18px);color:#b4b9cc;line-height:2;margin:20px 0 28px;max-width:560px}
.cj-hero-cta{display:flex;flex-wrap:wrap;gap:12px}
.cj-art{position:relative;display:flex;align-items:center;justify-content:center}
.cj-art svg{width:100%;height:auto;max-width:460px;filter:drop-shadow(0 30px 60px rgba(0,0,0,.5))}

/* شريط الأرقام */
.cj-stats{position:relative;z-index:2;max-width:1180px;margin:clamp(40px,6vw,64px) auto 0;
  display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.cj-stat{background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:16px;
  padding:18px 16px;text-align:center}
.cj-stat b{display:block;font-size:clamp(22px,3.4vw,30px);font-weight:900;color:#fff}
.cj-stat span{font-size:12.5px;color:#9aa0b8}

/* الأقسام العامة */
.cj-section{max-width:1180px;margin:0 auto;padding:clamp(48px,7vw,84px) clamp(16px,4vw,48px)}
.cj-shead{text-align:center;margin-bottom:clamp(28px,4vw,44px)}
.cj-shead h2{font-size:clamp(24px,4vw,38px);font-weight:900;color:#fff;margin:0}
.cj-shead p{font-size:14.5px;color:#9aa0b8;margin:12px auto 0;max-width:620px;line-height:1.9}

/* قيم العمل */
.cj-values{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.cj-vcard{background:linear-gradient(170deg,rgba(255,255,255,.06),rgba(255,255,255,.02));
  border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:24px 20px;transition:transform .18s,border-color .18s}
.cj-vcard:hover{transform:translateY(-4px);border-color:rgba(139,92,246,.45)}
.cj-vicon{width:50px;height:50px;border-radius:14px;display:flex;align-items:center;justify-content:center;
  margin-bottom:16px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff}
.cj-vcard h3{font-size:17px;font-weight:800;color:#fff;margin:0 0 8px}
.cj-vcard p{font-size:13.5px;color:#aab0c4;line-height:1.9;margin:0}

/* معرض الوظائف */
.cj-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:20px}
.cj-card{background:#11131f;border:1px solid rgba(255,255,255,.08);border-radius:20px;overflow:hidden;
  display:flex;flex-direction:column;transition:transform .2s,box-shadow .2s,border-color .2s}
.cj-card:hover{transform:translateY(-6px);box-shadow:0 30px 60px -28px rgba(0,0,0,.8);border-color:rgba(255,255,255,.18)}
.cj-media{position:relative;height:172px;overflow:hidden;display:flex;align-items:flex-end}
.cj-media img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cj-media-grad{position:absolute;inset:0}
.cj-media-wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:64px;font-weight:900;color:rgba(255,255,255,.13);user-select:none}
.cj-media-scrim{position:absolute;inset:0;background:linear-gradient(0deg,rgba(8,9,16,.86) 4%,transparent 60%)}
.cj-media-head{position:relative;z-index:2;padding:14px 16px;width:100%}
.cj-dept{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;color:#fff;
  background:rgba(0,0,0,.35);backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,.22);
  padding:5px 11px;border-radius:999px}
.cj-cbody{padding:18px 18px 0;flex:1}
.cj-ctitle{font-size:19px;font-weight:900;color:#fff;margin:0 0 6px;line-height:1.4}
.cj-csum{font-size:13.5px;color:#a6acc0;line-height:1.9;margin:0 0 14px}
.cj-meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px}
.cj-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#c3c8db;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);padding:5px 11px;border-radius:9px}
.cj-cfoot{padding:16px 18px;display:flex;align-items:center;justify-content:space-between;gap:10px;
  border-top:1px solid rgba(255,255,255,.06);margin-top:16px}
.cj-openings{font-size:11.5px;color:#8a90a8}

/* هياكل التحميل */
.cj-skel{background:#11131f;border:1px solid rgba(255,255,255,.06);border-radius:20px;height:340px;
  position:relative;overflow:hidden}
.cj-skel::after{content:"";position:absolute;inset:0;
  background:linear-gradient(100deg,transparent 20%,rgba(255,255,255,.06) 50%,transparent 80%);
  animation:cj-shine 1.3s infinite}

/* حالة فارغة/خطأ */
.cj-empty{text-align:center;background:rgba(255,255,255,.03);border:1px dashed rgba(255,255,255,.14);
  border-radius:20px;padding:48px 24px}
.cj-empty h3{color:#fff;font-size:20px;font-weight:800;margin:14px 0 8px}
.cj-empty p{color:#9aa0b8;font-size:14px;line-height:1.9;margin:0 auto 20px;max-width:440px}

/* التذييل */
.cj-footer{border-top:1px solid rgba(255,255,255,.07);padding:40px clamp(16px,4vw,48px);text-align:center}
.cj-footer b{color:#fff;font-weight:800;font-size:15px}
.cj-footer p{color:#80869c;font-size:12.5px;line-height:2;margin:8px 0 0}

/* نافذة التقديم */
.cj-overlay{position:fixed;inset:0;z-index:60;background:rgba(5,6,12,.74);backdrop-filter:blur(6px);
  display:flex;align-items:flex-start;justify-content:center;padding:24px 14px;overflow-y:auto;animation:cj-fade .2s ease}
.cj-modal{width:min(680px,100%);background:#fff;color:#1b2030;border-radius:20px;overflow:hidden;
  box-shadow:0 40px 100px -30px rgba(0,0,0,.7);animation:cj-pop .24s cubic-bezier(.16,1,.3,1)}
.cj-mhead{padding:22px 24px;color:#fff;position:relative}
.cj-mclose{position:absolute;top:16px;left:16px;width:34px;height:34px;border-radius:10px;border:none;cursor:pointer;
  background:rgba(255,255,255,.18);color:#fff;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center}
.cj-mclose:hover{background:rgba(255,255,255,.3)}
.cj-mhead .k{font-size:12px;opacity:.85;font-weight:600}
.cj-mhead .t{font-size:21px;font-weight:900;margin-top:3px}
.cj-mbody{padding:22px 24px 26px}
.cj-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}
.cj-field{display:flex;flex-direction:column;gap:6px}
.cj-field.full{grid-column:1/-1}
.cj-field label{font-size:13px;font-weight:700;color:#3a4153}
.cj-field label i{color:#dc2626;font-style:normal}
.cj-input{height:44px;border-radius:11px;border:1px solid #d8dce6;background:#fff;padding:0 13px;
  font-family:inherit;font-size:14.5px;color:#1b2030;outline:none;width:100%;transition:border-color .15s,box-shadow .15s}
.cj-input:focus{border-color:#5b63f5;box-shadow:0 0 0 3px rgba(91,99,245,.16)}
textarea.cj-input{height:auto;min-height:96px;padding:11px 13px;resize:vertical;line-height:1.8}
.cj-posbanner{display:flex;align-items:center;gap:12px;background:#f3f4ff;border:1px solid #dfe1fb;
  border-radius:13px;padding:13px 15px;margin-bottom:18px}
.cj-posbanner .ic{width:40px;height:40px;border-radius:11px;flex-shrink:0;display:flex;align-items:center;
  justify-content:center;color:#fff;background:linear-gradient(135deg,#5b63f5,#8b5cf6)}
.cj-posbanner .k{font-size:11.5px;color:#6b7194;font-weight:600}
.cj-posbanner .t{font-size:15px;color:#1b2030;font-weight:800}
.cj-submit{margin-top:20px;width:100%;height:50px;border-radius:13px;border:none;color:#fff;font-family:inherit;
  font-weight:900;font-size:16px;cursor:pointer;background:linear-gradient(120deg,#5b63f5,#8b5cf6);
  box-shadow:0 14px 30px -10px rgba(91,99,245,.6);transition:transform .14s,box-shadow .2s}
.cj-submit:hover:not(:disabled){transform:translateY(-2px)}
.cj-submit:disabled{background:#9aa0b8;cursor:not-allowed;box-shadow:none}
.cj-err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:11px;padding:11px 13px;
  font-size:13.5px;margin-bottom:16px}
.cj-note{font-size:12px;color:#9aa0b8;text-align:center;margin-top:14px;line-height:1.9}
.cj-done{text-align:center;padding:44px 28px}
.cj-done .ring{width:80px;height:80px;margin:0 auto 18px;border-radius:50%;background:#dcfce7;color:#16a34a;
  display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:900}
.cj-done h2{font-size:23px;font-weight:900;margin:0;color:#1b2030}
.cj-done p{font-size:14.5px;color:#5b6275;line-height:2;margin:12px auto 0;max-width:420px}

@keyframes cj-float{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(18px,-26px) scale(1.08)}}
@keyframes cj-shine{0%{transform:translateX(120%)}100%{transform:translateX(-120%)}}
@keyframes cj-fade{from{opacity:0}to{opacity:1}}
@keyframes cj-pop{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}

@media(max-width:860px){
  .cj-hero-inner{grid-template-columns:1fr}
  .cj-art{order:-1;max-width:340px;margin:0 auto}
  .cj-stats{grid-template-columns:repeat(2,1fr)}
  .cj-values{grid-template-columns:repeat(2,1fr)}
}
@media(max-width:520px){
  .cj-form-grid{grid-template-columns:1fr}
  .cj-values{grid-template-columns:1fr}
}
`;

/* ============================ رسم البطل (بيئة العمل: طباعة + قرطاسية + تصميم) ============================ */
function HeroArt() {
  return (
    <svg viewBox="0 0 400 360" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="بيئة العمل">
      <defs>
        <linearGradient id="cj-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" /><stop offset="1" stopColor="#5b63f5" />
        </linearGradient>
        <linearGradient id="cj-g2" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38bdf8" /><stop offset="1" stopColor="#6366f1" />
        </linearGradient>
        <linearGradient id="cj-g3" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fbbf24" /><stop offset="1" stopColor="#f97316" />
        </linearGradient>
      </defs>
      {/* قرص خلفي */}
      <circle cx="205" cy="170" r="150" fill="url(#cj-g1)" opacity=".12" />
      <circle cx="205" cy="170" r="108" stroke="url(#cj-g1)" strokeOpacity=".35" strokeWidth="1.5" strokeDasharray="5 7" />
      {/* آلة الطباعة — أسطوانتان وورقة خارجة */}
      <rect x="92" y="150" width="216" height="78" rx="16" fill="#1c2030" stroke="url(#cj-g2)" strokeOpacity=".5" />
      <circle cx="138" cy="189" r="22" fill="url(#cj-g2)" />
      <circle cx="138" cy="189" r="9" fill="#0b0d16" />
      <circle cx="270" cy="189" r="22" fill="url(#cj-g1)" />
      <circle cx="270" cy="189" r="9" fill="#0b0d16" />
      {/* ورقة مطبوعة تخرج للأعلى */}
      <rect x="170" y="70" width="74" height="96" rx="6" fill="#fff" transform="rotate(-7 207 118)" />
      <rect x="184" y="86" width="46" height="5" rx="2.5" fill="#c7ccdd" transform="rotate(-7 207 118)" />
      <rect x="182" y="100" width="50" height="5" rx="2.5" fill="#dfe3ef" transform="rotate(-7 207 118)" />
      <rect x="186" y="114" width="38" height="5" rx="2.5" fill="#dfe3ef" transform="rotate(-7 207 118)" />
      <rect x="184" y="132" width="30" height="14" rx="3" fill="url(#cj-g3)" transform="rotate(-7 207 118)" />
      {/* قلم/ريشة تصميم */}
      <g transform="rotate(40 312 250)">
        <rect x="300" y="196" width="24" height="92" rx="11" fill="url(#cj-g1)" />
        <path d="M300 288 L312 312 L324 288 Z" fill="#1c2030" />
        <circle cx="312" cy="208" r="5" fill="#fff" opacity=".85" />
      </g>
      {/* مشابك/قرطاسية */}
      <rect x="64" y="250" width="120" height="58" rx="12" fill="#11131f" stroke="url(#cj-g3)" strokeOpacity=".45" />
      <rect x="80" y="266" width="30" height="26" rx="5" fill="url(#cj-g3)" opacity=".9" />
      <rect x="118" y="266" width="48" height="7" rx="3.5" fill="#3a4055" />
      <rect x="118" y="282" width="34" height="7" rx="3.5" fill="#2c3144" />
      {/* بريق */}
      <g fill="#fff">
        <path d="M96 110 l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z" opacity=".8" />
        <path d="M330 130 l2.5 6 6 2.5 -6 2.5 -2.5 6 -2.5 -6 -6 -2.5 6 -2.5z" opacity=".6" />
      </g>
    </svg>
  );
}

/* أيقونات قيم العمل (SVG داخلية، خط حالي) */
const VALUE_ICONS: Record<string, ReactNode> = {
  env: <path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-3M9 9v.01M9 12v.01M9 15v.01M9 18v.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  team: <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  growth: <path d="M23 6l-9.5 9.5-5-5L1 18M17 6h6v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
};

const VALUES = [
  { k: "env", t: "بيئة عمل حديثة", d: "مساحات منظّمة وأدوات وتقنيات حديثة في الطباعة والتصميم والمبيعات." },
  { k: "team", t: "فريق متعاون", d: "ثقافة احترام وتعاون، وزملاء يدعمونك من أول يوم لتنجز عملك بثقة." },
  { k: "growth", t: "فرص نموّ", d: "مسار تطوّر واضح وتدريب مستمر وترقيات تكافئ الجهد والإتقان." },
  { k: "shield", t: "استقرار وأمان", d: "شركة راسخة بفرعين ونشاط متنوّع — استقرار وظيفي ومستحقّات منتظمة." },
] as const;

function ValueIcon({ k }: { k: string }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
      {VALUE_ICONS[k]}
    </svg>
  );
}

/* أيقونات صغيرة للبطاقة/النافذة */
const PinIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="10" r="3" stroke="currentColor" strokeWidth="2" /></svg>
);
const ClockIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" /><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
);
const BriefIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" stroke="currentColor" strokeWidth="1.8" /></svg>
);

/* ============================ بطاقة وظيفة ============================ */
function VacancyCard({ v, onApply }: { v: Vacancy; onApply: () => void }) {
  const ac = vacancyAccent(v.department);
  return (
    <article className="cj-card">
      <div className="cj-media">
        {v.imageUrl ? (
          <img src={v.imageUrl} alt={v.title} loading="lazy" />
        ) : (
          <>
            <div className="cj-media-grad" style={{ background: `linear-gradient(135deg, ${ac.from}, ${ac.to})` }} />
            <div className="cj-media-wm">{(v.department || v.title).slice(0, 2)}</div>
          </>
        )}
        <div className="cj-media-scrim" />
        <div className="cj-media-head">
          {v.department && <span className="cj-dept">{v.department}</span>}
        </div>
      </div>

      <div className="cj-cbody">
        <h3 className="cj-ctitle">{v.title}</h3>
        {v.summary && <p className="cj-csum">{v.summary}</p>}
        <div className="cj-meta">
          <span className="cj-pill"><ClockIcon /> {employmentTypeLabel(v.employmentType)}</span>
          {v.location && <span className="cj-pill"><PinIcon /> {v.location}</span>}
        </div>
      </div>

      <div className="cj-cfoot">
        <span className="cj-openings">{v.openings > 1 ? `${v.openings} شواغر متاحة` : "شاغر واحد"}</span>
        <button className="cj-btn cj-btn-primary cj-btn-sm" onClick={onApply}>قدّم الآن</button>
      </div>
    </article>
  );
}

/* ============================ نافذة التقديم ============================ */
function ApplyModal({ target, onClose }: { target: Vacancy | "general"; onClose: () => void }) {
  const vacancy = target === "general" ? null : target;
  const [name, setName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [experience, setExperience] = useState("");
  const [education, setEducation] = useState("");
  const [notes, setNotes] = useState("");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const apply = trpc.recruitment.submit.useMutation({
    onSuccess: () => setDone(true),
    onError: (e) => setErr(errMsg(e)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) {
      setErr("الاسم مطلوب");
      return;
    }
    apply.mutate({
      name: name.trim(),
      vacancyId: vacancy?.id,
      jobTitle: vacancy ? undefined : jobTitle.trim() || undefined,
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      experience: experience.trim() || undefined,
      education: education.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  }

  const headBg = vacancy
    ? (() => { const a = vacancyAccent(vacancy.department); return `linear-gradient(120deg, ${a.from}, ${a.to})`; })()
    : "linear-gradient(120deg,#5b63f5,#8b5cf6)";

  return (
    <div className="cj-overlay" onClick={onClose}>
      <div className="cj-modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="cj-mhead" style={{ background: headBg }}>
          <button className="cj-mclose" onClick={onClose} aria-label="إغلاق">×</button>
          <div className="k">التقديم على وظيفة</div>
          <div className="t">{vacancy ? vacancy.title : "تقديم عام"}</div>
        </div>

        {done ? (
          <div className="cj-done">
            <div className="ring"><Check aria-hidden className="size-4" /></div>
            <h2>شكراً لتقديمك</h2>
            <p>
              وصلنا طلبك بنجاح{vacancy ? ` على وظيفة «${vacancy.title}»` : ""}. سيراجعه فريق الموارد البشرية
              في {COMPANY}، وسنتواصل معك إن كنت مناسباً.
            </p>
            <button className="cj-btn cj-btn-ghost" style={{ marginTop: 22, color: "#3a4153", borderColor: "#d8dce6", background: "#fff" }} onClick={onClose}>
              إغلاق
            </button>
          </div>
        ) : (
          <form className="cj-mbody" onSubmit={submit}>
            {vacancy && (
              <div className="cj-posbanner">
                <div className="ic"><BriefIcon /></div>
                <div>
                  <div className="k">تتقدّم على</div>
                  <div className="t">{vacancy.title}{vacancy.department ? ` — ${vacancy.department}` : ""}</div>
                </div>
              </div>
            )}
            {err && <div className="cj-err">{err}</div>}

            <div className="cj-form-grid">
              <div className="cj-field full">
                <label>الاسم الثلاثي واللقب <i>*</i></label>
                <input className="cj-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم الكامل" />
              </div>
              {!vacancy && (
                <div className="cj-field full">
                  <label>الوظيفة المطلوبة</label>
                  <input className="cj-input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="مثال: مصمم جرافيك" />
                </div>
              )}
              <div className="cj-field">
                <label>رقم الهاتف</label>
                <input className="cj-input" style={{ direction: "ltr", textAlign: "right" }} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XX ..." inputMode="tel" />
              </div>
              <div className="cj-field">
                <label>البريد الإلكتروني</label>
                <input className="cj-input" style={{ direction: "ltr", textAlign: "right" }} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
              </div>
              <div className="cj-field">
                <label>سنوات الخبرة</label>
                <input className="cj-input" value={experience} onChange={(e) => setExperience(e.target.value)} placeholder="مثال: ٣ سنوات" />
              </div>
              <div className="cj-field">
                <label>أعلى مؤهل دراسي</label>
                <input className="cj-input" value={education} onChange={(e) => setEducation(e.target.value)} placeholder="مثال: بكالوريوس" />
              </div>
              <div className="cj-field full">
                <label>نبذة / ملاحظات</label>
                <textarea className="cj-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="خبرات سابقة، مهارات، أي معلومة تودّ إضافتها…" />
              </div>
            </div>

            <button type="submit" className="cj-submit" disabled={apply.isPending}>
              {apply.isPending ? "جارٍ الإرسال…" : "إرسال الطلب"}
            </button>
            <p className="cj-note">ستُستخدم بياناتك لغرض التوظيف فقط. الحقول التي عليها <i style={{ color: "#dc2626", fontStyle: "normal" }}>*</i> إلزامية.</p>
          </form>
        )}
      </div>
    </div>
  );
}

/* ============================ الصفحة ============================ */
export default function JobApply() {
  const q = trpc.recruitment.openVacancies.useQuery(undefined, { staleTime: 60_000 });
  const vacancies = (q.data ?? []) as Vacancy[];
  const [target, setTarget] = useState<Vacancy | "general" | null>(null);

  const stats = useMemo(
    () => [
      { b: "٢", s: "فرعان في الخدمة" },
      { b: String(vacancies.length || "—"), s: "وظائف مفتوحة الآن" },
      { b: "٧+", s: "أقسام وتخصّصات" },
      { b: "IQD", s: "رواتب منتظمة" },
    ],
    [vacancies.length],
  );

  function scrollToJobs() {
    document.getElementById("cj-jobs")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="cj-root">
      <style>{CSS}</style>

      {/* الشريط العلوي */}
      <nav className="cj-nav">
        <div className="cj-brand">
          <b>{COMPANY}</b>
          <span>{SUBTITLE}</span>
        </div>
        <button className="cj-btn cj-btn-primary cj-btn-sm" onClick={() => setTarget("general")}>تقديم عام</button>
      </nav>

      {/* البطل */}
      <header className="cj-hero">
        <div className="cj-hero-bg" aria-hidden>
          <div className="cj-blob" style={{ width: 360, height: 360, background: "#5b63f5", top: -90, right: -60 }} />
          <div className="cj-blob" style={{ width: 300, height: 300, background: "#8b5cf6", bottom: -110, left: -40, animationDelay: "3s" }} />
          <div className="cj-blob" style={{ width: 220, height: 220, background: "#0ea5e9", top: 120, left: "32%", animationDelay: "6s", opacity: .35 }} />
          <div className="cj-grid-overlay" />
        </div>

        <div className="cj-hero-inner">
          <div>
            <span className="cj-eyebrow"><i />نوظّف الآن — انضمّ إلينا</span>
            <h1 className="cj-h1">ابنِ مستقبلك المهني مع <em>الرؤية العربية</em></h1>
            <p className="cj-lead">
              نحن مطبعة ومكتبة قرطاسية رائدة بفرعين ونشاطٍ متنوّع — طباعة، تصميم، مبيعات، وتجهيزات مكتبية.
              إن كنت تبحث عن بيئة عمل محترمة وفرصة نموٍّ حقيقية، فمكانك بيننا.
            </p>
            <div className="cj-hero-cta">
              <button className="cj-btn cj-btn-primary" onClick={scrollToJobs}>تصفّح الوظائف الشاغرة</button>
              <button className="cj-btn cj-btn-ghost" onClick={() => setTarget("general")}>تقديم عام بلا وظيفة محدّدة</button>
            </div>
          </div>
          <div className="cj-art"><HeroArt /></div>
        </div>

        <div className="cj-stats">
          {stats.map((s, i) => (
            <div className="cj-stat" key={i}>
              <b>{s.b}</b>
              <span>{s.s}</span>
            </div>
          ))}
        </div>
      </header>

      {/* لماذا تعمل معنا */}
      <section className="cj-section">
        <div className="cj-shead">
          <h2>لماذا تعمل معنا؟</h2>
          <p>نحرص على بيئة عمل تجمع بين الاحتراف والاحترام، وتمنحك أدوات النجاح وفرص التطوّر.</p>
        </div>
        <div className="cj-values">
          {VALUES.map((v) => (
            <div className="cj-vcard" key={v.k}>
              <div className="cj-vicon"><ValueIcon k={v.k} /></div>
              <h3>{v.t}</h3>
              <p>{v.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* معرض الوظائف */}
      <section className="cj-section" id="cj-jobs">
        <div className="cj-shead">
          <h2>الوظائف الشاغرة</h2>
          <p>اختر الوظيفة التي تناسب خبرتك وقدّم عليها مباشرة — أو أرسل تقديماً عامّاً ونحتفظ ببياناتك.</p>
        </div>

        {q.isLoading ? (
          <div className="cj-grid">
            {Array.from({ length: 3 }, (_, i) => <div className="cj-skel" key={i} />)}
          </div>
        ) : q.isError ? (
          <div className="cj-empty">
            <h3>تعذّر تحميل الوظائف</h3>
            <p>حدث خطأ أثناء جلب الوظائف الشاغرة. حاول تحديث الصفحة.</p>
            <button className="cj-btn cj-btn-ghost" onClick={() => q.refetch()}>إعادة المحاولة</button>
          </div>
        ) : vacancies.length === 0 ? (
          <div className="cj-empty">
            <div className="cj-vicon" style={{ margin: "0 auto" }}><BriefIcon /></div>
            <h3>لا توجد وظائف منشورة حالياً</h3>
            <p>لا توجد شواغر معلنة في الوقت الحالي، لكن يمكنك إرسال تقديم عام ونتواصل معك حين تتوفّر فرصة مناسبة.</p>
            <button className="cj-btn cj-btn-primary" onClick={() => setTarget("general")}>إرسال تقديم عام</button>
          </div>
        ) : (
          <div className="cj-grid">
            {vacancies.map((v) => (
              <VacancyCard key={v.id} v={v} onApply={() => setTarget(v)} />
            ))}
          </div>
        )}
      </section>

      {/* التذييل */}
      <footer className="cj-footer">
        <b>{COMPANY}</b>
        <p>
          {SUBTITLE} — العراق · فرع رئيسي وفرع مبيعات<br />
          نوفّر فرصاً متكافئة لجميع المتقدّمين. ستُعامَل بياناتك بسرّية ولغرض التوظيف فقط.
        </p>
      </footer>

      {target && <ApplyModal target={target} onClose={() => setTarget(null)} />}
    </div>
  );
}
