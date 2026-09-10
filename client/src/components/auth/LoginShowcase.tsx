import { motion, useReducedMotion } from "framer-motion";

export interface LoginShowcaseProps {
  mouseCoord: { x: number; y: number };
  baghdadTime: string;
}

export function LoginShowcase({ mouseCoord, baghdadTime }: LoginShowcaseProps) {
  const shouldReduceMotion = Boolean(useReducedMotion());
  return (
    <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-8 xl:p-12 relative overflow-hidden border-e border-white/[0.08] select-none">
      {/* توهج كاوستيك ناعم خلف الشعار يتنفس حيوية */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[680px] h-[680px] blur-3xl"
          style={{
            background: "radial-gradient(circle, rgba(16,123,99,0.16) 0%, rgba(200,90,39,0.10) 45%, transparent 70%)",
          }}
        />
      </div>

      {/* إشعار أبل العلوي الرقيق */}
      <div className="relative z-10 flex items-center justify-between">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/[0.03] border border-white/[0.08] backdrop-blur-xl text-[11px] font-medium text-slate-300 shadow-sm">
          <span className="size-1.5 rounded-full bg-money-positive animate-pulse" />
          <span className="tracking-wide">المنظومة المؤسسية المركزية</span>
        </div>
        <span className="text-[11px] font-mono text-slate-500 tracking-wider">BAGHDAD · IQ</span>
      </div>

      {/* قلب المشهد: الشعار الأيقوني المعلق بتأثيرات حركية مستمرة وإضاءة انعكاسية انسيابية */}
      <div className="relative z-10 my-auto flex flex-col items-center justify-center py-6">
        <motion.div
          style={{
            transform: shouldReduceMotion
              ? undefined
              : `perspective(1000px) rotateX(${-mouseCoord.y * 6}deg) rotateY(${mouseCoord.x * 6}deg)`,
          }}
          transition={shouldReduceMotion ? undefined : { type: "spring", stiffness: 90, damping: 20 }}
          className="relative flex flex-col items-center justify-center"
        >
          {/* هالات أبل المتمركزة (Apple Keynote Orbit Rings) */}
          <motion.div
            aria-hidden
            animate={shouldReduceMotion ? undefined : { scale: [0.98, 1.03, 0.98], opacity: [0.2, 0.4, 0.2] }}
            transition={shouldReduceMotion ? undefined : { duration: 7, repeat: Infinity, ease: "easeInOut" }}
            className="absolute -inset-10 sm:-inset-14 rounded-[56px] border border-white/[0.07] pointer-events-none"
          />
          <motion.div
            aria-hidden
            animate={shouldReduceMotion ? undefined : { scale: [1.02, 0.97, 1.02], opacity: [0.1, 0.25, 0.1] }}
            transition={shouldReduceMotion ? undefined : { duration: 9, repeat: Infinity, ease: "easeInOut" }}
            className="absolute -inset-20 sm:-inset-24 rounded-[72px] border border-white/[0.035] pointer-events-none"
          />

          {/* وهج شفق كاوستيك ناعم يتنفس بألوان الشعار (الأخضر الزمردي والعنبري) */}
          <motion.div
            aria-hidden
            animate={shouldReduceMotion ? undefined : { scale: [0.95, 1.15, 0.95], opacity: [0.3, 0.55, 0.3] }}
            transition={shouldReduceMotion ? undefined : { duration: 5.5, repeat: Infinity, ease: "easeInOut" }}
            className="absolute -inset-8 rounded-full blur-3xl pointer-events-none"
            style={{
              background: "linear-gradient(to bottom, rgba(16,123,99,0.22), rgba(13,110,87,0.12), rgba(200,90,39,0.20))",
            }}
          />

          {/* حاوية الشعار العائمة بالفيزياء المستمرة */}
          <motion.div
            animate={shouldReduceMotion ? undefined : { y: [-8, 8, -8], rotateZ: [-0.4, 0.4, -0.4] }}
            transition={shouldReduceMotion ? undefined : { duration: 6, repeat: Infinity, ease: "easeInOut" }}
            className="relative p-6 sm:p-8 rounded-[40px] bg-white/[0.035] border border-white/[0.12] backdrop-blur-2xl shadow-[0_30px_90px_-20px_rgba(0,0,0,0.85)] ring-1 ring-white/10 group overflow-hidden"
          >
            {/* وميض الزجاج الخارجي المستمر (Apple Outer Specular Sheen) */}
            {!shouldReduceMotion && (
              <motion.div aria-hidden className="absolute inset-0 pointer-events-none z-10 overflow-hidden rounded-[40px]">
                <motion.div
                  className="w-[180%] h-full bg-gradient-to-r from-transparent via-white/[0.12] to-transparent -skew-x-25"
                  animate={{ x: ["-130%", "230%"] }}
                  transition={{ duration: 4.5, repeat: Infinity, repeatDelay: 2.8, ease: [0.25, 0.1, 0.25, 1] }}
                />
              </motion.div>
            )}

            {/* مجسم الشعار المعلق مع طبقات التدفق والانسياب الضوئي الحي بين الحروف والزوايا */}
            <div className="relative z-20 w-56 sm:w-64 xl:w-72 aspect-[3/4] flex items-center justify-center select-none">
              {/* الشعار الرسمي بدقته الكاملة دون أي تشويه أو تغيير لحروفه */}
              <img
                src="/logo.png"
                alt="شعار شركة الرؤية العربية"
                className="w-full h-full object-contain select-none pointer-events-none drop-shadow-[0_20px_35px_rgba(0,0,0,0.6)]"
              />

              {/* طبقة الانسياب والتغلغل الضوئي بين حروف الخط العربي وزوايا الشعار */}
              {!shouldReduceMotion && (
                <div
                  className="absolute inset-0 pointer-events-none overflow-hidden rounded-[30px] sm:rounded-[36px]"
                  style={{
                    maskImage: "radial-gradient(circle at center, black 88%, transparent 100%)",
                    WebkitMaskImage: "radial-gradient(circle at center, black 88%, transparent 100%)",
                  }}
                >
                {/* ١. شعاع الانسياب القطري العريض المتناغم مع ميلان قطة القلم العربي (135°) */}
                <motion.div
                  className="absolute inset-0 pointer-events-none"
                  style={{ mixBlendMode: "color-dodge" }}
                >
                  <motion.div
                    className="w-[240%] h-[240%] -top-[70%] -left-[70%] absolute"
                    style={{
                      background:
                        "linear-gradient(135deg, transparent 32%, rgba(255,255,255,0.08) 40%, rgba(16,185,129,0.55) 46%, rgba(255,255,255,0.98) 50%, rgba(245,158,11,0.55) 54%, rgba(255,255,255,0.08) 60%, transparent 68%)",
                      filter: "blur(2px)",
                    }}
                    animate={{
                      x: ["-85%", "85%"],
                      y: ["-85%", "85%"],
                    }}
                    transition={{
                      duration: 3.4,
                      repeat: Infinity,
                      repeatDelay: 1.8,
                      ease: [0.25, 0.1, 0.25, 1],
                    }}
                  />
                </motion.div>

                {/* ٢. تيار انكساري أفقي يمسح خطوط ارتكاز الحروف وزوايا الانحناء */}
                <motion.div
                  className="absolute inset-0 pointer-events-none"
                  style={{ mixBlendMode: "screen" }}
                >
                  <motion.div
                    className="w-[200%] h-full absolute top-0"
                    style={{
                      background:
                        "linear-gradient(90deg, transparent 30%, rgba(255,255,255,0.2) 44%, rgba(255,255,255,0.85) 50%, rgba(255,255,255,0.2) 56%, transparent 70%)",
                      filter: "blur(6px)",
                    }}
                    animate={{
                      x: ["-130%", "230%"],
                    }}
                    transition={{
                      duration: 4.8,
                      repeat: Infinity,
                      repeatDelay: 2.8,
                      ease: "easeInOut",
                    }}
                  />
                </motion.div>

                {/* ٣. نواة الضوء السائلة العلوية المتغلغلة بين حروف الأخضر الزمردي */}
                <motion.div
                  aria-hidden
                  className="absolute size-32 rounded-full pointer-events-none -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: "50%",
                    top: "38%",
                    background:
                      "radial-gradient(circle, rgba(255,255,255,0.9) 0%, rgba(16,185,129,0.65) 30%, rgba(16,185,129,0.2) 60%, transparent 80%)",
                    filter: "blur(16px)",
                    mixBlendMode: "color-dodge",
                  }}
                  animate={{
                    x: ["-35%", "35%", "-15%", "25%", "-35%"],
                    y: ["-25%", "-8%", "-22%", "-5%", "-25%"],
                    scale: [0.85, 1.35, 0.95, 1.25, 0.85],
                    opacity: [0.4, 0.9, 0.5, 0.85, 0.4],
                  }}
                  transition={{
                    duration: 6.5,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />

                {/* ٤. نواة الضوء السائلة السفلية المنسابة بين ثنايا الخط العنبري */}
                <motion.div
                  aria-hidden
                  className="absolute size-32 rounded-full pointer-events-none -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: "50%",
                    top: "65%",
                    background:
                      "radial-gradient(circle, rgba(255,245,215,0.9) 0%, rgba(200,90,39,0.65) 30%, rgba(200,90,39,0.2) 60%, transparent 80%)",
                    filter: "blur(16px)",
                    mixBlendMode: "screen",
                  }}
                  animate={{
                    x: ["30%", "-30%", "18%", "-22%", "30%"],
                    y: ["5%", "25%", "-2%", "20%", "5%"],
                    scale: [1.2, 0.85, 1.3, 0.9, 1.2],
                    opacity: [0.35, 0.85, 0.45, 0.8, 0.35],
                  }}
                  transition={{
                    duration: 8,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />

                {/* ٥. ذرات ضوئية سيّالة تتصاعد بنعومة بين فراغات الحروف العربية كأفلاك كاوستيك */}
                {[
                  { left: "28%", bottom: "20%", delay: 0.2, dur: 4.5, xShift: 8 },
                  { left: "45%", bottom: "25%", delay: 1.1, dur: 5.2, xShift: -10 },
                  { left: "62%", bottom: "18%", delay: 2.0, dur: 4.8, xShift: 12 },
                  { left: "38%", bottom: "35%", delay: 2.8, dur: 5.5, xShift: -8 },
                  { left: "54%", bottom: "40%", delay: 0.7, dur: 4.2, xShift: 10 },
                ].map((ember, i) => (
                  <motion.div
                    key={i}
                    aria-hidden
                    className="absolute size-1.5 rounded-full pointer-events-none"
                    style={{
                      left: ember.left,
                      bottom: ember.bottom,
                      background: i % 2 === 0 ? "rgba(220,255,240,0.95)" : "rgba(255,230,195,0.95)",
                      boxShadow:
                        i % 2 === 0
                          ? "0 0 10px rgba(16,185,129,0.9)"
                          : "0 0 10px rgba(245,158,11,0.9)",
                      mixBlendMode: "screen",
                    }}
                    animate={{
                      y: [0, -110, -180],
                      x: [0, ember.xShift, -ember.xShift * 0.5],
                      opacity: [0, 0.95, 0],
                      scale: [0.5, 1.4, 0.3],
                    }}
                    transition={{
                      duration: ember.dur,
                      repeat: Infinity,
                      delay: ember.delay,
                      ease: "easeInOut",
                    }}
                  />
                ))}

                {/* ٦. وميض بريق الزوايا الأربع (Corner Angle Bevel Glints) */}
                <motion.div
                  aria-hidden
                  className="absolute top-2.5 right-2.5 size-4 rounded-full pointer-events-none"
                  style={{
                    background: "radial-gradient(circle, rgba(255,255,255,0.95) 0%, transparent 70%)",
                    filter: "blur(1px)",
                  }}
                  animate={{ opacity: [0.2, 0.95, 0.2], scale: [0.8, 1.3, 0.8] }}
                  transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
                />
                <motion.div
                  aria-hidden
                  className="absolute bottom-2.5 left-2.5 size-4 rounded-full pointer-events-none"
                  style={{
                    background: "radial-gradient(circle, rgba(255,255,255,0.95) 0%, transparent 70%)",
                    filter: "blur(1px)",
                  }}
                  animate={{ opacity: [0.15, 0.9, 0.15], scale: [0.8, 1.3, 0.8] }}
                  transition={{ duration: 3.4, repeat: Infinity, repeatDelay: 0.4, ease: "easeInOut" }}
                />
              </div>
            )}
            </div>
          </motion.div>

          {/* عنوان الهوية المؤسسية بنمط خطوط أبل الأنيقة الواضحة */}
          <div className="text-center space-y-1.5 mt-8 select-none">
            <div role="heading" aria-level={1} className="text-2xl xl:text-3xl font-bold tracking-tight text-white/95">
              شركة الرؤية العربية
            </div>
            <p className="text-xs xl:text-sm text-slate-400 font-light tracking-wide">
              المنظومة المؤسسية الموحدة للتجارة العامة والطباعة
            </p>
          </div>
        </motion.div>
      </div>

      {/* شريط أبل السفلي البسيط: حالة الاتصال وتوقيت العاصمة */}
      <div className="relative z-10 flex items-center justify-between text-xs text-slate-400 border-t border-white/[0.06] pt-4">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-money-positive" />
          <span className="text-[11px] text-slate-400 font-medium">بغداد — العامرية</span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px]">
          <span className="text-slate-300 bg-white/[0.04] px-2 py-0.5 rounded border border-white/[0.08] font-bold">
            {baghdadTime || "15:00:00"}
          </span>
          <span className="text-slate-500">TLS 1.3</span>
        </div>
      </div>
    </div>
  );
}

export default LoginShowcase;
