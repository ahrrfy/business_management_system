/**
 * audioFeedback — تغذية صوتية فورية لقارئ الأسعار والماسح الضوئي.
 *
 * يعتمد على Web Audio API المدمجة في المتصفّح (صفر ملفات mp3/wav خارجية،
 * صفر طلبات شبكية، استجابة بـ 0ms، وحجم بايتات معدوم).
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;

  if (!audioCtx) {
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume();
  }
  return audioCtx;
}

/** نغمة نجاح المسح: رنة مزدوجة متناسقة ونقية (880Hz -> 1760Hz) تُعلم الزبون بالتقاط السلعة. */
export function playScanSuccess(muted = false): void {
  if (muted) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    // النغمة الأولى
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(880, now); // A5
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.08);

    // النغمة الثانية الأعلى والأقصر
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(1760, now + 0.07); // A6
    gain2.gain.setValueAtTime(0.18, now + 0.07);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.07);
    osc2.stop(now + 0.16);
  } catch {
    // إخفاق صامت في حال تقييد سياسة الصوت للمتصفح قبل أول تفاعل
  }
}

/** نغمة عدم العثور أو تنبيه: نغمة منخفضة مزدوجة (300Hz -> 200Hz). */
export function playScanNotFound(muted = false): void {
  if (muted) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.linearRampToValueAtTime(220, now + 0.18);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch {
    // إخفاق صامت
  }
}
