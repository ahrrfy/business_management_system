/**
 * /apply — معرض الوظائف الشاغرة + استمارة التقديم **العامّة** (خارج تخطيط التطبيق، بلا تسجيل دخول).
 *
 * هوية بصرية احترافية لـ«مطبعة + مكتبة قرطاسية»: خلفية ورقية فاتحة، حبر كحلي عميق، ولمسة
 * نحاسية/كهرمانية تعبّر عن جودة الطباعة والإتقان — تصميم تحريري بسيط وواضح وجذّاب، بعيداً عن
 * المظهر «التقني العام». تفاعلية راقية: كشف العناصر عند التمرير + عدّ تصاعدي للأرقام + لمسات hover.
 *
 * مستقلّة بتنسيقها كلّياً: <style> داخلي (CSP: style-src unsafe-inline) + رسوم SVG داخلية فقط —
 * بلا أي مورد خارجي ⇒ تعمل دون إنترنت وتتوافق مع CSP. الحركة تُحترِم prefers-reduced-motion.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { errMsg } from "@/lib/notify";
import { employmentTypeLabel } from "@shared/hr";
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
.cj-root{
  --paper:#f7f4ee;--surface:#ffffff;--ink:#15243d;--ink2:#26344c;--muted:#67718a;
  --accent:#bf8a30;--accent-d:#9c6f1f;--accent-soft:#f4ead4;--line:#e8e2d5;--ok:#1f8a5b;
  min-height:100vh;background:var(--paper);color:var(--ink);direction:rtl;
  font-family:"Cairo",system-ui,sans-serif;overflow-x:hidden;-webkit-font-smoothing:antialiased}
.cj-root *{box-sizing:border-box}
.cj-wrap{max-width:1160px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}

/* الشريط العلوي */
.cj-nav{position:sticky;top:0;z-index:40;background:rgba(247,244,238,.86);backdrop-filter:blur(10px);
  border-bottom:1px solid var(--line)}
.cj-nav-in{display:flex;align-items:center;justify-content:space-between;gap:14px;height:68px}
.cj-brand{display:flex;align-items:center;gap:12px;min-width:0}
.cj-logo{width:46px;height:46px;border-radius:13px;flex-shrink:0;display:grid;place-items:center;
  background:var(--ink);color:#fff;font-weight:900;font-size:18px;letter-spacing:-1px;
  box-shadow:inset 0 0 0 2px rgba(191,138,48,.55)}
.cj-bt{display:flex;flex-direction:column;line-height:1.25;min-width:0}
.cj-bt b{font-size:15px;font-weight:900;color:var(--ink);white-space:nowrap}
.cj-bt span{font-size:11.5px;color:var(--muted)}
.cj-nav-links{display:flex;align-items:center;gap:6px}
.cj-nlink{font-size:14px;font-weight:700;color:var(--ink2);padding:9px 12px;border-radius:9px;
  text-decoration:none;transition:background .15s,color .15s}
.cj-nlink:hover{background:#efe9dc;color:var(--ink)}

/* الأزرار */
.cj-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;min-height:44px;
  font-family:inherit;font-weight:800;font-size:14.5px;border-radius:12px;padding:0 20px;
  border:1.5px solid transparent;transition:transform .14s ease,background .18s,border-color .18s,color .18s}
.cj-btn:active{transform:translateY(1px)}
.cj-btn:focus-visible{outline:3px solid rgba(191,138,48,.4);outline-offset:2px}
.cj-btn-primary{background:var(--ink);color:#fff}
.cj-btn-primary:hover{background:#0f1b30;transform:translateY(-2px)}
.cj-btn-accent{background:var(--accent);color:#fff}
.cj-btn-accent:hover{background:var(--accent-d);transform:translateY(-2px)}
.cj-btn-out{background:transparent;color:var(--ink);border-color:var(--line)}
.cj-btn-out:hover{border-color:var(--ink);background:#fff}
.cj-btn-sm{min-height:40px;padding:0 16px;font-size:13.5px;border-radius:10px}

/* البطل */
.cj-hero{position:relative;padding:clamp(40px,7vw,80px) 0 clamp(36px,5vw,64px);overflow:hidden}
.cj-hero::before{content:"";position:absolute;inset:0;z-index:0;opacity:.5;
  background-image:radial-gradient(var(--line) 1.2px,transparent 1.2px);background-size:22px 22px;
  -webkit-mask-image:radial-gradient(ellipse 70% 60% at 70% 25%,#000,transparent 72%);
  mask-image:radial-gradient(ellipse 70% 60% at 70% 25%,#000,transparent 72%)}
.cj-hero-in{position:relative;z-index:1;display:grid;grid-template-columns:1.08fr .92fr;
  gap:clamp(24px,4vw,56px);align-items:center}
.cj-eyebrow{display:inline-flex;align-items:center;gap:9px;font-size:13px;font-weight:800;color:var(--accent-d);
  background:var(--accent-soft);padding:8px 15px;border-radius:999px}
.cj-eyebrow i{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px rgba(31,138,91,.18);
  animation:cj-pulse 2.4s ease-in-out infinite}
.cj-h1{font-size:clamp(31px,5.2vw,54px);font-weight:900;line-height:1.16;margin:20px 0 0;
  color:var(--ink);letter-spacing:-.6px}
.cj-h1 em{font-style:normal;position:relative;color:var(--accent-d);white-space:nowrap}
.cj-h1 em::after{content:"";position:absolute;right:0;left:0;bottom:.06em;height:.16em;border-radius:4px;
  background:rgba(191,138,48,.28)}
.cj-lead{font-size:clamp(15px,2.2vw,17.5px);color:var(--ink2);line-height:2;margin:20px 0 26px;max-width:560px}
.cj-cta{display:flex;flex-wrap:wrap;gap:12px}
.cj-trust{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:26px;padding-top:22px;border-top:1px dashed var(--line)}
.cj-trust div{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;color:var(--ink2)}
.cj-trust svg{color:var(--accent-d);flex-shrink:0}

/* لوحة البطل البصرية */
.cj-art{position:relative}
.cj-art-card{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:22px;
  box-shadow:0 30px 60px -34px rgba(21,36,61,.32)}
.cj-art svg{display:block;width:100%;height:auto}
.cj-badge{position:absolute;bottom:-16px;right:-10px;background:var(--ink);color:#fff;border-radius:15px;
  padding:13px 17px;display:flex;align-items:center;gap:11px;box-shadow:0 18px 36px -16px rgba(21,36,61,.55)}
.cj-badge .n{font-size:24px;font-weight:900;line-height:1;color:#fff}
.cj-badge .l{font-size:11.5px;color:#c9d2e2;line-height:1.4}
.cj-badge .sep{width:1px;height:30px;background:rgba(255,255,255,.18)}
.cj-badge .a{color:var(--accent)}

/* شريط الأرقام (حبر) */
.cj-stats{background:var(--ink);color:#fff;position:relative;overflow:hidden}
.cj-stats::after{content:"";position:absolute;inset:0;opacity:.5;
  background-image:radial-gradient(rgba(255,255,255,.05) 1px,transparent 1px);background-size:22px 22px}
.cj-stats-in{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:18px;
  padding:clamp(28px,4vw,40px) 0}
.cj-stat{text-align:center;position:relative}
.cj-stat+.cj-stat::before{content:"";position:absolute;right:-9px;top:50%;transform:translateY(-50%);
  width:1px;height:42px;background:rgba(255,255,255,.12)}
.cj-stat b{display:block;font-size:clamp(26px,3.6vw,38px);font-weight:900;color:#fff;font-variant-numeric:tabular-nums}
.cj-stat b .a{color:var(--accent)}
.cj-stat span{font-size:12.5px;color:#aeb8ca;font-weight:600}

/* أقسام */
.cj-section{padding:clamp(46px,6vw,80px) 0}
.cj-section.alt{background:var(--surface);border-block:1px solid var(--line)}
.cj-shead{max-width:640px;margin:0 auto clamp(28px,4vw,44px);text-align:center}
.cj-kicker{display:inline-block;font-size:12.5px;font-weight:800;letter-spacing:.5px;color:var(--accent-d);
  text-transform:uppercase;margin-bottom:10px}
.cj-shead h2{font-size:clamp(24px,3.6vw,36px);font-weight:900;color:var(--ink);margin:0;letter-spacing:-.4px}
.cj-shead p{font-size:14.5px;color:var(--muted);margin:12px auto 0;line-height:1.95}

/* قيم العمل */
.cj-values{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.cj-vcard{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:24px 20px;
  transition:transform .2s ease,border-color .2s,box-shadow .2s}
.cj-vcard:hover{transform:translateY(-5px);border-color:var(--accent);box-shadow:0 24px 44px -28px rgba(21,36,61,.3)}
.cj-vicon{width:48px;height:48px;border-radius:13px;display:grid;place-items:center;margin-bottom:16px;
  background:var(--accent-soft);color:var(--accent-d)}
.cj-vcard h3{font-size:16.5px;font-weight:800;color:var(--ink);margin:0 0 8px}
.cj-vcard p{font-size:13.5px;color:var(--muted);line-height:1.95;margin:0}

/* كيف تتقدّم */
.cj-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.cj-step{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:24px 22px}
.cj-step .num{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font-weight:900;
  font-size:16px;background:var(--ink);color:#fff;margin-bottom:14px}
.cj-step h3{font-size:16px;font-weight:800;color:var(--ink);margin:0 0 7px}
.cj-step p{font-size:13.5px;color:var(--muted);line-height:1.9;margin:0}

/* معرض الوظائف */
.cj-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px}
.cj-card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:0;
  display:flex;flex-direction:column;overflow:hidden;transition:transform .2s ease,box-shadow .2s,border-color .2s}
.cj-card:hover{transform:translateY(-5px);box-shadow:0 28px 52px -30px rgba(21,36,61,.34);border-color:#d8d0bf}
.cj-card-top{height:5px;background:var(--accent)}
.cj-card-img{height:158px;background:var(--accent-soft);position:relative;overflow:hidden}
.cj-card-img img{width:100%;height:100%;object-fit:cover;display:block}
.cj-cbody{padding:20px 20px 0;flex:1}
.cj-dept{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:800;color:var(--accent-d);
  background:var(--accent-soft);padding:5px 11px;border-radius:8px;margin-bottom:12px}
.cj-dept i{width:6px;height:6px;border-radius:50%;background:var(--accent)}
.cj-ctitle{font-size:19px;font-weight:900;color:var(--ink);margin:0 0 7px;line-height:1.4}
.cj-csum{font-size:13.5px;color:var(--muted);line-height:1.9;margin:0 0 14px}
.cj-meta{display:flex;flex-wrap:wrap;gap:8px}
.cj-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--ink2);
  background:var(--paper);border:1px solid var(--line);padding:5px 11px;border-radius:8px}
.cj-pill svg{color:var(--muted)}
.cj-cfoot{padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:10px;
  border-top:1px solid var(--line);margin-top:18px}
.cj-openings{font-size:12px;font-weight:700;color:var(--muted)}

/* تحميل/فارغ */
.cj-skel{background:var(--surface);border:1px solid var(--line);border-radius:18px;height:300px;position:relative;overflow:hidden}
.cj-skel::after{content:"";position:absolute;inset:0;
  background:linear-gradient(100deg,transparent 20%,rgba(21,36,61,.05) 50%,transparent 80%);animation:cj-shine 1.4s infinite}
.cj-empty{text-align:center;background:var(--surface);border:1px dashed var(--line);border-radius:20px;padding:48px 24px;max-width:520px;margin:0 auto}
.cj-empty .ei{width:56px;height:56px;border-radius:15px;margin:0 auto 16px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-d)}
.cj-empty h3{color:var(--ink);font-size:20px;font-weight:800;margin:0 0 8px}
.cj-empty p{color:var(--muted);font-size:14px;line-height:1.9;margin:0 auto 20px;max-width:420px}

/* تذييل */
.cj-footer{background:var(--ink);color:#fff;padding:clamp(34px,4vw,48px) 0 30px}
.cj-foot-in{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:18px}
.cj-foot-brand{display:flex;align-items:center;gap:12px}
.cj-foot-brand .cj-logo{box-shadow:inset 0 0 0 2px rgba(191,138,48,.6)}
.cj-foot-brand b{color:#fff;font-size:15px;font-weight:900}
.cj-foot-brand span{color:#aeb8ca;font-size:12px}
.cj-foot-note{color:#9aa6bc;font-size:12.5px;line-height:1.95;max-width:430px;text-align:start}

/* نافذة التقديم */
.cj-overlay{position:fixed;inset:0;z-index:80;background:rgba(15,23,38,.55);backdrop-filter:blur(4px);
  display:flex;align-items:flex-start;justify-content:center;padding:24px 14px;overflow-y:auto;animation:cj-fade .2s ease}
.cj-modal{width:min(660px,100%);background:var(--surface);color:var(--ink);border-radius:20px;overflow:hidden;
  box-shadow:0 40px 90px -30px rgba(15,23,38,.6);animation:cj-pop .26s cubic-bezier(.16,1,.3,1)}
.cj-mhead{padding:22px 24px;background:var(--ink);color:#fff;position:relative;
  border-bottom:3px solid var(--accent)}
.cj-mclose{position:absolute;top:16px;left:16px;width:36px;height:36px;border-radius:10px;border:none;cursor:pointer;
  background:rgba(255,255,255,.14);color:#fff;font-size:20px;line-height:1;display:grid;place-items:center;transition:background .15s}
.cj-mclose:hover{background:rgba(255,255,255,.26)}
.cj-mhead .k{font-size:12px;color:#c9d2e2;font-weight:700}
.cj-mhead .t{font-size:21px;font-weight:900;margin-top:3px;color:#fff}
.cj-mbody{padding:22px 24px 26px}
.cj-posbanner{display:flex;align-items:center;gap:12px;background:var(--accent-soft);border:1px solid #ead9b8;
  border-radius:13px;padding:13px 15px;margin-bottom:18px}
.cj-posbanner .ic{width:42px;height:42px;border-radius:12px;flex-shrink:0;display:grid;place-items:center;
  color:#fff;background:var(--accent)}
.cj-posbanner .k{font-size:11.5px;color:var(--accent-d);font-weight:700}
.cj-posbanner .t{font-size:15px;color:var(--ink);font-weight:800}
.cj-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}
.cj-field{display:flex;flex-direction:column;gap:6px}
.cj-field.full{grid-column:1/-1}
.cj-field label{font-size:13px;font-weight:700;color:var(--ink2)}
.cj-field label i{color:#c0392b;font-style:normal}
.cj-input{height:46px;border-radius:11px;border:1.5px solid var(--line);background:#fff;padding:0 13px;
  font-family:inherit;font-size:14.5px;color:var(--ink);outline:none;width:100%;transition:border-color .15s,box-shadow .15s}
.cj-input::placeholder{color:#a6acbd}
.cj-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(191,138,48,.16)}
textarea.cj-input{height:auto;min-height:96px;padding:11px 13px;resize:vertical;line-height:1.8}
.cj-submit{margin-top:20px;width:100%;min-height:52px;border-radius:13px;border:none;color:#fff;font-family:inherit;
  font-weight:900;font-size:16px;cursor:pointer;background:var(--ink);transition:background .16s,transform .14s}
.cj-submit:hover:not(:disabled){background:#0f1b30;transform:translateY(-2px)}
.cj-submit:disabled{background:#aab2c1;cursor:not-allowed}
.cj-err{background:#fdecea;border:1px solid #f5c6c0;color:#a02f23;border-radius:11px;padding:11px 13px;font-size:13.5px;margin-bottom:16px}
.cj-note{font-size:12px;color:var(--muted);text-align:center;margin-top:14px;line-height:1.9}
.cj-done{text-align:center;padding:44px 28px}
.cj-done .ring{width:78px;height:78px;margin:0 auto 18px;border-radius:50%;background:#dcf3e6;color:var(--ok);
  display:grid;place-items:center;animation:cj-pop .4s .05s both cubic-bezier(.16,1,.3,1)}
.cj-done h2{font-size:23px;font-weight:900;margin:0;color:var(--ink)}
.cj-done p{font-size:14.5px;color:var(--ink2);line-height:2;margin:12px auto 0;max-width:430px}

/* كشف عند التمرير */
.reveal{opacity:0;transform:translateY(22px);transition:opacity .6s ease,transform .6s cubic-bezier(.16,1,.3,1)}
.reveal.in{opacity:1;transform:none}

@keyframes cj-pulse{0%,100%{box-shadow:0 0 0 4px rgba(31,138,91,.18)}50%{box-shadow:0 0 0 7px rgba(31,138,91,.05)}}
@keyframes cj-shine{0%{transform:translateX(120%)}100%{transform:translateX(-120%)}}
@keyframes cj-fade{from{opacity:0}to{opacity:1}}
@keyframes cj-pop{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}

@media(max-width:880px){
  .cj-hero-in{grid-template-columns:1fr}
  .cj-art{order:-1;max-width:420px;margin:0 auto;width:100%}
  .cj-nav-links a.cj-nlink{display:none}
  .cj-stats-in{grid-template-columns:repeat(2,1fr);gap:24px 12px}
  .cj-stat:nth-child(3)::before,.cj-stat+.cj-stat::before{display:none}
  .cj-values{grid-template-columns:repeat(2,1fr)}
  .cj-steps{grid-template-columns:1fr}
}
@media(max-width:520px){
  .cj-form-grid{grid-template-columns:1fr}
  .cj-values{grid-template-columns:1fr}
  .cj-bt span{display:none}
}
@media(prefers-reduced-motion:reduce){
  .reveal{opacity:1;transform:none;transition:none}
  .cj-eyebrow i,.cj-skel::after{animation:none}
  .cj-btn:hover,.cj-vcard:hover,.cj-card:hover{transform:none}
}
`;

/* ============================ رسم البطل (مطبعة/قرطاسية — مسطّح، بهوية الحبر + الكهرماني) ============================ */
function HeroArt() {
  return (
    <svg viewBox="0 0 420 300" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="بيئة عمل الطباعة والقرطاسية">
      {/* مكتب */}
      <rect x="20" y="232" width="380" height="14" rx="7" fill="#e8e2d5" />
      {/* ورقة مطبوعة خلفية */}
      <g transform="rotate(-6 150 120)">
        <rect x="96" y="44" width="128" height="170" rx="10" fill="#fff" stroke="#e8e2d5" />
        <rect x="116" y="68" width="74" height="9" rx="4.5" fill="#15243d" />
        <rect x="116" y="90" width="88" height="6" rx="3" fill="#cfd6e2" />
        <rect x="116" y="104" width="80" height="6" rx="3" fill="#cfd6e2" />
        <rect x="116" y="118" width="86" height="6" rx="3" fill="#cfd6e2" />
        <rect x="116" y="150" width="44" height="22" rx="5" fill="#f4ead4" />
        <rect x="124" y="158" width="28" height="6" rx="3" fill="#bf8a30" />
      </g>
      {/* آلة طباعة مبسّطة */}
      <rect x="210" y="120" width="176" height="96" rx="18" fill="#15243d" />
      <rect x="210" y="120" width="176" height="96" rx="18" stroke="#26344c" />
      <rect x="232" y="150" width="132" height="38" rx="10" fill="#0f1b30" />
      <circle cx="252" cy="169" r="9" fill="#bf8a30" />
      <rect x="272" y="164" width="78" height="5" rx="2.5" fill="#3a4658" />
      <rect x="272" y="176" width="56" height="5" rx="2.5" fill="#2a374e" />
      <rect x="300" y="104" width="42" height="26" rx="6" fill="#fff" stroke="#e8e2d5" />
      <rect x="308" y="113" width="26" height="3.5" rx="2" fill="#cfd6e2" />
      {/* قلم/ريشة */}
      <g transform="rotate(38 86 196)">
        <rect x="74" y="150" width="22" height="86" rx="11" fill="#bf8a30" />
        <rect x="74" y="150" width="22" height="20" rx="11" fill="#9c6f1f" />
        <path d="M74 236 L85 258 L96 236 Z" fill="#15243d" />
        <circle cx="85" cy="162" r="4" fill="#fff" opacity=".9" />
      </g>
      {/* علامة الجودة */}
      <circle cx="350" cy="86" r="22" fill="#f4ead4" stroke="#bf8a30" strokeWidth="1.5" />
      <path d="M341 86 l6 6 12 -13" stroke="#9c6f1f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/* أيقونات قيم العمل */
const VALUE_ICONS: Record<string, ReactNode> = {
  env: <path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-3M9 9v.01M9 12v.01M9 15v.01M9 18v.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  team: <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  growth: <path d="M23 6l-9.5 9.5-5-5L1 18M17 6h6v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
};
const VALUES = [
  { k: "env", t: "بيئة عمل حديثة", d: "مساحات منظّمة وأدوات وتقنيات حديثة في الطباعة والتصميم والمبيعات." },
  { k: "team", t: "فريق متعاون", d: "ثقافة احترام وتعاون، وزملاء يدعمونك من أوّل يوم لتنجز عملك بثقة." },
  { k: "growth", t: "فرص نموّ", d: "مسار تطوّر واضح وتدريب مستمر وترقيات تكافئ الجهد والإتقان." },
  { k: "shield", t: "استقرار وأمان", d: "شركة راسخة بفرعين ونشاط متنوّع — استقرار وظيفي ومستحقّات منتظمة." },
] as const;

const STEPS = [
  { t: "اختر وظيفتك", d: "تصفّح الشواغر المنشورة واختر ما يناسب خبرتك وتخصّصك، أو أرسل تقديماً عامّاً." },
  { t: "املأ الاستمارة", d: "بيانات مختصرة وواضحة — اسمك ووسيلة تواصلك وخبرتك. دقائق معدودة لا أكثر." },
  { t: "نتواصل معك", d: "يراجع فريق الموارد البشرية طلبك، ونتّصل بك لإكمال المقابلة إن كنت مناسباً." },
] as const;

function ValueIcon({ k }: { k: string }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>{VALUE_ICONS[k]}</svg>;
}

/* أيقونات صغيرة */
const PinIcon = () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="10" r="3" stroke="currentColor" strokeWidth="2" /></svg>);
const ClockIcon = () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" /><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>);
const BriefIcon = () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" stroke="currentColor" strokeWidth="1.8" /></svg>);
const SparkIcon = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M12 3v4M12 17v4M5 12H1M23 12h-4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>);
const BranchIcon = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M3 21h18M5 21V8l7-4 7 4v13M9 21v-5h6v5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>);
const WalletIcon = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden><rect x="3" y="6" width="18" height="13" rx="3" stroke="currentColor" strokeWidth="1.9" /><path d="M16 12h3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>);

/* عدّ تصاعدي عند الظهور (يحترم reduced-motion) */
function useCountUp(end: number, run: boolean, dur = 1100) {
  const [val, setVal] = useState(run ? 0 : end);
  useEffect(() => {
    if (!run) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setVal(end); return; }
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setVal(Math.round((1 - Math.pow(1 - p, 3)) * end));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run, end, dur]);
  return val;
}

const ar = (n: number) => n.toLocaleString("ar-IQ-u-nu-latn");

/* ============================ بطاقة وظيفة ============================ */
function VacancyCard({ v, onApply }: { v: Vacancy; onApply: () => void }) {
  return (
    <article className="cj-card reveal">
      <div className="cj-card-top" />
      {v.imageUrl && (
        <div className="cj-card-img"><img src={v.imageUrl} alt={v.title} loading="lazy" /></div>
      )}
      <div className="cj-cbody">
        {v.department && <span className="cj-dept"><i />{v.department}</span>}
        <h3 className="cj-ctitle">{v.title}</h3>
        {v.summary && <p className="cj-csum">{v.summary}</p>}
        <div className="cj-meta">
          <span className="cj-pill"><ClockIcon /> {employmentTypeLabel(v.employmentType)}</span>
          {v.location && <span className="cj-pill"><PinIcon /> {v.location}</span>}
        </div>
      </div>
      <div className="cj-cfoot">
        <span className="cj-openings">{v.openings > 1 ? `${ar(v.openings)} شواغر متاحة` : "شاغر واحد"}</span>
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

  // إغلاق بـEsc + منع تمرير الخلفية أثناء فتح النافذة.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const apply = trpc.recruitment.submit.useMutation({
    onSuccess: () => setDone(true),
    onError: (e) => setErr(errMsg(e)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) { setErr("الاسم مطلوب"); return; }
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

  return (
    <div className="cj-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="استمارة التقديم">
      <div className="cj-modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="cj-mhead">
          <button className="cj-mclose" onClick={onClose} aria-label="إغلاق">×</button>
          <div className="k">التقديم على وظيفة</div>
          <div className="t">{vacancy ? vacancy.title : "تقديم عام"}</div>
        </div>

        {done ? (
          <div className="cj-done">
            <div className="ring"><Check aria-hidden size={40} /></div>
            <h2>شكراً لتقديمك</h2>
            <p>
              وصلنا طلبك بنجاح{vacancy ? ` على وظيفة «${vacancy.title}»` : ""}. سيراجعه فريق الموارد البشرية
              في {COMPANY}، وسنتواصل معك إن كنت مناسباً.
            </p>
            <button className="cj-btn cj-btn-out" style={{ marginTop: 22 }} onClick={onClose}>إغلاق</button>
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
                <label htmlFor="cj-name">الاسم الثلاثي واللقب <i>*</i></label>
                <input id="cj-name" className="cj-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم الكامل" autoComplete="name" />
              </div>
              {!vacancy && (
                <div className="cj-field full">
                  <label htmlFor="cj-job">الوظيفة المطلوبة</label>
                  <input id="cj-job" className="cj-input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="مثال: مصمم جرافيك" />
                </div>
              )}
              <div className="cj-field">
                <label htmlFor="cj-phone">رقم الهاتف</label>
                <input id="cj-phone" className="cj-input" style={{ direction: "ltr", textAlign: "right" }} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XX ..." inputMode="tel" autoComplete="tel" />
              </div>
              <div className="cj-field">
                <label htmlFor="cj-email">البريد الإلكتروني</label>
                <input id="cj-email" className="cj-input" style={{ direction: "ltr", textAlign: "right" }} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="email" />
              </div>
              <div className="cj-field">
                <label htmlFor="cj-exp">سنوات الخبرة</label>
                <input id="cj-exp" className="cj-input" value={experience} onChange={(e) => setExperience(e.target.value)} placeholder="مثال: ٣ سنوات" />
              </div>
              <div className="cj-field">
                <label htmlFor="cj-edu">أعلى مؤهل دراسي</label>
                <input id="cj-edu" className="cj-input" value={education} onChange={(e) => setEducation(e.target.value)} placeholder="مثال: بكالوريوس" />
              </div>
              <div className="cj-field full">
                <label htmlFor="cj-notes">نبذة / ملاحظات</label>
                <textarea id="cj-notes" className="cj-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="خبرات سابقة، مهارات، أيّ معلومة تودّ إضافتها…" />
              </div>
            </div>

            <button type="submit" className="cj-submit" disabled={apply.isPending}>
              {apply.isPending ? "جارٍ الإرسال…" : "إرسال الطلب"}
            </button>
            <p className="cj-note">تُستخدم بياناتك لغرض التوظيف فقط. الحقول التي عليها <i style={{ color: "#c0392b", fontStyle: "normal" }}>*</i> إلزامية.</p>
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

  // كشف العناصر عند التمرير (IntersectionObserver) + تشغيل عدّ الأرقام عند ظهور الشريط.
  const rootRef = useRef<HTMLDivElement>(null);
  const [statsIn, setStatsIn] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          if (e.target.classList.contains("cj-stats")) setStatsIn(true);
          io.unobserve(e.target);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
    );
    root.querySelectorAll(".reveal, .cj-stats").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [vacancies.length, q.isLoading]);

  const branches = useCountUp(2, statsIn);
  const openCount = useCountUp(vacancies.length, statsIn);
  const depts = useCountUp(7, statsIn);

  function scrollToJobs() {
    document.getElementById("cj-jobs")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="cj-root" ref={rootRef}>
      <style>{CSS}</style>

      {/* الشريط العلوي */}
      <nav className="cj-nav">
        <div className="cj-wrap cj-nav-in">
          <div className="cj-brand">
            <div className="cj-logo">ر.ع</div>
            <div className="cj-bt"><b>{COMPANY}</b><span>{SUBTITLE}</span></div>
          </div>
          <div className="cj-nav-links">
            <a className="cj-nlink" href="#cj-why">لماذا نحن</a>
            <a className="cj-nlink" href="#cj-jobs">الوظائف</a>
            {/* الموقعان العامّان (المتجر والوظائف) يعيشان على الدومين نفسه ⇒ رابط متبادل بينهما */}
            <a className="cj-nlink" href="/store">متجرنا</a>
            <button className="cj-btn cj-btn-accent cj-btn-sm" onClick={() => setTarget("general")}>قدّم الآن</button>
          </div>
        </div>
      </nav>

      {/* البطل */}
      <header className="cj-hero">
        <div className="cj-wrap cj-hero-in">
          <div>
            <span className="cj-eyebrow"><i />نوظّف الآن — انضمّ إلى فريقنا</span>
            <h1 className="cj-h1">ابنِ مستقبلك المهني في <em>مطبعة تثق بإتقانها</em></h1>
            <p className="cj-lead">
              نحن مطبعة ومكتبة قرطاسية راسخة بفرعين ونشاطٍ متنوّع — طباعة، تصميم، مبيعات، وتجهيزات مكتبية.
              إن كنت تبحث عن بيئة عمل محترمة وفرصة نموٍّ حقيقية تكافئ الجهد، فمكانك بيننا.
            </p>
            <div className="cj-cta">
              <button className="cj-btn cj-btn-accent" onClick={scrollToJobs}>تصفّح الوظائف الشاغرة</button>
              <button className="cj-btn cj-btn-out" onClick={() => setTarget("general")}>تقديم عام بلا وظيفة محدّدة</button>
            </div>
            <div className="cj-trust">
              <div><BranchIcon /> فرعان في الخدمة</div>
              <div><WalletIcon /> رواتب IQD منتظمة</div>
              <div><SparkIcon /> فرص تطوّر وترقية</div>
            </div>
          </div>
          <div className="cj-art">
            <div className="cj-art-card"><HeroArt /></div>
            <div className="cj-badge">
              <div><div className="n">{ar(7)}<span className="a">+</span></div><div className="l">أقسام وتخصّصات</div></div>
              <div className="sep" />
              <div><div className="n a">٢٠٢٦</div><div className="l">نوظّف هذا العام</div></div>
            </div>
          </div>
        </div>
      </header>

      {/* شريط الأرقام */}
      <section className="cj-stats" aria-label="أرقام الشركة">
        <div className="cj-wrap cj-stats-in">
          <div className="cj-stat"><b>{ar(branches)}</b><span>فرعان في الخدمة</span></div>
          <div className="cj-stat"><b>{vacancies.length ? ar(openCount) : "—"}</b><span>وظائف مفتوحة الآن</span></div>
          <div className="cj-stat"><b>{ar(depts)}<span className="a">+</span></b><span>أقسام وتخصّصات</span></div>
          <div className="cj-stat"><b className="a">IQD</b><span>رواتب منتظمة</span></div>
        </div>
      </section>

      {/* لماذا تعمل معنا */}
      <section className="cj-section alt" id="cj-why">
        <div className="cj-wrap">
          <div className="cj-shead reveal">
            <span className="cj-kicker">لماذا الرؤية العربية</span>
            <h2>بيئة تجمع الاحتراف بالاحترام</h2>
            <p>نمنحك أدوات النجاح وفرص التطوّر، ضمن فريقٍ يقدّر الإتقان ويكافئ الجهد.</p>
          </div>
          <div className="cj-values">
            {VALUES.map((v) => (
              <div className="cj-vcard reveal" key={v.k}>
                <div className="cj-vicon"><ValueIcon k={v.k} /></div>
                <h3>{v.t}</h3>
                <p>{v.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* كيف تتقدّم */}
      <section className="cj-section">
        <div className="cj-wrap">
          <div className="cj-shead reveal">
            <span className="cj-kicker">ثلاث خطوات</span>
            <h2>كيف تتقدّم؟</h2>
            <p>عملية بسيطة وواضحة — من اختيار الوظيفة حتى تواصلنا معك.</p>
          </div>
          <div className="cj-steps">
            {STEPS.map((s, i) => (
              <div className="cj-step reveal" key={i}>
                <div className="num">{ar(i + 1)}</div>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* معرض الوظائف */}
      <section className="cj-section alt" id="cj-jobs">
        <div className="cj-wrap">
          <div className="cj-shead reveal">
            <span className="cj-kicker">الشواغر المتاحة</span>
            <h2>الوظائف الشاغرة</h2>
            <p>اختر ما يناسب خبرتك وقدّم مباشرة — أو أرسل تقديماً عامّاً ونحتفظ ببياناتك للفرص القادمة.</p>
          </div>

          {q.isLoading ? (
            <div className="cj-grid">{Array.from({ length: 3 }, (_, i) => <div className="cj-skel" key={i} />)}</div>
          ) : q.isError ? (
            <div className="cj-empty">
              <div className="ei"><BriefIcon /></div>
              <h3>تعذّر تحميل الوظائف</h3>
              <p>حدث خطأ أثناء جلب الوظائف الشاغرة. حاول تحديث الصفحة.</p>
              <button className="cj-btn cj-btn-out" onClick={() => q.refetch()}>إعادة المحاولة</button>
            </div>
          ) : vacancies.length === 0 ? (
            <div className="cj-empty">
              <div className="ei"><BriefIcon /></div>
              <h3>لا توجد وظائف منشورة حالياً</h3>
              <p>لا شواغر معلنة الآن، لكن يمكنك إرسال تقديم عام ونتواصل معك حين تتوفّر فرصة مناسبة.</p>
              <button className="cj-btn cj-btn-accent" onClick={() => setTarget("general")}>إرسال تقديم عام</button>
            </div>
          ) : (
            <div className="cj-grid">
              {vacancies.map((v) => <VacancyCard key={v.id} v={v} onApply={() => setTarget(v)} />)}
            </div>
          )}
        </div>
      </section>

      {/* التذييل */}
      <footer className="cj-footer">
        <div className="cj-wrap cj-foot-in">
          <div className="cj-foot-brand">
            <div className="cj-logo">ر.ع</div>
            <div><b>{COMPANY}</b><br /><span>{SUBTITLE} — العراق</span></div>
          </div>
          <p className="cj-foot-note">
            نوفّر فرصاً متكافئة لجميع المتقدّمين. تُعامَل بياناتك بسرّية تامّة ولغرض التوظيف فقط · فرع رئيسي وفرع مبيعات.
          </p>
        </div>
      </footer>

      {target && <ApplyModal target={target} onClose={() => setTarget(null)} />}
    </div>
  );
}
