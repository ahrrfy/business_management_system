/**
 * طبقة التغذية الصوتية الموحّدة للواجهة.
 *
 * النغمات مولّدة محلياً عبر Web Audio: لا ملفات إضافية، لا شبكة، ولا تأخير تحميل.
 * يبقى صوت إشعارات الدفع خارج التطبيق مستقلاً لأنه يُشغَّل بواسطة نظام التشغيل.
 */

export type AudioFeedbackKind =
  | "tap"
  | "scan"
  | "success"
  | "confirm"
  | "notification"
  | "warning"
  | "error";

type Tone = {
  frequency: number;
  endFrequency?: number;
  startsAt: number;
  duration: number;
  gain: number;
  waveform: OscillatorType;
};

type AudioPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export const AUDIO_FEEDBACK_STORAGE_KEY = "alroya.audio-feedback.enabled.v1";
export const AUDIO_FEEDBACK_CHANGE_EVENT = "alroya:audio-feedback-change";

const PATTERNS: Record<AudioFeedbackKind, readonly Tone[]> = {
  // نقرة هادئة جداً: تعطي إحساس الاستجابة من دون تحويل كل زر إلى تنبيه.
  tap: [
    {
      frequency: 540,
      startsAt: 0,
      duration: 0.028,
      gain: 0.022,
      waveform: "sine",
    },
  ],
  // صفير قارئ تقليدي قصير وواضح في بيئة المحل.
  scan: [
    {
      frequency: 1_080,
      startsAt: 0,
      duration: 0.055,
      gain: 0.11,
      waveform: "square",
    },
  ],
  success: [
    {
      frequency: 660,
      startsAt: 0,
      duration: 0.07,
      gain: 0.075,
      waveform: "sine",
    },
    {
      frequency: 880,
      startsAt: 0.075,
      duration: 0.09,
      gain: 0.085,
      waveform: "sine",
    },
  ],
  confirm: [
    {
      frequency: 720,
      startsAt: 0,
      duration: 0.085,
      gain: 0.065,
      waveform: "sine",
    },
  ],
  notification: [
    {
      frequency: 523.25,
      startsAt: 0,
      duration: 0.09,
      gain: 0.06,
      waveform: "sine",
    },
    {
      frequency: 659.25,
      startsAt: 0.1,
      duration: 0.12,
      gain: 0.065,
      waveform: "sine",
    },
  ],
  warning: [
    {
      frequency: 440,
      startsAt: 0,
      duration: 0.08,
      gain: 0.07,
      waveform: "triangle",
    },
    {
      frequency: 440,
      startsAt: 0.115,
      duration: 0.09,
      gain: 0.07,
      waveform: "triangle",
    },
  ],
  error: [
    {
      frequency: 330,
      endFrequency: 220,
      startsAt: 0,
      duration: 0.2,
      gain: 0.09,
      waveform: "triangle",
    },
  ],
};

const MIN_INTERVAL_MS: Record<AudioFeedbackKind, number> = {
  tap: 35,
  scan: 80,
  success: 160,
  confirm: 120,
  notification: 250,
  warning: 220,
  error: 220,
};

let audioCtx: AudioContext | null = null;
const lastPlayedAt: Partial<Record<AudioFeedbackKind, number>> = {};

function browserStorage(): AudioPreferenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** الصوت مفعّل افتراضياً، ويُحفظ الكتم على الجهاز نفسه لا على حسابات بقية الموظفين. */
export function isAudioFeedbackEnabled(
  storage: Pick<AudioPreferenceStorage, "getItem"> | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(AUDIO_FEEDBACK_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAudioFeedbackEnabled(
  enabled: boolean,
  storage: AudioPreferenceStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(AUDIO_FEEDBACK_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // التخزين تفضيل تحسين؛ فشله لا يعطّل أي عملية أعمال.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<boolean>(AUDIO_FEEDBACK_CHANGE_EVENT, {
        detail: enabled,
      }),
    );
  }
}

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextClass) return null;

  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function scheduleTone(ctx: AudioContext, tone: Tone): void {
  const startsAt = ctx.currentTime + tone.startsAt;
  const endsAt = startsAt + tone.duration;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = tone.waveform;
  oscillator.frequency.setValueAtTime(tone.frequency, startsAt);
  if (tone.endFrequency != null) {
    oscillator.frequency.exponentialRampToValueAtTime(
      tone.endFrequency,
      endsAt,
    );
  }

  // دخول وخروج قصيران يمنعان فرقعة السماعة مع إبقاء صفير الماسح حاداً.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(
    tone.gain,
    startsAt + Math.min(0.008, tone.duration / 3),
  );
  gain.gain.exponentialRampToValueAtTime(0.0001, endsAt);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.addEventListener(
    "ended",
    () => {
      oscillator.disconnect();
      gain.disconnect();
    },
    { once: true },
  );
  oscillator.start(startsAt);
  oscillator.stop(endsAt + 0.01);
}

/** تشغيل تغذية صوتية واحدة، مع تهدئة تمنع عاصفة أصوات عند تحديثاتٍ جماعية سريعة. */
export function playAudioFeedback(kind: AudioFeedbackKind): boolean {
  if (!isAudioFeedbackEnabled()) return false;

  const now = Date.now();
  const previous = lastPlayedAt[kind];
  if (previous != null && now - previous < MIN_INTERVAL_MS[kind]) return false;

  try {
    const ctx = getAudioContext();
    if (!ctx) return false;
    lastPlayedAt[kind] = now;
    PATTERNS[kind].forEach((tone) => scheduleTone(ctx, tone));
    return true;
  } catch {
    // بعض المتصفحات تمنع Web Audio قبل أول تفاعل. لا يجب أن يؤثر ذلك في العملية الأصلية.
    return false;
  }
}

/**
 * يهيّئ السماعة عند أول تفاعل، ويضيف نقرةً خافتة للأزرار والروابط.
 * يمكن تخصيص عنصر بـ data-audio-feedback="confirm" أو إسكاته بـ"none".
 */
export function installGlobalInteractionAudio(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  const win = window as Window & {
    __alroyaAudioFeedbackCleanup?: () => void;
  };
  win.__alroyaAudioFeedbackCleanup?.();

  const unlock = () => {
    if (!isAudioFeedbackEnabled()) return;
    try {
      const ctx = getAudioContext();
      if (ctx?.state === "suspended") void ctx.resume().catch(() => {});
    } catch {
      // التهيئة اختيارية؛ ستُعاد المحاولة مع التفاعل اللاحق.
    }
  };

  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const actionable = event.target.closest<HTMLElement>(
      "button, a[href], summary, [role='button'], input[type='button'], input[type='submit'], input[type='checkbox'], input[type='radio']",
    );
    if (!actionable || actionable.matches(":disabled, [aria-disabled='true']"))
      return;

    const requested = actionable.dataset.audioFeedback;
    if (requested === "none") return;
    const kind =
      requested && requested in PATTERNS
        ? (requested as AudioFeedbackKind)
        : "tap";
    playAudioFeedback(kind);
  };

  document.addEventListener("pointerdown", unlock, {
    capture: true,
    passive: true,
  });
  document.addEventListener("keydown", unlock, true);
  document.addEventListener("click", onClick);

  const cleanup = () => {
    document.removeEventListener("pointerdown", unlock, true);
    document.removeEventListener("keydown", unlock, true);
    document.removeEventListener("click", onClick);
    if (win.__alroyaAudioFeedbackCleanup === cleanup) {
      delete win.__alroyaAudioFeedbackCleanup;
    }
  };
  win.__alroyaAudioFeedbackCleanup = cleanup;
  return cleanup;
}

/** توافق شاشة الكشك القائمة: النجاح فيها يعني أن الصنف عُثر عليه فعلاً. */
export function playScanSuccess(muted = false): void {
  if (!muted) playAudioFeedback("success");
}

/** توافق شاشة الكشك القائمة: فشل مطابقة الباركود. */
export function playScanNotFound(muted = false): void {
  if (!muted) playAudioFeedback("error");
}
