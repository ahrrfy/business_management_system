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
}

const QuranAudioContext = createContext<QuranAudioContextValue | null>(null);

const STORAGE_RECITER_KEY = "erp.quran.lastReciterId";
const STORAGE_SURAH_KEY = "erp.quran.lastSurahId";
const STORAGE_VOLUME_KEY = "erp.quran.volume";

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

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
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
  const [hasStartedOnce, setHasStartedOnce] = useState(false);
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

  // تهيئة عنصر الصوت الوحيد
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "none";
    audio.volume = volume;
    audioRef.current = audio;

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
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
      // الانتقال التلقائي للسورة التالية
      setCurrentSurah((prev) => {
        const nextId = prev.id >= 114 ? 1 : prev.id + 1;
        const next = QURAN_SURAHS.find((s) => s.id === nextId) || QURAN_SURAHS[0];
        return next;
      });
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
      audio.pause();
      audio.src = "";
    };
  }, []);

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
    try {
      localStorage.setItem(STORAGE_SURAH_KEY, String(surah.id));
      localStorage.setItem(STORAGE_RECITER_KEY, reciter.id);
    } catch {
      // تجاهل أخطاء التخزين
    }
  }, []);

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
        playTrack(currentSurah, currentReciter);
      } else {
        audio.play().catch(() => setIsPlaying(false));
      }
      setHasStartedOnce(true);
    }
  }, [isPlaying, currentSurah, currentReciter, playTrack]);

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
