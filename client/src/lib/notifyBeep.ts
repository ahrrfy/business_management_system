/**
 * صافرةُ إشعارٍ صغيرة (Web Audio) — 660Hz لـ150ms ثمّ 880Hz لـ200ms. لا ملفَّ صوتٍ ولا أصلَ إضافيّ.
 *
 * الاستعمال (٢٩/٨/٢٦): مشترَكةٌ بين طابور الاستقبال (ReceptionOrderQueue) وتبويب «جاهز للإرسال»
 * في DeliveryHub. كانا يكرّران نفس الدالّة حرفياً — استخرِجت للنمط الثالث حين ظهر (Slice A).
 *
 * تفشل مغلقةً بلا throw: بعض المتصفّحات تحظر إنشاء AudioContext قبل أوّل user-gesture. Toast يبقى
 * ظاهراً للمعتِمِد بصرياً وحده. لا نُخزّن Context عالمياً كي لا نحتفظ بحلقاتٍ مفتوحة بين تبويبات —
 * دورةُ حياةٍ لكلّ صفارة (نُغلقها بعد ~500ms).
 */
export function playReadyBeep(): void {
  try {
    const AC: typeof AudioContext | undefined =
      (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    const beep = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.15, now + start + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur);
    };
    beep(660, 0, 0.15);
    beep(880, 0.18, 0.2);
    setTimeout(() => {
      try { ctx.close(); } catch { /* ignore */ }
    }, 500);
  } catch {
    /* المتصفّح بلا صوت — Toast يفي (ولا نُفشل تجربة الاستقبال). */
  }
}

/**
 * نغمة تنبيه إدارية راقية ومميزة للإعلانات العاجلة والطارئة (Web Audio API).
 * نقية، خفيفة، وحجم صفر بايت، بلا ملفات صوت خارجية.
 * - CRITICAL: ثلاث نغمات تصاعدية هادئة ومنسجمة (C5 -> E5 -> G5) تجذب الانتباه باحترافية.
 * - IMPORTANT: نغمة ثنائية دافئة (C5 -> G5).
 * - NORMAL: نغمة أحادية ناعمة (E5).
 */
export function playAnnouncementChime(priority: "NORMAL" | "IMPORTANT" | "CRITICAL" = "NORMAL"): void {
  try {
    const AC: typeof AudioContext | undefined =
      (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;

    const playTone = (freq: number, start: number, dur: number, gainPeak: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(gainPeak, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur);
    };

    if (priority === "CRITICAL") {
      playTone(523.25, 0.0, 0.35, 0.16); // C5
      playTone(659.25, 0.16, 0.4, 0.18); // E5
      playTone(783.99, 0.34, 0.55, 0.2); // G5
      setTimeout(() => {
        try { ctx.close(); } catch { /* ignore */ }
      }, 950);
    } else if (priority === "IMPORTANT") {
      playTone(523.25, 0.0, 0.3, 0.14); // C5
      playTone(659.25, 0.18, 0.45, 0.16); // E5
      setTimeout(() => {
        try { ctx.close(); } catch { /* ignore */ }
      }, 700);
    } else {
      playTone(659.25, 0.0, 0.3, 0.12); // E5
      setTimeout(() => {
        try { ctx.close(); } catch { /* ignore */ }
      }, 350);
    }
  } catch {
    /* fail-safe: عند تعذر الصوت أو حظر المتصفح للتشغيل التلقائي */
  }
}
