/**
 * /apply — معرض الوظائف الشاغرة + استمارة التقديم **العامّة** (خارج تخطيط التطبيق، بلا تسجيل دخول).
 *
 * الهوية البصرية = هويتنا الحقيقية لا هويةً مخترَعة (إعادة تصميم ١٤/٧/٢٦):
 *  • **الشعار الفعليّ** `/logo.png` (خطّ عربي بلونَي الشركة) في الترويسة والبطل والتذييل وعلامةً مائية —
 *    كان مربّعاً نصّياً «ر.ع» مصطنعاً، والشعار الحقيقي موجود في المشروع ولا تعرضه أيّ شاشة.
 *  • **ألوان الشعار والمطبوعات**: أخضر زمرّدي (#0D6B52 / #0F8A6D) + طوبيّ (#C4611C) على ورق دافئ —
 *    مطابِقة لـ`lib/printing/brand.ts` (مصدر الهوية المعتمَد للفواتير والمستندات) بدل الكحلي/النحاسي.
 *  • **خطّ Cairo بأوزانه الثقيلة (800/900)** عبر @font-face من `/fonts` المستضافة ذاتياً — حزمة التطبيق
 *    تحمّل 400–700 فقط فكانت العناوين «عريضة مُصطنَعة» (synthetic bold) لا حقيقية.
 *
 * حركة هادفة تحترم `prefers-reduced-motion`: كشف متدرّج عند التمرير (stagger)، عدّ تصاعدي للأرقام،
 * طفو خفيف للبطل، شريط تخصّصات متحرّك، ولمسات ضغط/تحويم (transform/opacity فقط — بلا إعادة تخطيط).
 * مستقلّة بتنسيقها: <style> داخلي (CSP: style-src unsafe-inline) + SVG داخلي + موارد ذاتية المصدر فقط.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { errMsg } from "@/lib/notify";
import { employmentTypeLabel } from "@shared/hr";
import { Check } from "lucide-react";

const COMPANY = "الرؤية العربية للتجارة العامة";
const SUBTITLE = "المكتبة العربية للطباعة والقرطاسية";
/**
 * الشعار: `/icon-512.png` (٦٦ك) هو **الشعار نفسه** المستعمَل في `/logo.png` (٥٣٩ك، 3450×4484 للطباعة)،
 * بدقّة تكفي أكبر عرضٍ هنا (٢٤٠px @2x) — صفحة عامة تُفتح على شبكات الجوال، فلا نحمّل الزائرَ نصف
 * ميغابايت بلا فائدة. ملفٌ واحد لكل مواضع الشعار (الترويسة/البطل/التذييل/العلامة المائية) ⇒ تنزيلٌ واحد مُخبَّأ.
 */
const LOGO = "/icon-512.png";
/** بيانات تواصل حقيقية (مطابِقة لـbrand.ts) — لا أرقام مخترَعة. */
const ADDRESS = "بغداد — العامرية / شارع العمل الشعبي";
const CONTACT_PHONE = "07838666999";
/** تخصّصات الشركة الفعلية — تُعرض شريطاً متحرّكاً (بصريات تحفيزية بلا ادّعاءات). */
const SPECIALTIES = [
  "طباعة رقمية وأوفست",
  "تصميم جرافيك",
  "قرطاسية ولوازم مكتبية",
  "هدايا وتخرّج",
  "تجهيزات دوائر وشركات",
  "مبيعات جملة ومفرد",
  "خدمة زبائن",
  "توصيل ومناديب",
] as const;

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
/* أوزان Cairo الثقيلة (800/900) — مستضافة ذاتياً في /fonts (CSP: font-src 'self').
   حزمة التطبيق تحمّل 400–700 فقط ⇒ بدونها يُصطنَع العريض ويفقد العنوان حدّته. */
@font-face{font-family:"Cairo Display";font-weight:800;font-style:normal;font-display:swap;
  src:url("/fonts/cairo-arabic-800-normal.woff2") format("woff2")}
@font-face{font-family:"Cairo Display";font-weight:900;font-style:normal;font-display:swap;
  src:url("/fonts/cairo-arabic-900-normal.woff2") format("woff2")}
@font-face{font-family:"Cairo Display";font-weight:800;font-style:normal;font-display:swap;
  src:url("/fonts/cairo-latin-800-normal.woff2") format("woff2");unicode-range:U+0000-00FF,U+2000-206F}
@font-face{font-family:"Cairo Display";font-weight:900;font-style:normal;font-display:swap;
  src:url("/fonts/cairo-latin-900-normal.woff2") format("woff2");unicode-range:U+0000-00FF,U+2000-206F}

.cj-root{
  /* هوية الشركة الفعلية: أخضر الشعار + طوبيّه، على ورق دافئ بحبر شبه أسود (brand.ts) */
  --paper:#FAF7F1;--surface:#ffffff;--ink:#14201C;--ink2:#33443E;--muted:#5B6A64;
  --green:#0D6B52;--green-d:#0A5340;--green-deep:#0D3B2E;--green-bright:#0F8A6D;
  --green-soft:#E7F3EE;--green-mist:#F2F9F6;
  --clay:#C4611C;--clay-d:#A8500F;--clay-soft:#FBEDE2;
  --line:#E6E2D9;--ok:#0F8A6D;
  min-height:100vh;background:var(--paper);color:var(--ink);direction:rtl;
  font-family:"Cairo",system-ui,sans-serif;overflow-x:hidden;-webkit-font-smoothing:antialiased;
  scroll-behavior:smooth}
.cj-root *{box-sizing:border-box}
.cj-root h1,.cj-root h2,.cj-root .cj-stat b,.cj-root .cj-ctitle{font-family:"Cairo Display","Cairo",system-ui,sans-serif}
.cj-wrap{max-width:1160px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}

/* الشريط العلوي */
.cj-nav{position:sticky;top:0;z-index:40;background:rgba(250,247,241,.88);backdrop-filter:blur(10px);
  border-bottom:1px solid var(--line)}
.cj-nav-in{display:flex;align-items:center;justify-content:space-between;gap:14px;height:72px}
.cj-brand{display:flex;align-items:center;gap:12px;min-width:0;text-decoration:none}
/* الشعار الحقيقي — إطار ورقيّ يحفظ نسبته ويمنحه مساحة تنفّس (clear space) */
.cj-logo{width:48px;height:48px;flex-shrink:0;border-radius:12px;background:#fff;border:1px solid var(--line);
  padding:5px;display:grid;place-items:center;box-shadow:0 6px 18px -12px rgba(13,59,46,.5)}
.cj-logo img{width:100%;height:100%;object-fit:contain;display:block}
.cj-logo.lg{width:64px;height:64px;border-radius:16px;padding:7px}
.cj-bt{display:flex;flex-direction:column;line-height:1.3;min-width:0}
.cj-bt b{font-size:15px;font-weight:800;color:var(--ink);white-space:nowrap}
.cj-bt span{font-size:11.5px;color:var(--muted)}
.cj-nav-links{display:flex;align-items:center;gap:6px}
.cj-nlink{font-size:14px;font-weight:700;color:var(--ink2);padding:10px 12px;border-radius:9px;
  text-decoration:none;transition:background .16s,color .16s}
.cj-nlink:hover{background:var(--green-soft);color:var(--green-d)}
.cj-nlink:focus-visible,.cj-brand:focus-visible{outline:3px solid rgba(13,107,82,.35);outline-offset:2px;border-radius:9px}

/* الأزرار */
.cj-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;min-height:46px;
  font-family:inherit;font-weight:800;font-size:14.5px;border-radius:12px;padding:0 20px;
  border:1.5px solid transparent;transition:transform .16s cubic-bezier(.16,1,.3,1),background .18s,border-color .18s,box-shadow .18s}
.cj-btn:active{transform:scale(.97)}
.cj-btn:focus-visible{outline:3px solid rgba(13,107,82,.4);outline-offset:2px}
.cj-btn-primary{background:var(--green);color:#fff;box-shadow:0 10px 24px -14px rgba(13,107,82,.8)}
.cj-btn-primary:hover{background:var(--green-d);transform:translateY(-2px)}
.cj-btn-accent{background:var(--clay-d);color:#fff;box-shadow:0 10px 24px -14px rgba(168,80,15,.85)}
.cj-btn-accent:hover{background:#8E430C;transform:translateY(-2px)}
.cj-btn-out{background:#fff;color:var(--green-d);border-color:var(--line)}
.cj-btn-out:hover{border-color:var(--green);background:var(--green-mist)}
.cj-btn-sm{min-height:42px;padding:0 16px;font-size:13.5px;border-radius:10px}

/* البطل */
.cj-hero{position:relative;padding:clamp(44px,7vw,86px) 0 clamp(38px,5vw,66px);overflow:hidden}
/* هالتان لونيّتان ناعمتان (transform/opacity فقط) */
.cj-orb{position:absolute;border-radius:50%;filter:blur(60px);opacity:.5;z-index:0;pointer-events:none}
.cj-orb.a{width:420px;height:420px;top:-140px;right:-90px;background:rgba(15,138,109,.20);animation:cj-drift 16s ease-in-out infinite}
.cj-orb.b{width:340px;height:340px;bottom:-120px;left:-80px;background:rgba(196,97,28,.16);animation:cj-drift 20s ease-in-out infinite reverse}
.cj-hero::before{content:"";position:absolute;inset:0;z-index:0;opacity:.55;
  background-image:radial-gradient(var(--line) 1.2px,transparent 1.2px);background-size:22px 22px;
  -webkit-mask-image:radial-gradient(ellipse 70% 60% at 70% 25%,#000,transparent 72%);
  mask-image:radial-gradient(ellipse 70% 60% at 70% 25%,#000,transparent 72%)}
.cj-hero-in{position:relative;z-index:1;display:grid;grid-template-columns:1.06fr .94fr;
  gap:clamp(24px,4vw,56px);align-items:center}
.cj-eyebrow{display:inline-flex;align-items:center;gap:9px;font-size:13px;font-weight:800;color:var(--green-d);
  background:var(--green-soft);padding:9px 15px;border-radius:999px}
.cj-eyebrow i{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px rgba(15,138,109,.18);
  animation:cj-pulse 2.4s ease-in-out infinite}
.cj-h1{font-size:clamp(32px,5.3vw,56px);font-weight:900;line-height:1.18;margin:20px 0 0;
  color:var(--ink);letter-spacing:-.6px}
.cj-h1 em{font-style:normal;position:relative;color:var(--green-d);white-space:nowrap}
/* خطّ توكيد بلونَي الشعار تحت الكلمة المفتاحية — **ثابتٌ مرئيّ بلا حركة**: عنصرُ هويةٍ لا زينةً
   متحرّكة، فلا يصحّ أن يتوقّف ظهوره على تشغيل إطارٍ (تبويبٌ مخنوق/تقليل حركة كان يُخفيه تماماً). */
.cj-h1 em::after{content:"";position:absolute;right:0;left:0;bottom:.04em;height:.18em;border-radius:4px;
  background:linear-gradient(90deg,rgba(196,97,28,.38),rgba(15,138,109,.32))}
.cj-lead{font-size:clamp(15px,2.2vw,17.5px);color:var(--ink2);line-height:2;margin:20px 0 26px;max-width:560px}
.cj-cta{display:flex;flex-wrap:wrap;gap:12px}
.cj-trust{display:flex;flex-wrap:wrap;gap:10px 22px;margin-top:26px;padding-top:22px;border-top:1px dashed var(--line)}
.cj-trust div{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;color:var(--ink2)}
.cj-trust svg{color:var(--green);flex-shrink:0}

/* بطاقة البطل — الشعار الحقيقي بطلَ الصورة */
.cj-art{position:relative}
.cj-art-card{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:26px;
  padding:clamp(22px,3vw,34px);box-shadow:0 34px 70px -38px rgba(13,59,46,.42);
  display:grid;place-items:center;gap:16px;text-align:center;overflow:hidden;
  animation:cj-float 7s ease-in-out infinite}
.cj-art-card::before{content:"";position:absolute;inset:0;
  background:radial-gradient(circle at 50% 0%,rgba(15,138,109,.09),transparent 62%);pointer-events:none}
.cj-hero-logo{width:min(240px,54vw);height:auto;aspect-ratio:1;object-fit:contain;display:block;position:relative}
.cj-art-card .cap{position:relative;font-size:13px;font-weight:800;color:var(--green-d);
  background:var(--green-soft);padding:7px 14px;border-radius:999px}
.cj-badge{position:absolute;bottom:-16px;right:-10px;background:var(--green-deep);color:#fff;border-radius:15px;
  padding:13px 17px;display:flex;align-items:center;gap:11px;box-shadow:0 18px 36px -16px rgba(13,59,46,.65)}
.cj-badge .n{font-size:24px;font-weight:900;line-height:1;color:#fff;font-variant-numeric:tabular-nums}
.cj-badge .l{font-size:11.5px;color:#CFE7DE;line-height:1.4}
.cj-badge .sep{width:1px;height:30px;background:rgba(255,255,255,.18)}
.cj-badge .a{color:#F0A55E}

/* شريط التخصّصات المتحرّك (بصريات تحفيزية — تخصّصات فعلية) */
.cj-marquee{background:var(--surface);border-block:1px solid var(--line);overflow:hidden;padding:14px 0}
.cj-track{display:flex;gap:10px;width:max-content;animation:cj-marquee 34s linear infinite}
.cj-marquee:hover .cj-track{animation-play-state:paused}
.cj-chip{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;font-size:13.5px;font-weight:700;
  color:var(--ink2);background:var(--green-mist);border:1px solid var(--line);padding:8px 15px;border-radius:999px}
.cj-chip i{width:6px;height:6px;border-radius:50%;background:var(--clay);flex-shrink:0}

/* أقسام */
.cj-section{padding:clamp(48px,6vw,84px) 0}
.cj-section.alt{background:var(--surface);border-block:1px solid var(--line)}
.cj-shead{max-width:640px;margin:0 auto clamp(28px,4vw,44px);text-align:center}
.cj-kicker{display:inline-block;font-size:12.5px;font-weight:800;letter-spacing:.4px;color:var(--clay-d);
  margin-bottom:10px}
.cj-shead h2{font-size:clamp(25px,3.6vw,37px);font-weight:900;color:var(--ink);margin:0;letter-spacing:-.4px}
.cj-shead p{font-size:14.5px;color:var(--muted);margin:12px auto 0;line-height:1.95}

/* قيم العمل */
.cj-values{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.cj-vcard{position:relative;background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:24px 20px;
  transition:transform .22s cubic-bezier(.16,1,.3,1),border-color .22s,box-shadow .22s;overflow:hidden}
.cj-vcard::after{content:"";position:absolute;inset:auto 0 0 0;height:3px;background:var(--green);
  transform:scaleX(0);transform-origin:right;transition:transform .28s cubic-bezier(.16,1,.3,1)}
.cj-vcard:hover{transform:translateY(-5px);border-color:#CFE7DE;box-shadow:0 26px 46px -30px rgba(13,59,46,.34)}
.cj-vcard:hover::after{transform:scaleX(1)}
.cj-vicon{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;margin-bottom:16px;
  background:var(--green-soft);color:var(--green-d)}
.cj-vcard h3{font-size:16.5px;font-weight:800;color:var(--ink);margin:0 0 8px}
.cj-vcard p{font-size:13.5px;color:var(--muted);line-height:1.95;margin:0}

/* كيف تتقدّم */
.cj-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.cj-step{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:24px 22px}
.cj-step .num{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;font-weight:900;
  font-size:16px;background:var(--green-deep);color:#fff;margin-bottom:14px}
.cj-step h3{font-size:16px;font-weight:800;color:var(--ink);margin:0 0 7px}
.cj-step p{font-size:13.5px;color:var(--muted);line-height:1.9;margin:0}

/* شريط الأرقام (أخضر عميق + علامة الشعار المائية) */
.cj-stats{background:var(--green-deep);color:#fff;position:relative;overflow:hidden}
.cj-stats::before{content:"";position:absolute;inset:0;background:url("${LOGO}") no-repeat left -60px center/220px auto;
  opacity:.07;filter:grayscale(1) brightness(2.6);pointer-events:none}
.cj-stats::after{content:"";position:absolute;inset:0;opacity:.5;
  background-image:radial-gradient(rgba(255,255,255,.05) 1px,transparent 1px);background-size:22px 22px}
.cj-stats-in{position:relative;z-index:1;display:grid;grid-template-columns:repeat(4,1fr);gap:18px;
  padding:clamp(30px,4vw,44px) 0}
.cj-stat{text-align:center;position:relative}
.cj-stat+.cj-stat::before{content:"";position:absolute;right:-9px;top:50%;transform:translateY(-50%);
  width:1px;height:42px;background:rgba(255,255,255,.14)}
.cj-stat b{display:block;font-size:clamp(27px,3.6vw,39px);font-weight:900;color:#fff;font-variant-numeric:tabular-nums}
.cj-stat b .a{color:#F0A55E}
.cj-stat span{font-size:12.5px;color:#BBD3C9;font-weight:600}

/* معرض الوظائف */
.cj-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px}
.cj-card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:0;
  display:flex;flex-direction:column;overflow:hidden;
  transition:transform .22s cubic-bezier(.16,1,.3,1),box-shadow .22s,border-color .22s}
.cj-card:hover{transform:translateY(-5px);box-shadow:0 30px 54px -32px rgba(13,59,46,.36);border-color:#CFE7DE}
.cj-card-top{height:5px;background:linear-gradient(90deg,var(--green),var(--clay))}
.cj-card-img{height:158px;background:var(--green-mist);position:relative;overflow:hidden}
.cj-card-img img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .5s cubic-bezier(.16,1,.3,1)}
.cj-card:hover .cj-card-img img{transform:scale(1.05)}
.cj-cbody{padding:20px 20px 0;flex:1}
.cj-dept{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:800;color:var(--green-d);
  background:var(--green-soft);padding:5px 11px;border-radius:8px;margin-bottom:12px}
.cj-dept i{width:6px;height:6px;border-radius:50%;background:var(--clay)}
.cj-ctitle{font-size:19px;font-weight:900;color:var(--ink);margin:0 0 7px;line-height:1.45}
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
  background:linear-gradient(100deg,transparent 20%,rgba(13,59,46,.05) 50%,transparent 80%);animation:cj-shine 1.4s infinite}
.cj-empty{text-align:center;background:var(--surface);border:1px dashed var(--line);border-radius:20px;padding:48px 24px;max-width:520px;margin:0 auto}
.cj-empty .ei{width:56px;height:56px;border-radius:16px;margin:0 auto 16px;display:grid;place-items:center;background:var(--green-soft);color:var(--green-d)}
.cj-empty h3{color:var(--ink);font-size:20px;font-weight:800;margin:0 0 8px}
.cj-empty p{color:var(--muted);font-size:14px;line-height:1.9;margin:0 auto 20px;max-width:420px}

/* شريط دعوة أخير */
.cj-cta-band{background:linear-gradient(135deg,var(--green-deep),var(--green));color:#fff;border-radius:24px;
  padding:clamp(28px,4vw,44px);display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:20px;
  box-shadow:0 34px 64px -36px rgba(13,59,46,.7)}
.cj-cta-band h2{font-size:clamp(21px,3vw,30px);font-weight:900;margin:0 0 8px;color:#fff}
.cj-cta-band p{margin:0;color:#CFE7DE;font-size:14.5px;line-height:1.9;max-width:520px}
.cj-cta-band .cj-btn-out{background:#fff;color:var(--green-deep);border-color:transparent}
.cj-cta-band .cj-btn-out:hover{background:#F0F9F5}

/* تذييل */
.cj-footer{background:var(--green-deep);color:#fff;padding:clamp(36px,4vw,52px) 0 30px}
.cj-foot-in{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:22px}
.cj-foot-brand{display:flex;align-items:center;gap:12px}
.cj-foot-brand b{color:#fff;font-size:15px;font-weight:800}
.cj-foot-brand span{color:#BBD3C9;font-size:12px}
.cj-foot-note{color:#A9C4B9;font-size:12.5px;line-height:2;max-width:440px;text-align:start}
.cj-foot-note a{color:#F0A55E;text-decoration:none;font-weight:700}
.cj-foot-note a:hover{text-decoration:underline}

/* نافذة التقديم */
.cj-overlay{position:fixed;inset:0;z-index:80;background:rgba(13,32,26,.58);backdrop-filter:blur(4px);
  display:flex;align-items:flex-start;justify-content:center;padding:24px 14px;overflow-y:auto;animation:cj-fade .2s ease}
.cj-modal{width:min(660px,100%);background:var(--surface);color:var(--ink);border-radius:20px;overflow:hidden;
  box-shadow:0 40px 90px -30px rgba(13,32,26,.6);animation:cj-pop .26s cubic-bezier(.16,1,.3,1)}
.cj-mhead{padding:22px 24px;background:var(--green-deep);color:#fff;position:relative;
  border-bottom:3px solid var(--clay)}
.cj-mclose{position:absolute;top:16px;left:16px;width:40px;height:40px;border-radius:11px;border:none;cursor:pointer;
  background:rgba(255,255,255,.14);color:#fff;font-size:20px;line-height:1;display:grid;place-items:center;transition:background .16s}
.cj-mclose:hover{background:rgba(255,255,255,.26)}
.cj-mclose:focus-visible{outline:3px solid rgba(255,255,255,.6);outline-offset:2px}
.cj-mhead .k{font-size:12px;color:#CFE7DE;font-weight:700}
.cj-mhead .t{font-size:21px;font-weight:900;margin-top:3px;color:#fff}
.cj-mbody{padding:22px 24px 26px}
.cj-posbanner{display:flex;align-items:center;gap:12px;background:var(--green-soft);border:1px solid #CFE7DE;
  border-radius:13px;padding:13px 15px;margin-bottom:18px}
.cj-posbanner .ic{width:42px;height:42px;border-radius:12px;flex-shrink:0;display:grid;place-items:center;
  color:#fff;background:var(--green)}
.cj-posbanner .k{font-size:11.5px;color:var(--green-d);font-weight:700}
.cj-posbanner .t{font-size:15px;color:var(--ink);font-weight:800}
.cj-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}
.cj-field{display:flex;flex-direction:column;gap:6px}
.cj-field.full{grid-column:1/-1}
.cj-field label{font-size:13px;font-weight:700;color:var(--ink2)}
.cj-field label i{color:#A02F23;font-style:normal}
.cj-input{height:48px;border-radius:11px;border:1.5px solid var(--line);background:#fff;padding:0 13px;
  font-family:inherit;font-size:15px;color:var(--ink);outline:none;width:100%;transition:border-color .16s,box-shadow .16s}
.cj-input::placeholder{color:#9AA7A1}
.cj-input:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(13,107,82,.16)}
textarea.cj-input{height:auto;min-height:98px;padding:11px 13px;resize:vertical;line-height:1.8}
.cj-submit{margin-top:20px;width:100%;min-height:54px;border-radius:13px;border:none;color:#fff;font-family:inherit;
  font-weight:900;font-size:16px;cursor:pointer;background:var(--green);
  transition:background .18s,transform .16s cubic-bezier(.16,1,.3,1)}
.cj-submit:hover:not(:disabled){background:var(--green-d);transform:translateY(-2px)}
.cj-submit:active:not(:disabled){transform:scale(.99)}
.cj-submit:focus-visible{outline:3px solid rgba(13,107,82,.4);outline-offset:2px}
.cj-submit:disabled{background:#A7B5AF;cursor:not-allowed}
.cj-err{background:#FDECEA;border:1px solid #F0C4BD;color:#8A1F11;border-radius:11px;padding:11px 13px;font-size:13.5px;margin-bottom:16px}
.cj-note{font-size:12px;color:var(--muted);text-align:center;margin-top:14px;line-height:1.9}
.cj-done{text-align:center;padding:44px 28px}
.cj-done .ring{width:80px;height:80px;margin:0 auto 18px;border-radius:50%;background:var(--green-soft);color:var(--green);
  display:grid;place-items:center;animation:cj-pop .4s .05s both cubic-bezier(.16,1,.3,1)}
.cj-done h2{font-size:23px;font-weight:900;margin:0;color:var(--ink)}
.cj-done p{font-size:14.5px;color:var(--ink2);line-height:2;margin:12px auto 0;max-width:430px}

/* كشف متدرّج عند التمرير (stagger عبر --i) */
.reveal{opacity:0;transform:translateY(20px);
  transition:opacity .6s cubic-bezier(.16,1,.3,1),transform .6s cubic-bezier(.16,1,.3,1);
  transition-delay:calc(var(--i,0) * 60ms)}
.reveal.in{opacity:1;transform:none}

@keyframes cj-pulse{0%,100%{box-shadow:0 0 0 4px rgba(15,138,109,.18)}50%{box-shadow:0 0 0 7px rgba(15,138,109,.05)}}
@keyframes cj-shine{0%{transform:translateX(120%)}100%{transform:translateX(-120%)}}
@keyframes cj-fade{from{opacity:0}to{opacity:1}}
@keyframes cj-pop{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
@keyframes cj-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
@keyframes cj-drift{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-18px,16px) scale(1.06)}}
@keyframes cj-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}

@media(max-width:880px){
  .cj-hero-in{grid-template-columns:1fr}
  .cj-art{order:-1;max-width:420px;margin:0 auto;width:100%}
  .cj-nav-links a.cj-nlink{display:none}
  .cj-stats-in{grid-template-columns:repeat(2,1fr);gap:26px 12px}
  .cj-stat:nth-child(3)::before,.cj-stat+.cj-stat::before{display:none}
  .cj-values{grid-template-columns:repeat(2,1fr)}
  .cj-steps{grid-template-columns:1fr}
  .cj-stats::before{background-position:left -110px center}
}
@media(max-width:520px){
  .cj-form-grid{grid-template-columns:1fr}
  .cj-values{grid-template-columns:1fr}
  .cj-bt span{display:none}
  .cj-badge{right:auto;left:50%;transform:translateX(-50%)}
}
@media(prefers-reduced-motion:reduce){
  .cj-root{scroll-behavior:auto}
  .reveal{opacity:1;transform:none;transition:none}
  .cj-eyebrow i,.cj-skel::after,.cj-art-card,.cj-orb,.cj-track{animation:none}
  .cj-track{width:auto;flex-wrap:wrap;justify-content:center}
  .cj-marquee{overflow:visible}
  .cj-btn:hover,.cj-vcard:hover,.cj-card:hover,.cj-submit:hover:not(:disabled){transform:none}
  .cj-card:hover .cj-card-img img{transform:none}
}
`;

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

/** الشعار الحقيقي — مكوَّن واحد يضمن نصّاً بديلاً وسقوطاً آمناً إن تعذّر تحميل الصورة. */
function BrandLogo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={`cj-logo${size === "lg" ? " lg" : ""}`}>
      <img
        src={LOGO}
        alt={`شعار ${SUBTITLE}`}
        width={size === "lg" ? 64 : 48}
        height={size === "lg" ? 64 : 48}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
      />
    </span>
  );
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
function VacancyCard({ v, onApply, i }: { v: Vacancy; onApply: () => void; i: number }) {
  return (
    <article className="cj-card reveal" style={{ ["--i" as string]: i % 6 }}>
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
  const nameRef = useRef<HTMLInputElement>(null);

  // إغلاق بـEsc + منع تمرير الخلفية + تركيز أوّل حقل (إتاحة).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    nameRef.current?.focus();
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const apply = trpc.recruitment.submit.useMutation({
    onSuccess: () => setDone(true),
    onError: (e) => setErr(errMsg(e)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) { setErr("الاسم مطلوب"); nameRef.current?.focus(); return; }
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
            {err && <div className="cj-err" role="alert">{err}</div>}

            <div className="cj-form-grid">
              <div className="cj-field full">
                <label htmlFor="cj-name">الاسم الثلاثي واللقب <i>*</i></label>
                <input ref={nameRef} id="cj-name" className="cj-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم الكامل" autoComplete="name" />
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
            <p className="cj-note">تُستخدم بياناتك لغرض التوظيف فقط. الحقول التي عليها <i style={{ color: "#A02F23", fontStyle: "normal" }}>*</i> إلزامية.</p>
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

  // عنوان تبويب المتصفّح (صفحة عامة تُشارَك في إعلانات التوظيف).
  useEffect(() => {
    const prev = document.title;
    document.title = `الوظائف الشاغرة — ${SUBTITLE}`;
    return () => { document.title = prev; };
  }, []);

  // كشف العناصر عند التمرير (IntersectionObserver) + تشغيل عدّ الأرقام عند ظهور الشريط.
  const rootRef = useRef<HTMLDivElement>(null);
  const [statsIn, setStatsIn] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // شبكة أمان: الكشف عند التمرير يُخفي المحتوى (opacity:0) ثم يُظهره المراقب. إن غاب المراقب
    // (متصفّح قديم/بيئة بلا IO) فالصفحة تبقى فارغة بصرياً ⇒ نُظهر كل شيء فوراً بدل ذلك.
    if (typeof IntersectionObserver === "undefined") {
      root.querySelectorAll(".reveal, .cj-stats").forEach((el) => el.classList.add("in"));
      setStatsIn(true);
      return;
    }
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

  // شريط التخصّصات: نُكرّر القائمة مرّتين ليكون التمرير لا نهائياً بلا قفزة (‎-50%).
  const marquee = useMemo(() => [...SPECIALTIES, ...SPECIALTIES], []);

  function scrollToJobs() {
    document.getElementById("cj-jobs")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="cj-root" ref={rootRef}>
      <style>{CSS}</style>

      {/* الشريط العلوي */}
      <nav className="cj-nav">
        <div className="cj-wrap cj-nav-in">
          <a className="cj-brand" href="#cj-top" aria-label={`${COMPANY} — ${SUBTITLE}`}>
            <BrandLogo />
            <span className="cj-bt"><b>{COMPANY}</b><span>{SUBTITLE}</span></span>
          </a>
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
      <header className="cj-hero" id="cj-top">
        <span className="cj-orb a" aria-hidden />
        <span className="cj-orb b" aria-hidden />
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
            <div className="cj-art-card">
              <img className="cj-hero-logo" src={LOGO} alt={`شعار ${SUBTITLE}`} width={240} height={240} fetchPriority="high" />
              <span className="cap">{SUBTITLE}</span>
            </div>
            <div className="cj-badge">
              <div><div className="n">{ar(7)}<span className="a">+</span></div><div className="l">أقسام وتخصّصات</div></div>
              <div className="sep" />
              <div><div className="n a">٢٠٢٦</div><div className="l">نوظّف هذا العام</div></div>
            </div>
          </div>
        </div>
      </header>

      {/* شريط التخصّصات المتحرّك */}
      <section className="cj-marquee" aria-label="تخصّصاتنا">
        <div className="cj-track">
          {marquee.map((s, i) => (
            <span className="cj-chip" key={`${s}-${i}`} aria-hidden={i >= SPECIALTIES.length}><i />{s}</span>
          ))}
        </div>
      </section>

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
            {VALUES.map((v, i) => (
              <div className="cj-vcard reveal" key={v.k} style={{ ["--i" as string]: i }}>
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
              <div className="cj-step reveal" key={i} style={{ ["--i" as string]: i }}>
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
              {vacancies.map((v, i) => <VacancyCard key={v.id} v={v} i={i} onApply={() => setTarget(v)} />)}
            </div>
          )}
        </div>
      </section>

      {/* شريط الدعوة الأخير */}
      <section className="cj-section" style={{ paddingTop: 0 }}>
        <div className="cj-wrap">
          <div className="cj-cta-band reveal">
            <div>
              <h2>لم تجد وظيفةً تناسبك؟</h2>
              <p>أرسل تقديماً عامّاً ونحتفظ ببياناتك — ونتواصل معك أوّل ما تُفتح فرصة تناسب خبرتك.</p>
            </div>
            <button className="cj-btn cj-btn-out" onClick={() => setTarget("general")}>إرسال تقديم عام</button>
          </div>
        </div>
      </section>

      {/* التذييل */}
      <footer className="cj-footer">
        <div className="cj-wrap cj-foot-in">
          <div className="cj-foot-brand">
            <BrandLogo size="lg" />
            <div><b>{COMPANY}</b><br /><span>{SUBTITLE}</span></div>
          </div>
          <p className="cj-foot-note">
            {ADDRESS} · للتواصل:{" "}
            <a href={`https://wa.me/964${CONTACT_PHONE.replace(/^0/, "")}`} target="_blank" rel="noopener noreferrer" dir="ltr">
              {CONTACT_PHONE}
            </a>
            <br />
            نوفّر فرصاً متكافئة لجميع المتقدّمين. تُعامَل بياناتك بسرّية تامّة ولغرض التوظيف فقط.
          </p>
        </div>
      </footer>

      {target && <ApplyModal target={target} onClose={() => setTarget(null)} />}
    </div>
  );
}
