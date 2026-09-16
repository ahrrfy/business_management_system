import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { QURAN_RECITERS, QURAN_SURAHS, type QuranReciter, type QuranSurah, getSurahAudioUrl } from "./quranData";

interface QuranAudioContextValue {
  currentSurah: QuranSurah;
  currentReciter: QuranReciter;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  drawerOpen: boolean;
  hasStartedOnce: boolean;
  floatingBarVisible: boolean;
  playSurah: (surahId: number, reciterId?: string) => void;
  togglePlay: () => void;
  pause: () => void;
  resume: () => void;
  nextSurah: () => void;
  prevSurah: () => void;
  seek: (time: number) => void;
  setVolume: (vol: number) => void;
  toggleMute: () => void;
  setReciter: (reciter: QuranReciter) => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  setFloatingBarVisible: (visible: boolean) => void;
  savedPosition: number;
  resumeFromBookmark: () => void;
}

const QuranAudioContext = createContext<QuranAudioContextValue | null>(null);

const STORAGE_RECITER_KEY = "erp.quran.lastReciterId";
const STORAGE_SURAH_KEY = "erp.quran.lastSurahId";
const STORAGE_VOLUME_KEY = "erp.quran.volume";
const STORAGE_POSITION_KEY = "erp.quran.lastPositionSeconds";

let globalAudioInstance: HTMLAudioElement | null = null;

function getGlobalAudio(initialVolume = 0.85): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!globalAudioInstance) {
    globalAudioInstance = new Audio();
    globalAudioInstance.preload = "none";
    globalAudioInstance.volume = initialVolume;
  }
  return globalAudioInstance;
}

/** إيقاف صريح لعنصر الصوت عند عبور حدود المصادقة (تسجيل الخروج أو الانتقال لشاشة الدخول). */
export function pauseGlobalQuranAudio(): void {
  if (globalAudioInstance && !globalAudioInstance.paused) {
    globalAudioInstance.pause();
  }
}

export function QuranAudioProvider({ children }: { children: React.ReactNode }) {
  const [currentReciter, setCurrentReciterState] = useState<QuranReciter>(() => {
    try {
      const savedId = localStorage.getItem(STORAGE_RECITER_KEY);
      const found = QURAN_RECITERS.find((r) => r.id === savedId);
      return found || QURAN_RECITERS[0];
    } catch {
      return QURAN_RECITERS[0];
    }
  });

  const [currentSurah, setCurrentSurah] = useState<QuranSurah>(() => {
    try {
      const savedId = Number(localStorage.getItem(STORAGE_SURAH_KEY));
      const found = QURAN_SURAHS.find((s) => s.id === savedId);
      return found || QURAN_SURAHS[0];
    } catch {
      return QURAN_SURAHS[0];
    }
  });

  const [isPlaying, setIsPlaying] = useState(() => {
    if (typeof window !== "undefined" && globalAudioInstance) {
      return !globalAudioInstance.paused && !globalAudioInstance.ended;
    }
    return false;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => {
    if (typeof window !== "undefined" && globalAudioInstance) {
      return globalAudioInstance.currentTime;
    }
    return 0;
  });
  const [duration, setDuration] = useState(() => {
    if (typeof window !== "undefined" && globalAudioInstance) {
      return globalAudioInstance.duration || 0;
    }
    return 0;
  });
  const [volume, setVolumeState] = useState(() => {
    try {
      const savedVol = localStorage.getItem(STORAGE_VOLUME_KEY);
      return savedVol != null ? Math.max(0, Math.min(1, Number(savedVol))) : 0.85;
    } catch {
      return 0.85;
    }
  });
  const [isMuted, setIsMuted] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hasStartedOnce, setHasStartedOnce] = useState(() => {
    if (typeof window !== "undefined" && globalAudioInstance) {
      return Boolean(globalAudioInstance.src);
    }
    return false;
  });
  const [savedPosition, setSavedPosition] = useState<number>(() => {
    try {
      const pos = Number(localStorage.getItem(STORAGE_POSITION_KEY));
      return !isNaN(pos) && pos > 0 ? pos : 0;
    } catch {
      return 0;
    }
  });
  const lastSavedTimeRef = useRef<number>(0);
  const [floatingBarVisible, setFloatingBarVisibleState] = useState(() => {
    try {
      const saved = localStorage.getItem("erp.quran.bar_visible");
      return saved === "1";
    } catch {
      return false;
    }
  });

  const setFloatingBarVisible = useCallback((visible: boolean) => {
    setFloatingBarVisibleState(visible);
    try {
      localStorage.setItem("erp.quran.bar_visible", visible ? "1" : "0");
    } catch {
      // ignore
    }
  }, []);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentSurahRef = useRef<QuranSurah>(currentSurah);
  currentSurahRef.current = currentSurah;
  const currentReciterRef = useRef<QuranReciter>(currentReciter);
  currentReciterRef.current = currentReciter;

  // تحديث مصدر الصوت عند تغير السورة أو القارئ إذا كان مشغلاً
  const playTrack = useCallback((surah: QuranSurah, reciter: QuranReciter) => {
    const audio = audioRef.current;
    if (!audio) return;

    const url = getSurahAudioUrl(reciter.serverUrl, surah.id);
    setIsLoading(true);
    setCurrentTime(0);
    audio.src = url;
    audio.play().catch(() => {
      setIsLoading(false);
      setIsPlaying(false);
    });
    setHasStartedOnce(true);
    setSavedPosition(0);
    lastSavedTimeRef.current = 0;
    try {
      localStorage.setItem(STORAGE_SURAH_KEY, String(surah.id));
      localStorage.setItem(STORAGE_RECITER_KEY, reciter.id);
      localStorage.setItem(STORAGE_POSITION_KEY, "0");
    } catch {
      // تجاهل أخطاء التخزين
    }
  }, []);

  const playTrackRef = useRef(playTrack);
  playTrackRef.current = playTrack;

  // تهيئة عنصر الصوت الوحيد الدائم
  useEffect(() => {
    const audio = getGlobalAudio(volume);
    if (!audio) return;
    audio.volume = volume;
    audioRef.current = audio;

    // مزامنة فورية في حال كان المشغل يعمل مسبقاً
    if (!audio.paused && !audio.ended) {
      setIsPlaying(true);
      setCurrentTime(audio.currentTime);
      setDuration(audio.duration || 0);
    }

    const onTimeUpdate = () => {
      const t = audio.currentTime;
      setCurrentTime(t);
      if (Math.abs(t - lastSavedTimeRef.current) >= 3) {
        lastSavedTimeRef.current = t;
        const rounded = Math.floor(t);
        setSavedPosition(rounded);
        try {
          localStorage.setItem(STORAGE_POSITION_KEY, String(rounded));
        } catch {
          // ignore
        }
      }
    };
    const onLoadedMetadata = () => {
      setDuration(audio.duration || 0);
      setIsLoading(false);
    };
    const onWaiting = () => {
      setIsLoading(true);
    };
    const onPlaying = () => {
      setIsLoading(false);
      setIsPlaying(true);
    };
    const onPause = () => {
      setIsPlaying(false);
    };
    const onEnded = () => {
      setIsPlaying(false);
      setSavedPosition(0);
      try {
        localStorage.setItem(STORAGE_POSITION_KEY, "0");
      } catch {
        // ignore
      }
      // الانتقال التلقائي للسورة التالية واستمرار البث الإذاعي بلا توقف
      const curr = currentSurahRef.current;
      const nextId = curr.id >= 114 ? 1 : curr.id + 1;
      const next = QURAN_SURAHS.find((s) => s.id === nextId) || QURAN_SURAHS[0];
      setCurrentSurah(next);
      playTrackRef.current(next, currentReciterRef.current);
    };
    const onError = () => {
      setIsLoading(false);
      setIsPlaying(false);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      // ملاحظة معمارية حاسمة: لا نوقف الصوت بـ pause() ولا نفرغ src هنا أبداً؛
      // لضمان استمرار البث أثناء تنقل المستخدم بين الشاشات والوحدات.
    };
  }, [volume]);

  const playSurah = useCallback((surahId: number, reciterId?: string) => {
    const surah = QURAN_SURAHS.find((s) => s.id === surahId) || QURAN_SURAHS[0];
    const reciter = reciterId
      ? QURAN_RECITERS.find((r) => r.id === reciterId) || currentReciter
      : currentReciter;

    setCurrentSurah(surah);
    if (reciterId) {
      setCurrentReciterState(reciter);
    }
    playTrack(surah, reciter);
  }, [currentReciter, playTrack]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      if (!audio.src || audio.src === window.location.href) {
        const url = getSurahAudioUrl(currentReciter.serverUrl, currentSurah.id);
        audio.src = url;
        const savedPos = Number(localStorage.getItem(STORAGE_POSITION_KEY) || "0");
        if (savedPos > 5) {
          audio.currentTime = savedPos;
          setCurrentTime(savedPos);
        }
        audio.play().catch(() => setIsPlaying(false));
      } else {
        audio.play().catch(() => setIsPlaying(false));
      }
      setHasStartedOnce(true);
    }
  }, [isPlaying, currentSurah, currentReciter]);

  const resumeFromBookmark = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      const savedPos = Number(localStorage.getItem(STORAGE_POSITION_KEY) || "0");
      if (savedPos > 0) {
        if (!audio.src || audio.src === window.location.href) {
          const url = getSurahAudioUrl(currentReciter.serverUrl, currentSurah.id);
          audio.src = url;
        }
        audio.currentTime = savedPos;
        setCurrentTime(savedPos);
        audio.play().catch(() => setIsPlaying(false));
        setHasStartedOnce(true);
        setIsPlaying(true);
      }
    } catch {
      // ignore
    }
  }, [currentReciter.serverUrl, currentSurah.id]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const resume = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.src || audio.src === window.location.href) {
      playTrack(currentSurah, currentReciter);
    } else {
      audio.play().catch(() => setIsPlaying(false));
    }
  }, [currentSurah, currentReciter, playTrack]);

  const nextSurah = useCallback(() => {
    const nextId = currentSurah.id >= 114 ? 1 : currentSurah.id + 1;
    playSurah(nextId);
  }, [currentSurah.id, playSurah]);

  const prevSurah = useCallback(() => {
    const prevId = currentSurah.id <= 1 ? 114 : currentSurah.id - 1;
    playSurah(prevId);
  }, [currentSurah.id, playSurah]);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    setCurrentTime(time);
  }, []);

  const setVolume = useCallback((vol: number) => {
    const clamped = Math.max(0, Math.min(1, vol));
    setVolumeState(clamped);
    if (audioRef.current) {
      audioRef.current.volume = clamped;
      if (clamped > 0 && isMuted) {
        audioRef.current.muted = false;
        setIsMuted(false);
      }
    }
    try {
      localStorage.setItem(STORAGE_VOLUME_KEY, String(clamped));
    } catch {
      // ignore
    }
  }, [isMuted]);

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextMuted = !isMuted;
    audio.muted = nextMuted;
    setIsMuted(nextMuted);
  }, [isMuted]);

  const setReciter = useCallback((reciter: QuranReciter) => {
    setCurrentReciterState(reciter);
    try {
      localStorage.setItem(STORAGE_RECITER_KEY, reciter.id);
    } catch {
      // ignore
    }
    if (isPlaying) {
      playTrack(currentSurah, reciter);
    }
  }, [isPlaying, currentSurah, playTrack]);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <QuranAudioContext.Provider
      value={{
        currentSurah,
        currentReciter,
        isPlaying,
        isLoading,
        currentTime,
        duration,
        volume,
        isMuted,
        drawerOpen,
        hasStartedOnce,
        floatingBarVisible,
        playSurah,
        togglePlay,
        pause,
        resume,
        nextSurah,
        prevSurah,
        seek,
        setVolume,
        toggleMute,
        setReciter,
        openDrawer,
        closeDrawer,
        setFloatingBarVisible,
        savedPosition,
        resumeFromBookmark,
      }}
    >
      {children}
    </QuranAudioContext.Provider>
  );
}

export function useQuranAudio() {
  const context = useContext(QuranAudioContext);
  if (!context) {
    throw new Error("useQuranAudio must be used within a QuranAudioProvider");
  }
  return context;
}
