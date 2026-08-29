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
