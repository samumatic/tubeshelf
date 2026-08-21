"use client";

import {
  useState,
  useEffect,
  useContext,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ThemeContext } from "@/components/ThemeProvider";
import {
  Play,
  Search,
  Settings,
  Bookmark,
  List,
  X,
  RefreshCw,
  Zap,
  Clock,
  Shield,
  User,
  LogOut,
  ChevronDown,
  BarChart3,
  Eye,
  KeyRound,
  Users,
  AlertTriangle,
  ArrowUp,
} from "lucide-react";
import ClientOnly from "@/components/ClientOnly";
import { AuthExpiredError, feedManager } from "@/lib/feedManager";
import {
  clearLocalFilterPreferences,
  readLocalFilterPreferences,
  writeLocalFilterPreferences,
} from "@/lib/localFilterPreferences";
import { useAuth } from "@/hooks/useAuth";
import { VideoCard } from "@/components/VideoCard";
import { VideoCardSkeleton } from "@/components/VideoCardSkeleton";
import { VideoPlayer } from "@/components/VideoPlayer";
import { PlaybackHistory } from "@/components/PlaybackHistory";
import { SubscriptionManager } from "@/components/SubscriptionManager";
import { SettingsPanel } from "@/components/SettingsPanel";
import { DangerZonePanel } from "@/components/DangerZonePanel";
import { AccountSettings } from "@/components/AccountSettings";
import { WatchLater } from "@/components/WatchLater";
import { AdminPanel } from "@/components/AdminPanel";
import { AdminOIDC } from "@/components/admin/AdminOIDC";
import { AdminUsers } from "@/components/admin/AdminUsers";
import { AdminSystem } from "@/components/admin/AdminSystem";
import { LoadingProgress } from "@/components/LoadingProgress";
import { WelcomeWizard, type WelcomeOptions } from "@/components/WelcomeWizard";
import { ToastContainer } from "@/components/ToastContainer";
import type { ToastProps } from "@/components/Toast";
import {
  UnifiedDashboardLayout,
  DashboardCard,
} from "@/components/UnifiedDashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  getVideos,
  addSubscription,
  removeSubscription,
  importSubscriptions,
  exportSubscriptions,
  getSettings,
  updateSettings,
  getUserState,
  updateUserState,
  clearWatchHistory,
  resetAllSettings,
  Video,
  Subscription,
} from "@/lib/mockData";
import type { AppSettings } from "@/lib/settingsStore";
import { WATCHED_THRESHOLD_DEFAULT } from "@/lib/settingsSchema";
import type {
  SubscriptionList,
  SubscriptionListsData,
} from "@/lib/subscriptionListStore";
import type { Page, FeedTab, WatchLaterItem } from "@/lib/pageTypes";
import {
  videoListsMatch,
  filterAndSortVideos,
  getThemeIconUrl,
} from "@/lib/videoUtils";

export default function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { theme } = useContext(ThemeContext);
  const {
    user,
    loading: authLoading,
    logout,
    warnings: authWarnings,
  } = useAuth();
  const [mounted, setMounted] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>("home");
  const [currentDashboardSection, setCurrentDashboardSection] =
    useState<string>("profile");
  const componentId = useRef(Math.random().toString(36).substring(7));
  const [feedTab, setFeedTab] = useState<FeedTab>("videos");
  const [videos, setVideos] = useState<Video[]>([]);
  const videosRef = useRef<Video[]>([]);
  const loadingRef = useRef<boolean>(false);
  const fetchingRef = useRef<boolean>(false);
  const errorRef = useRef<string | null>(null);
  const [watchLater, setWatchLater] = useState<WatchLaterItem[]>([]);
  const [watchedVideos, setWatchedVideos] = useState<Set<string>>(new Set());
  const watchedVideosRef = useRef<Set<string>>(new Set());
  const [showSubscriptions, setShowSubscriptions] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filteredVideos, setFilteredVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hideWatched, setHideWatched] = useState(false);
  const [hideMemberOnly, setHideMemberOnly] = useState(false);
  const [hideShorts, setHideShorts] = useState(true);
  const [videoRetentionDays, setVideoRetentionDays] = useState<number | null>(
    null
  );
  const [watchedThresholdPercent, setWatchedThresholdPercent] = useState(
    WATCHED_THRESHOLD_DEFAULT
  );
  // videoId -> where playback stopped. Feeds both the thumbnail progress bars
  // and the resume position, so no per-video request is needed to open a video.
  const [videoProgress, setVideoProgress] = useState<
    Map<string, { progress: number; duration: number }>
  >(new Map());
  const videoProgressRef = useRef<
    Map<string, { progress: number; duration: number }>
  >(new Map());
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [subscriptionLists, setSubscriptionLists] = useState<
    SubscriptionList[]
  >([]);
  const [currentListId, setCurrentListId] = useState<string>("default");
  const [filterListId, setFilterListId] = useState<string>("all");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [showLoadingProgress, setShowLoadingProgress] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Video player state
  const [showPlayer, setShowPlayer] = useState(false);
  const [playerVideo, setPlayerVideo] = useState<{
    videoUrl: string;
    videoId: string;
    title: string;
    channel: string;
    channelId?: string;
    thumbnail?: string;
  } | null>(null);
  const [showPlaybackHistory, setShowPlaybackHistory] = useState(false);
  const [initialProgress, setInitialProgress] = useState(0);
  const [playerQuality, setPlayerQuality] = useState<
    "360p" | "480p" | "720p" | "1080p"
  >("1080p");

  const refreshingRef = useRef(false);
  const initializedRef = useRef(false);
  const initializingRef = useRef(false); // Prevent concurrent initialization
  const [showWelcomeWizard, setShowWelcomeWizard] = useState(false);
  const [welcomeCompleted, setWelcomeCompleted] = useState(false);
  const [userStateLoaded, setUserStateLoaded] = useState(false);
  // Gate for the filter-toggle persistence effects: until the stored values are
  // applied, hideWatched/hideMemberOnly still hold their empty mount defaults
  // and writing those out would wipe the user's real preference.
  const [filterPrefsHydrated, setFilterPrefsHydrated] = useState(false);
  const [hasCompletedWelcome, setHasCompletedWelcome] =
    useState<boolean>(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const currentSearchParamsRef = useRef("");
  const [highlightedVideoIndex, setHighlightedVideoIndex] = useState<
    number | null
  >(null);
  const videoRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const closingPlayerRef = useRef(false);
  const settingsPreloadRef = useRef(false);
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());

  /**
   * Where a video should start when it opens. A position in the first seconds
   * is treated as an accidental open, and one within seconds of the end would
   * drop the viewer straight into the end screen.
   */
  const resolveResumeSeconds = useCallback((videoId: string): number => {
    const entry = videoProgressRef.current.get(videoId);
    if (!entry) return 0;

    const { progress, duration } = entry;
    if (!Number.isFinite(progress) || !Number.isFinite(duration)) return 0;
    if (duration <= 0) return 0;
    if (progress < 10) return 0;
    if (duration - progress < 15) return 0;

    return progress;
  }, []);

  // Preload settings eagerly
  const preloadSettings = useCallback(async () => {
    if (settings || settingsPreloadRef.current) return;
    settingsPreloadRef.current = true;
    setSettingsLoading(true);
    try {
      const appSettings = await getSettings();
      setSettings(appSettings);
    } catch (err) {
      console.error("Failed to preload settings:", err);
    } finally {
      setSettingsLoading(false);
    }
  }, [settings]);
  const [toasts, setToasts] = useState<Omit<ToastProps, "onClose">[]>([]);

  const showToast = (
    message: string,
    type: "success" | "error" | "info" = "success",
    onUndo?: () => void
  ) => {
    const id = Math.random().toString(36).substring(7);
    setToasts((prev) => [...prev, { id, message, type, onUndo }]);
  };

  const closeToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  // Redirect to login if auth has finished loading and user is not authenticated
  useEffect(() => {
    if (!authLoading && !user && mounted) {
      router.push("/login");
    }
  }, [authLoading, user, mounted, router]);

  // Handle page query parameter (e.g., ?page=admin)
  useEffect(() => {
    const page = searchParams.get("page");
    if (
      page &&
      ["admin", "settings", "watch-later", "watch-history"].includes(page)
    ) {
      setCurrentPage(page as Page);
    }
  }, [searchParams]);

  // Track current search params for use in handlers
  useEffect(() => {
    currentSearchParamsRef.current = searchParams.toString();
  }, [searchParams]);

  // Handle URL parameters for player (only on mount and hash changes)
  useEffect(() => {
    if (!mounted) return;

    // Check URL hash for player state
    const handleHashChange = () => {
      // Skip if we're in the middle of opening/closing
      if (closingPlayerRef.current) return;

      const hash = window.location.hash;
      const match = hash.match(/^#player=([^&]+)/);

      if (match && videos.length > 0) {
        const videoId = match[1];
        const video = videos.find((v) => v.id === videoId);

        if (video && !showPlayer) {
          setPlayerVideo({
            videoUrl: video.url,
            videoId: video.id,
            title: video.title,
            channel: video.channel,
            channelId: video.channelId,
            thumbnail: video.thumbnail,
          });
          // Deep links skip handlePlayInPlayer, so resume is resolved here too.
          setInitialProgress(resolveResumeSeconds(video.id));
          setShowPlayer(true);
        }
      } else if (!match && showPlayer) {
        // Hash cleared, close player
        setShowPlayer(false);
        setPlayerVideo(null);
      }
    };

    // Check on mount
    handleHashChange();

    // Listen for hash changes (browser back/forward)
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [mounted, videos.length, resolveResumeSeconds]);

  // Close the ad-hoc "more" menu when clicking outside
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      if (
        showMoreMenu &&
        moreMenuRef.current &&
        !(ev.target instanceof Node && moreMenuRef.current.contains(ev.target))
      ) {
        setShowMoreMenu(false);
      }
      // Close keyboard help dropdown
      if (
        showKeyboardHelp &&
        ev.target instanceof Element &&
        !ev.target.closest('[title="Keyboard shortcuts"]') &&
        !ev.target.closest(".keyboard-help-menu")
      ) {
        setShowKeyboardHelp(false);
      }
      // Close user menu dropdown
      if (
        showUserMenu &&
        ev.target instanceof Element &&
        !ev.target.closest('[title="User profile"]') &&
        !ev.target.closest(".user-menu")
      ) {
        setShowUserMenu(false);
      }
    };

    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [showMoreMenu, showKeyboardHelp, showUserMenu]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't interfere when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        // Allow Escape to blur the input and clear search
        if (e.key === "Escape" && e.target instanceof HTMLInputElement) {
          e.target.blur();
          if (searchQuery) {
            setSearchQuery("");
          }
        }
        return;
      }

      // Don't interfere when modals are open
      if (showSubscriptions || showSettings || showWelcomeWizard) {
        // Allow Escape to close modals
        if (e.key === "Escape") {
          setShowSubscriptions(false);
          setShowSettings(false);
          setShowKeyboardHelp(false);
        }
        return;
      }

      // Close keyboard help with Escape or ?
      if (e.key === "Escape" || e.key === "?") {
        if (showKeyboardHelp) {
          e.preventDefault();
          setShowKeyboardHelp(false);
          return;
        }
        // ? toggles the help
        if (e.key === "?") {
          e.preventDefault();
          setShowKeyboardHelp(true);
          return;
        }
      }

      // Only work on home page
      if (currentPage !== "home") return;

      // "/" to focus search
      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      const currentVideos = filteredVideos;
      if (currentVideos.length === 0) return;

      switch (e.key.toLowerCase()) {
        case "j": // Next video
          e.preventDefault();
          setHighlightedVideoIndex((prev) => {
            const nextIndex =
              prev === null ? 0 : Math.min(prev + 1, currentVideos.length - 1);
            // Scroll to video
            setTimeout(() => {
              const el = videoRefs.current.get(nextIndex);
              if (el) {
                el.scrollIntoView({
                  behavior: "smooth",
                  block: "center",
                });
              }
            }, 0);
            return nextIndex;
          });
          break;

        case "k": // Previous video
          e.preventDefault();
          setHighlightedVideoIndex((prev) => {
            const nextIndex = prev === null ? 0 : Math.max(prev - 1, 0);
            // Scroll to video
            setTimeout(() => {
              const el = videoRefs.current.get(nextIndex);
              if (el) {
                el.scrollIntoView({
                  behavior: "smooth",
                  block: "center",
                });
              }
            }, 0);
            return nextIndex;
          });
          break;

        case "enter": // Open highlighted video
          e.preventDefault();
          if (highlightedVideoIndex !== null) {
            const video = currentVideos[highlightedVideoIndex];
            if (video) {
              window.open(video.url, "_blank");
              handleWatchVideo(video.id);
            }
          }
          break;

        case "w": // Toggle watched
          e.preventDefault();
          if (highlightedVideoIndex !== null) {
            const video = currentVideos[highlightedVideoIndex];
            if (video) {
              handleToggleWatched(video.id);
            }
          }
          break;

        case "l": // Add to watch later
          e.preventDefault();
          if (highlightedVideoIndex !== null) {
            const video = currentVideos[highlightedVideoIndex];
            if (video) {
              handleAddToWatchLater(video);
            }
          }
          break;

        case "escape": // Clear highlight and search
          e.preventDefault();
          setHighlightedVideoIndex(null);
          if (searchQuery) {
            setSearchQuery("");
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    filteredVideos,
    highlightedVideoIndex,
    currentPage,
    showSubscriptions,
    showSettings,
    showWelcomeWizard,
    showKeyboardHelp,
    searchQuery,
  ]);

  // Reset highlight when videos change
  useEffect(() => {
    setHighlightedVideoIndex(null);
  }, [filteredVideos]);

  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 400);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const refreshData = async (forceRefresh = false) => {
    setError(null);
    setShowLoadingProgress(true);
    setIsRefreshing(true);

    try {
      // Fetch lists first
      const listsRes = await fetch("/api/subscription-lists", {
        credentials: "include",
      });
      if (listsRes.status === 401) {
        throw new AuthExpiredError();
      }
      if (!listsRes.ok) {
        throw new Error(`HTTP error! status: ${listsRes.status}`);
      }
      const listsData = await listsRes.json();
      setSubscriptionLists(listsData.lists || []);
      setCurrentListId((prevId) => {
        const listStillExists = (listsData.lists || []).some(
          (l: any) => l.id === prevId
        );
        return prevId && listStillExists ? prevId : "default";
      });

      // Refresh feed via singleton manager
      await feedManager.refresh();
    } catch (err: any) {
      if (err instanceof AuthExpiredError) {
        router.replace("/login");
        return;
      }
      console.error("Failed to refresh:", err);
      setError(err?.message || "Failed to load data");
    } finally {
      setShowLoadingProgress(false);
      setIsRefreshing(false);
      refreshingRef.current = false;
    }
  };

  const loadUserState = async (): Promise<{ hasCompletedWelcome: boolean } | null> => {
    try {
      const res = await fetch("/api/user-state", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const watchedSet = new Set<string>(
          Array.isArray(data.watchedVideos)
            ? data.watchedVideos.filter(
                (id: unknown): id is string => typeof id === "string"
              )
            : []
        );
        watchedVideosRef.current = watchedSet;
        setWatchedVideos(watchedSet);
        // The filter toggles are a per-device preference: what this device last
        // stored wins, and the account-level value only seeds a device that has
        // never stored anything.
        const localFilters = user
          ? readLocalFilterPreferences(user.id)
          : {};
        setHideWatched(
          typeof localFilters.hideWatched === "boolean"
            ? localFilters.hideWatched
            : data.hideWatched || false
        );
        setHideMemberOnly(
          typeof localFilters.hideMemberOnly === "boolean"
            ? localFilters.hideMemberOnly
            : data.hideMemberOnly || false
        );
        setHideShorts(
          typeof localFilters.hideShorts === "boolean"
            ? localFilters.hideShorts
            : data.hideShorts ?? true
        );
        setFilterPrefsHydrated(true);
        setVideoRetentionDays(
          typeof data.videoRetentionDays === "number"
            ? data.videoRetentionDays
            : null
        );
        setWatchedThresholdPercent(
          typeof data.watchedThresholdPercent === "number"
            ? data.watchedThresholdPercent
            : WATCHED_THRESHOLD_DEFAULT
        );
        if (typeof data.filterListId === "string") {
          setFilterListId(data.filterListId);
        }
        if (Array.isArray(data.watchLater)) {
          setWatchLater(
            data.watchLater.map((item: any) => ({
              ...item,
              addedAt: new Date(item.addedAt),
            }))
          );
        }
        const hasCompleted = !!data.hasCompletedWelcome;
        setHasCompletedWelcome(hasCompleted);
        return { hasCompletedWelcome: hasCompleted };
      }
      return null;
    } catch (e) {
      console.error("Failed to load user state:", e);
      return null;
    } finally {
      setUserStateLoaded(true);
    }
  };

  // Toggle and persist hideMemberOnly
  const toggleHideMemberOnlyPersist = async (checked: boolean) => {
    const previousValue = hideMemberOnly;

    // Optimistic update
    setHideMemberOnly(checked);

    // Background persist
    try {
      await persistUserState({ hideMemberOnly: checked });
    } catch (e) {
      // Revert on error
      setHideMemberOnly(previousValue);
      showToast("Failed to save setting", "error");
    }
  };

  // Toggle and persist hideShorts
  const toggleHideShortsPersist = async (checked: boolean) => {
    const previousValue = hideShorts;

    // Optimistic update
    setHideShorts(checked);

    // Background persist
    try {
      await persistUserState({ hideShorts: checked });
    } catch (e) {
      // Revert on error
      setHideShorts(previousValue);
      showToast("Failed to save setting", "error");
    }
  };

  /**
   * Watch positions for videos that are not marked watched yet. The endpoint
   * already filters those out, so this stays small however long the watch
   * history grows.
   */
  const loadVideoProgress = async () => {
    try {
      const res = await fetch("/api/playback-history?compact=1", {
        credentials: "include",
      });
      if (!res.ok) return;
      const rows = await res.json();
      if (!Array.isArray(rows)) return;

      const next = new Map<string, { progress: number; duration: number }>();
      for (const row of rows) {
        if (
          row &&
          typeof row.videoId === "string" &&
          typeof row.progress === "number" &&
          typeof row.duration === "number" &&
          row.duration > 0
        ) {
          next.set(row.videoId, {
            progress: row.progress,
            duration: row.duration,
          });
        }
      }
      videoProgressRef.current = next;
      setVideoProgress(next);
    } catch (e) {
      console.error("Failed to load video progress:", e);
    }
  };

  /** Watch progress as a percentage per video id, for the thumbnail bars. */
  const videoProgressPercents = useMemo(() => {
    const percents = new Map<string, number>();
    videoProgress.forEach((entry, videoId) => {
      if (entry.duration > 0) {
        percents.set(videoId, (entry.progress / entry.duration) * 100);
      }
    });
    return percents;
  }, [videoProgress]);

  // How far a video must play before it counts as watched, per user.
  const handleWatchedThresholdChange = async (percent: number) => {
    const previousValue = watchedThresholdPercent;

    setWatchedThresholdPercent(percent);

    try {
      await persistUserState({ watchedThresholdPercent: percent });
    } catch (e) {
      setWatchedThresholdPercent(previousValue);
      showToast("Failed to save watched threshold", "error");
    }
  };

  // Change and persist how far back this user's feed keeps videos.
  // The server filters the feed by this window, so reload it afterwards.
  const handleRetentionChange = async (days: number | null) => {
    const previousValue = videoRetentionDays;

    setVideoRetentionDays(days);

    try {
      await persistUserState({ videoRetentionDays: days });
      await feedManager.refresh();
    } catch (e) {
      setVideoRetentionDays(previousValue);
      showToast("Failed to save retention setting", "error");
    }
  };

  const handleChangeFilterList = async (newId: string) => {
    const previousValue = filterListId;

    // Optimistic update
    setFilterListId(newId);

    // Background persist to database (no localStorage)
    try {
      await persistUserState({ filterListId: newId });
    } catch (e) {
      // Revert on error
      setFilterListId(previousValue);
      showToast("Failed to save filter list", "error");
    }
  };

  // Initialize state from URL parameters
  useEffect(() => {
    const page = searchParams.get("page");
    if (page === "watch-later") {
      setCurrentPage("watch-later");
    }

    const tab = searchParams.get("tab");
    if (tab === "videos" || tab === "watch-later" || tab === "watch-history") {
      setFeedTab(tab);
    }

    const search = searchParams.get("search");
    if (search) {
      setSearchQuery(search);
    }

    const list = searchParams.get("list");
    if (list) {
      setFilterListId(list);
    }

    const hideWatchedParam = searchParams.get("hideWatched");
    if (hideWatchedParam === "true") {
      setHideWatched(true);
    }

    const hideMemberOnlyParam = searchParams.get("hideMemberOnly");
    if (hideMemberOnlyParam === "true") {
      setHideMemberOnly(true);
    }

    // hideShorts defaults to true, so unlike the other filter params only the
    // non-default case (shorts explicitly shown) needs to appear in the URL.
    const hideShortsParam = searchParams.get("hideShorts");
    if (hideShortsParam === "false") {
      setHideShorts(false);
    }
  }, [searchParams]);

  // Update URL when state changes
  useEffect(() => {
    const params = new URLSearchParams();

    if (currentPage === "watch-later") {
      params.set("page", "watch-later");
    }

    if (currentPage === "home" && feedTab !== "videos") {
      params.set("tab", feedTab);
    }

    if (searchQuery) {
      params.set("search", searchQuery);
    }

    if (filterListId && filterListId !== "all") {
      params.set("list", filterListId);
    }

    if (hideWatched) {
      params.set("hideWatched", "true");
    }

    if (hideMemberOnly) {
      params.set("hideMemberOnly", "true");
    }

    if (!hideShorts) {
      params.set("hideShorts", "false");
    }

    const newUrl = params.toString() ? `?${params.toString()}` : "/";
    router.replace(newUrl, { scroll: false });
  }, [
    currentPage,
    feedTab,
    searchQuery,
    filterListId,
    hideWatched,
    hideMemberOnly,
    hideShorts,
    router,
  ]);

  // Initialize data on mount using singleton feed manager
  useEffect(() => {
    // Skip initialization while auth is still loading
    if (authLoading) {
      return;
    }

    // If user is not authenticated, don't initialize app data
    if (!user) {
      return;
    }

    // Subscribe to feed manager (skip auto-init, we'll initialize manually based on welcome state)
    const unsubscribe = feedManager.subscribe(
      (feedData) => {
        if (!videoListsMatch(videosRef.current, feedData.videos)) {
          setVideos(feedData.videos);
          videosRef.current = feedData.videos;
        }

        // Update loading/fetching/error when values change
        if (loadingRef.current !== feedData.loading) {
          setLoading(feedData.loading);
          loadingRef.current = feedData.loading;
        }

        if (fetchingRef.current !== feedData.fetching) {
          // Don't show loading progress during welcome wizard
          setShowLoadingProgress(feedData.fetching && !showWelcomeWizard);
          fetchingRef.current = feedData.fetching;
        }

        if (errorRef.current !== feedData.error) {
          setError(feedData.error);
          errorRef.current = feedData.error;
        }
      },
      true // Skip auto-init
    );

    // Load other settings and user state
    const init = async () => {
      if (initializingRef.current) {
        return;
      }
      initializingRef.current = true;

      try {
        const appSettings = await getSettings();
        setSettings(appSettings);

        // ALWAYS check wizard completion status directly from database API
        // Do not rely on any React state variables - only trust the database
        try {
          const res = await fetch("/api/user-state", { credentials: "include" });
          if (res.ok) {
            const data = await res.json();
            const hasCompleted = !!data.hasCompletedWelcome;
            
            // Update local state for UI consistency, but decision is based on database
            setHasCompletedWelcome(hasCompleted);
            
            // Show welcome wizard only if database says user has not completed it
            if (!hasCompleted) {
              setShowWelcomeWizard(true);
            } else {
              setShowWelcomeWizard(false);
              feedManager.initialize().catch((initErr) => {
                if (initErr instanceof AuthExpiredError) {
                  router.replace("/login");
                  return;
                }
                console.error("Failed to initialize feed:", initErr);
              });
            }
          } else {
            console.error("[Init] Failed to load user state from database");
            // If we can't check database, show wizard to be safe
            setShowWelcomeWizard(true);
          }
        } catch (e) {
          console.error("[Init] Error checking database for wizard status:", e);
          // If we can't check database, show wizard to be safe
          setShowWelcomeWizard(true);
        }

        // Load full user state for other settings
        await loadUserState();

        // Watch positions for the thumbnail progress bars and resume.
        await loadVideoProgress();

        // Load subscription lists
        try {
          const listsRes = await fetch("/api/subscription-lists", {
            credentials: "include",
          });
          if (listsRes.ok) {
            const listsData = await listsRes.json();
            setSubscriptionLists(listsData.lists || []);
          }
        } catch (e) {
          console.error("Failed to load subscription lists:", e);
        }
      } catch (e) {
        console.error("Failed to load settings:", e);
      } finally {
        initializingRef.current = false;
      }
    };

    init();
  }, [authLoading, user]);

  // Persist the filter toggles to this device, so the next sign-in on the same
  // browser starts with them already applied.
  useEffect(() => {
    if (!user || !filterPrefsHydrated) return;
    writeLocalFilterPreferences(user.id, {
      hideWatched,
      hideMemberOnly,
      hideShorts,
    });
  }, [hideWatched, hideMemberOnly, hideShorts, user, filterPrefsHydrated]);

  // Persist hideWatched to database
  useEffect(() => {
    if (!user || !filterPrefsHydrated) return;
    persistUserState({ hideWatched });
  }, [hideWatched, user, filterPrefsHydrated]);

  // Persist hideMemberOnly to database
  useEffect(() => {
    if (!user || !filterPrefsHydrated) return;
    persistUserState({ hideMemberOnly });
  }, [hideMemberOnly, user, filterPrefsHydrated]);

  // Persist hideShorts to database
  useEffect(() => {
    if (!user || !filterPrefsHydrated) return;
    persistUserState({ hideShorts });
  }, [hideShorts, user, filterPrefsHydrated]);

  // Persist filterListId to database
  useEffect(() => {
    if (!user) return; // Don't persist before user is authenticated
    persistUserState({ filterListId });
  }, [filterListId, user]);

  // Update loading progress visibility when welcome wizard visibility changes
  // This ensures the loading bar hides/shows correctly based on welcome state
  useEffect(() => {
    if (!showWelcomeWizard && fetchingRef.current) {
      setShowLoadingProgress(true);
    } else if (showWelcomeWizard) {
      setShowLoadingProgress(false);
    }
  }, [showWelcomeWizard]);

  // Handle Escape key to clear search
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && searchQuery) {
        setSearchQuery("");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchQuery]);

  // Handle search and filter
  useEffect(() => {
    // Debounce filtering and sorting to avoid race conditions when
    // subscription lists and videos update in quick succession.
    const timer = setTimeout(() => {
      const vids = filterAndSortVideos(videos, {
        searchQuery,
        filterListId,
        subscriptionLists,
        hideWatched,
        hideMemberOnly,
        hideShorts,
        watchedVideos,
        settings,
      });
      setFilteredVideos(vids);
    }, 200);

    return () => clearTimeout(timer);
  }, [
    searchQuery,
    videos,
    hideWatched,
    hideMemberOnly,
    hideShorts,
    watchedVideos,
    settings?.defaultSortOrder,
    filterListId,
    subscriptionLists,
  ]);

  // Keep player default quality synced with saved settings (best-effort for YouTube iframe).
  useEffect(() => {
    if (!settings?.defaultPlayerResolution) return;
    setPlayerQuality(settings.defaultPlayerResolution);
  }, [settings?.defaultPlayerResolution]);

  // Helper function to persist user state in background.
  // Writes are serialized to avoid races between rapid updates.
  const persistUserState = async (
    updates: Partial<{
      watchedVideos: string[];
      hideWatched: boolean;
      hideMemberOnly: boolean;
      hideShorts: boolean;
      filterListId: string;
      watchLater: WatchLaterItem[];
      hasCompletedWelcome: boolean;
      videoRetentionDays: number | null;
      watchedThresholdPercent: number;
    }>
  ) => {
    const runPersist = async () => {
      const res = await fetch("/api/user-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        throw new Error("Failed to save user state");
      }

      if (updates.hasCompletedWelcome !== undefined) {
        setHasCompletedWelcome(updates.hasCompletedWelcome);
      }
    };

    const queuedRun = persistQueueRef.current.then(runPersist);
    persistQueueRef.current = queuedRun.catch(() => {});
    return queuedRun;
  };

  const handleAddSubscription = async (url: string) => {
    try {
      await addSubscription(url, currentListId);
      await refreshData();
    } catch (err) {
      console.error(err);
      throw err;
    }
  };

  const handleImportSubscriptions = async (data: string, format?: string) => {
    await importSubscriptions(data, format, currentListId);
    // Force refresh of feed to pick up newly imported subscriptions
    await refreshData(true);
    // Re-fetch lists after feed generation completes to pick up enriched thumbnails
    setTimeout(async () => {
      try {
        const listsRes = await fetch("/api/subscription-lists", {
          credentials: "include",
        });
        if (listsRes.ok) {
          const listsData = await listsRes.json();
          setSubscriptionLists(listsData.lists || []);
        }
      } catch {}
    }, 2000);
  };

  const handleExportSubscriptions = async (format: "opml" | "json") => {
    const data = await exportSubscriptions(format, currentListId);
    const mimeType = format === "json" ? "application/json" : "application/xml";
    const extension = format === "json" ? "json" : "opml";
    const currentList = subscriptionLists.find((l) => l.id === currentListId);
    const listName = currentList?.name || "subscriptions";
    const sanitizedListName = listName.toLowerCase().replace(/\s+/g, "-");
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tubeshelf-${sanitizedListName}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleSaveSettings = async (updates: Partial<typeof settings>) => {
    try {
      await updateSettings(updates);
      const freshSettings = await getSettings();
      setSettings(freshSettings);

      // No content filter changes anymore - videoPlayerMode doesn't affect feed
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  };

  const handleDeleteAllSubscriptions = async (listId?: string) => {
    const res = await fetch("/api/subscription-lists/subscriptions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "clear", listId: listId || null }),
    });
    if (!res.ok) throw new Error("Failed to delete subscriptions");
    await refreshData();
  };

  const handleClearWatchHistory = async () => {
    await clearWatchHistory();
    const cleared = new Set<string>();
    watchedVideosRef.current = cleared;
    setWatchedVideos(cleared);
  };

  const handleResetAllSettings = async () => {
    try {
      await resetAllSettings();
      const freshSettings = await getSettings();
      setSettings(freshSettings);
      // The server side of the reset clears the filter toggles too, so drop the
      // per-device copy as well instead of letting it restore them on reload.
      if (user) clearLocalFilterPreferences(user.id);
      setHideWatched(false);
      setHideMemberOnly(false);
    } catch (err) {
      console.error("Failed to reset settings:", err);
    }
  };

  const handleDeleteAccount = async () => {
    const res = await fetch("/api/danger/delete-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    if (!res.ok) throw new Error("Failed to delete account");
    // Note: User will be redirected in the component after showing the toast
  };

  const handleRemoveSubscription = async (id: string) => {
    try {
      await removeSubscription(id, currentListId);
      await refreshData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleMoveSubscription = async (
    subscriptionId: string,
    targetListId: string
  ) => {
    try {
      const res = await fetch("/api/subscription-lists/subscriptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "move",
          channelId: subscriptionId,
          fromListId: currentListId,
          toListId: targetListId,
        }),
      });
      if (!res.ok) throw new Error("Failed to move subscription");
      const data = await res.json();
      setSubscriptionLists(data.lists);
    } catch (err) {
      console.error(err);
      throw err;
    }
  };

  const handleWatchVideo = (videoId: string) => {
    const previousWatched = new Set(watchedVideosRef.current);
    const newWatched = new Set(watchedVideosRef.current);
    newWatched.add(videoId);

    // Optimistic update
    watchedVideosRef.current = newWatched;
    setWatchedVideos(newWatched);

    // Persist in background
    persistUserState({ watchedVideos: Array.from(newWatched) }).catch(() => {
      // Revert on error
      watchedVideosRef.current = previousWatched;
      setWatchedVideos(previousWatched);
      showToast("Failed to save watch status", "error");
    });
  };

  const handlePlayWatchLater = (item: WatchLaterItem) => {
    const videoUrl = `https://www.youtube.com/watch?v=${item.videoId}`;
    if (settings?.videoPlayerMode !== "new-tab") {
      handlePlayInPlayer(
        videoUrl,
        item.videoId,
        item.title,
        item.channel,
        undefined,
        item.thumbnail
      );
    } else {
      window.open(videoUrl, "_blank", "noopener,noreferrer");
      // Leaving for youtube.com ends any chance of following the position.
      handleWatchVideo(item.videoId);
    }
  };

  const handlePlayInPlayer = useCallback(
    (
      videoUrl: string,
      videoId: string,
      title: string,
      channel: string,
      channelId?: string,
      thumbnail?: string,
      // Watch history knows positions for videos already marked watched, which
      // the progress map deliberately leaves out.
      fallbackResumeSeconds?: number
    ) => {
      // Prevent hash change event from re-triggering
      closingPlayerRef.current = true;

      // Apply saved default player resolution when opening each video.
      setPlayerQuality(settings?.defaultPlayerResolution ?? "1080p");

      // Set player state first
      setPlayerVideo({
        videoUrl,
        videoId,
        title,
        channel,
        channelId,
        thumbnail,
      });
      setShowPlayer(true);

      // Update URL hash with video ID for shareable links
      window.location.hash = `player=${videoId}`;

      // Opening no longer counts as watching; the player marks it watched once
      // playback passes the threshold. Pick up where this video was left off.
      const knownResume = resolveResumeSeconds(videoId);
      setInitialProgress(
        knownResume ||
          (typeof fallbackResumeSeconds === "number" &&
          fallbackResumeSeconds >= 10
            ? fallbackResumeSeconds
            : 0)
      );

      // Allow hash changes again after a brief moment
      setTimeout(() => {
        closingPlayerRef.current = false;
      }, 50);
    },
    [settings?.defaultPlayerResolution, resolveResumeSeconds]
  );

  const handleClosePlayer = useCallback(() => {
    // Mark that we're closing so the hash effect doesn't reopen
    closingPlayerRef.current = true;
    setShowPlayer(false);
    setPlayerVideo(null);
    setInitialProgress(0);

    // Clear the hash - this is instantly visible
    window.location.hash = "";

    // Reset closing flag after a moment
    setTimeout(() => {
      closingPlayerRef.current = false;
    }, 100);
  }, []);

  const handlePlayerProgress = (progress: number, duration: number) => {
    if (!playerVideo) return;

    // Keep the local map in step so the thumbnail bar is already right when the
    // player closes, without refetching the positions.
    if (Number.isFinite(progress) && Number.isFinite(duration) && duration > 0) {
      const next = new Map(videoProgressRef.current);
      next.set(playerVideo.videoId, { progress, duration });
      videoProgressRef.current = next;
      setVideoProgress(next);
    }

    // Always save playback progress (no minimum threshold)
    // This will be reported every 5 seconds by the player
    fetch("/api/playback-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      keepalive: true,
      body: JSON.stringify({
        videoId: playerVideo.videoId,
        videoTitle: playerVideo.title,
        channelId: playerVideo.channelId || "",
        channelName: playerVideo.channel,
        thumbnail: playerVideo.thumbnail || "",
        timestamp: new Date().toISOString(),
        duration,
        progress,
        completed: (progress / duration) * 100 >= watchedThresholdPercent,
      }),
    }).catch((err) => console.error("Failed to save playback progress:", err));
  };

  /**
   * `silent` suppresses the toast for callers that announce the change
   * themselves, such as the player's own heads-up display.
   */
  const handleToggleWatched = (
    videoId: string,
    options?: { silent?: boolean }
  ) => {
    const wasWatched = watchedVideosRef.current.has(videoId);
    const previousWatched = new Set(watchedVideosRef.current);
    const newWatched = new Set(watchedVideosRef.current);

    if (wasWatched) {
      newWatched.delete(videoId);
    } else {
      newWatched.add(videoId);
    }

    // Optimistic update
    watchedVideosRef.current = newWatched;
    setWatchedVideos(newWatched);

    // Marking unwatched means "start this one over": the position goes back to
    // zero, but the history entry survives so the watch history keeps it.
    if (wasWatched) {
      const next = new Map(videoProgressRef.current);
      next.delete(videoId);
      videoProgressRef.current = next;
      setVideoProgress(next);

      fetch("/api/playback-history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ videoId }),
      }).catch((err) =>
        console.error("Failed to reset playback progress:", err)
      );
    }

    // Persist in background
    persistUserState({ watchedVideos: Array.from(newWatched) }).catch(() => {
      // Revert on error
      watchedVideosRef.current = previousWatched;
      setWatchedVideos(previousWatched);
      showToast("Failed to save watch status", "error");
    });

    if (options?.silent) return;

    // Show toast with undo
    if (wasWatched) {
      showToast("Marked as unwatched", "success", () => {
        // Undo
        const undoWatched = new Set(watchedVideosRef.current);
        undoWatched.add(videoId);
        watchedVideosRef.current = undoWatched;
        setWatchedVideos(undoWatched);
        persistUserState({ watchedVideos: Array.from(undoWatched) });
      });
    } else {
      showToast("Marked as watched", "success", () => {
        // Undo
        const undoWatched = new Set(watchedVideosRef.current);
        undoWatched.delete(videoId);
        watchedVideosRef.current = undoWatched;
        setWatchedVideos(undoWatched);
        persistUserState({ watchedVideos: Array.from(undoWatched) });
      });
    }
  };

  const handleAddToWatchLater = (video: Video) => {
    const alreadyExists = watchLater.some((w) => w.videoId === video.id);

    if (alreadyExists) {
      showToast("Already in Watch Later", "info");
      return;
    }

    const item: WatchLaterItem = {
      id: `wl-${video.id}`,
      videoId: video.id,
      title: video.title,
      channel: video.channel,
      thumbnail: video.thumbnail,
      addedAt: new Date(),
    };

    const previousWatchLater = watchLater;
    const newWatchLater = [item, ...watchLater];

    // Optimistic update
    setWatchLater(newWatchLater);

    // Persist in background
    persistUserState({ watchLater: newWatchLater }).catch(() => {
      // Revert on error
      setWatchLater(previousWatchLater);
      showToast("Failed to add to Watch Later", "error");
    });

    showToast("Added to Watch Later", "success", () => {
      // Undo
      setWatchLater(previousWatchLater);
      persistUserState({ watchLater: previousWatchLater });
    });
  };

  const handleRemoveFromWatchLater = (id: string) => {
    const removedItem = watchLater.find((w) => w.id === id);
    const previousWatchLater = watchLater;
    const newWatchLater = watchLater.filter((w) => w.id !== id);

    // Optimistic update
    setWatchLater(newWatchLater);

    // Persist in background
    persistUserState({ watchLater: newWatchLater }).catch(() => {
      // Revert on error
      setWatchLater(previousWatchLater);
      showToast("Failed to remove from Watch Later", "error");
    });

    if (removedItem) {
      showToast("Removed from Watch Later", "success", () => {
        // Undo
        setWatchLater(previousWatchLater);
        persistUserState({ watchLater: previousWatchLater });
      });
    }
  };

  const handleWatchLaterThumbnailError = (item: WatchLaterItem) => {
    const fallbackThumbnail = `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
    if (!item.thumbnail || item.thumbnail === fallbackThumbnail) {
      return;
    }

    const updated = watchLater.map((w) =>
      w.id === item.id ? { ...w, thumbnail: fallbackThumbnail } : w
    );

    setWatchLater(updated);
    persistUserState({ watchLater: updated }).catch(() => {
      // If the persist fails, keep UI consistent with in-memory state
      setWatchLater(updated);
    });
  };

  const handleWelcomeWizardComplete = async (options: WelcomeOptions) => {
    try {
      // Mark welcome as completed in the database FIRST (before any other operations)
      // This ensures the database is updated even if other operations fail
      await persistUserState({ hasCompletedWelcome: true });

      // Verify the save succeeded by checking database directly
      const verifyRes = await fetch("/api/user-state", { credentials: "include" });
      if (verifyRes.ok) {
        const verifyData = await verifyRes.json();
        const verified = !!verifyData.hasCompletedWelcome;
        if (!verified) {
          throw new Error("Database verification failed - hasCompletedWelcome not set");
        }
      } else {
        throw new Error("Failed to verify database save");
      }

      // Update local state only after database verification
      setShowWelcomeWizard(false);
      setWelcomeCompleted(true);
      setHasCompletedWelcome(true);

      // Apply wizard settings (fetchMethod)
      try {
        await updateSettings({
          fetchMethod: options.fetchMethod,
        });
        const freshSettings = await getSettings();
        setSettings(freshSettings);
      } catch (err) {
        console.error("Failed to update settings:", err);
        // Non-critical error, continue
      }

      // Initialize feedManager to start loading the feed
      try {
        await feedManager.initialize();
      } catch (err) {
        console.error("Failed to initialize feed:", err);
        // Non-critical error, continue
      }
    } catch (err) {
      console.error("Failed to complete welcome wizard:", err);
      // Verify database state - only show wizard if database says it's not completed
      try {
        const verifyRes = await fetch("/api/user-state", { credentials: "include" });
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json();
          const hasCompleted = !!verifyData.hasCompletedWelcome;
          if (!hasCompleted) {
            console.error("[WelcomeComplete] Database verification shows not completed, showing wizard");
            setShowWelcomeWizard(true);
            setWelcomeCompleted(false);
          } else {
            setShowWelcomeWizard(false);
            setHasCompletedWelcome(true);
          }
        }
      } catch (verifyErr) {
        console.error("[WelcomeComplete] Failed to verify database state:", verifyErr);
        setShowWelcomeWizard(true);
        setWelcomeCompleted(false);
      }
    }
  };

  const handleWelcomeWizardSkip = async () => {
    try {
      // Mark welcome as completed in the database FIRST (before any other operations)
      // This ensures the database is updated even if other operations fail
      await persistUserState({ hasCompletedWelcome: true });

      // Verify the save succeeded by checking database directly
      const verifyRes = await fetch("/api/user-state", { credentials: "include" });
      if (verifyRes.ok) {
        const verifyData = await verifyRes.json();
        const verified = !!verifyData.hasCompletedWelcome;
        if (!verified) {
          throw new Error("Database verification failed - hasCompletedWelcome not set");
        }
      } else {
        throw new Error("Failed to verify database save");
      }

      // Update local state only after database verification
      setShowWelcomeWizard(false);
      setWelcomeCompleted(true);
      setHasCompletedWelcome(true);

      // Initialize feedManager to start loading the feed
      try {
        await feedManager.initialize();
      } catch (err) {
        console.error("Failed to initialize feed:", err);
        // Non-critical error, continue
      }
    } catch (err) {
      console.error("Failed to skip welcome wizard:", err);
      // Verify database state - only show wizard if database says it's not completed
      try {
        const verifyRes = await fetch("/api/user-state", { credentials: "include" });
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json();
          const hasCompleted = !!verifyData.hasCompletedWelcome;
          if (!hasCompleted) {
            console.error("[WelcomeSkip] Database verification shows not completed, showing wizard");
            setShowWelcomeWizard(true);
            setWelcomeCompleted(false);
          } else {
            setShowWelcomeWizard(false);
            setHasCompletedWelcome(true);
          }
        }
      } catch (verifyErr) {
        console.error("[WelcomeSkip] Failed to verify database state:", verifyErr);
        setShowWelcomeWizard(true);
        setWelcomeCompleted(false);
      }
    }
  };

  const handleWelcomeWizardImportFile = async (file: File) => {
    try {
      const text = await file.text();
      await importSubscriptions(
        text,
        file.name.endsWith(".opml") ? "opml" : "json",
        currentListId
      );

      // Reload subscription lists to update the counter
      const listsRes = await fetch("/api/subscription-lists", {
        credentials: "include",
      });
      if (listsRes.ok) {
        const listsData = await listsRes.json();
        setSubscriptionLists(listsData.lists || []);
      }
    } catch (err) {
      throw new Error(
        err instanceof Error ? err.message : "Failed to import file"
      );
    }
  };

  const iconUrl = useMemo(
    () => getThemeIconUrl(theme, mounted),
    [theme, mounted]
  );

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Navigation */}
      <nav className="sticky top-0 z-40 border-b border-border/50 bg-card/90 backdrop-blur-md shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <div
                className="flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  setCurrentPage("home");
                  setSearchQuery("");
                }}
              >
                <img
                  src={iconUrl}
                  alt=""
                  className={`h-11 w-11 transition-opacity duration-300 ${
                    mounted ? "opacity-100" : "opacity-0"
                  }`}
                />
                <h1 className="text-xl font-bold hidden sm:block">TubeShelf</h1>
              </div>
            </div>

            {/* Search */}
            <div className="hidden md:flex flex-1 max-w-md mx-8">
              <div className="relative w-full">
                <ClientOnly>
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                </ClientOnly>
                <Input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search videos..."
                  className="w-full text-sm pl-10 pr-12"
                />
                {!searchQuery && (
                  <kbd className="absolute right-3 top-1/2 transform -translate-y-1/2 px-2 py-0.5 text-xs bg-secondary border border-border rounded font-mono text-muted-foreground pointer-events-none">
                    /
                  </kbd>
                )}
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    title="Clear search (or press Escape)"
                  >
                    <ClientOnly>
                      <X className="w-4 h-4" />
                    </ClientOnly>
                  </button>
                )}
              </div>
            </div>

            {/* Right Actions */}
            <div className="flex items-center gap-2">
              {/* Keyboard shortcuts help */}
              <div className="relative">
                <Button
                  onClick={() => setShowKeyboardHelp(!showKeyboardHelp)}
                  variant="ghost"
                  size="icon"
                  title="Keyboard shortcuts"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="M6 8h.01" />
                    <path d="M10 8h.01" />
                    <path d="M14 8h.01" />
                    <path d="M18 8h.01" />
                    <path d="M8 12h.01" />
                    <path d="M12 12h.01" />
                    <path d="M16 12h.01" />
                    <path d="M7 16h10" />
                  </svg>
                </Button>
                {showKeyboardHelp && (
                  <div className="keyboard-help-menu absolute right-0 mt-2 w-80 bg-card border border-border/50 rounded-lg shadow-xl backdrop-blur-sm z-50 overflow-hidden">
                    {/* Header */}
                    <div className="bg-gradient-to-r from-primary/5 to-transparent border-b border-border/30 px-4 py-3">
                      <h3 className="font-semibold text-sm text-foreground">
                        Keyboard Shortcuts
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Quick navigation and controls
                      </p>
                    </div>

                    {/* Content */}
                    <div className="p-3 space-y-1">
                      {[
                        { action: "Focus search", key: "/" },
                        { action: "Next video", key: "J" },
                        { action: "Previous video", key: "K" },
                        { action: "Open video", key: "Enter" },
                        { action: "Toggle watched", key: "W" },
                        { action: "Watch later", key: "L" },
                        { action: "Close menu", key: "Esc" },
                      ].map((item, idx) => (
                        <div
                          key={idx}
                          className="flex justify-between items-center px-3 py-2 rounded-md hover:bg-primary/5 transition-colors group"
                        >
                          <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                            {item.action}
                          </span>
                          <kbd className="px-2 py-1 bg-secondary/60 hover:bg-secondary border border-border/50 rounded text-xs font-mono font-medium transition-colors">
                            {item.key}
                          </kbd>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <Button
                onClick={() => setShowSubscriptions(true)}
                variant="secondary"
                size="sm"
                className="hidden sm:flex gap-1"
                title="Manage subscriptions"
              >
                <ClientOnly>
                  <List className="w-5 h-5" />
                </ClientOnly>
                Manage
              </Button>
              {/* User Profile Menu */}
              <div className="relative">
                <Button
                  onClick={() => setShowUserMenu(!showUserMenu)}
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-2"
                  title="User profile"
                >
                  <ClientOnly>
                    <User className="w-4 h-4" />
                  </ClientOnly>
                  <span className="hidden sm:inline">
                    {user?.name || user?.email}
                  </span>
                  <ClientOnly>
                    <ChevronDown className="w-3 h-3" />
                  </ClientOnly>
                </Button>
                {showUserMenu && (
                  <div className="user-menu absolute right-0 mt-2 w-64 bg-card border border-border/50 rounded-lg shadow-xl backdrop-blur-sm z-50 overflow-hidden">
                    {/* User Info Header */}
                    <div className="bg-gradient-to-r from-primary/5 to-transparent border-b border-border/30 px-4 py-3">
                      <p className="font-semibold text-sm text-foreground">
                        {user?.name || "User"}
                      </p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {user?.email}
                      </p>
                      <div className="mt-2">
                        <span
                          className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                            user?.isAdmin
                              ? "bg-primary/15 text-primary border border-primary/20"
                              : "bg-secondary/60 text-muted-foreground border border-border/30"
                          }`}
                        >
                          {user?.isAdmin ? "Administrator" : "User"}
                        </span>
                      </div>
                    </div>

                    {/* Menu Items */}
                    <div className="py-1">
                      <button
                        onClick={() => {
                          setShowUserMenu(false);
                          preloadSettings();
                          setCurrentPage("dashboard");
                          setCurrentDashboardSection("profile");
                        }}
                        onMouseEnter={preloadSettings}
                        className="w-full px-4 py-2.5 text-left text-sm hover:bg-primary/5 transition-colors cursor-pointer flex items-center gap-3 text-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-inset"
                      >
                        <ClientOnly>
                          <Settings className="w-4 h-4 flex-shrink-0" />
                        </ClientOnly>
                        <span>Settings</span>
                      </button>
                    </div>

                    {/* Logout Button */}
                    <div className="border-t border-border/30">
                      <button
                        onClick={() => {
                          setShowUserMenu(false);
                          logout();
                        }}
                        className="w-full px-4 py-2.5 text-left text-sm hover:bg-destructive/10 text-destructive transition-colors cursor-pointer flex items-center gap-3 focus:outline-none focus:ring-2 focus:ring-destructive/50 focus:ring-inset"
                      >
                        <ClientOnly>
                          <LogOut className="w-4 h-4 flex-shrink-0" />
                        </ClientOnly>
                        <span>Logout</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Mobile Search */}
          <div className="md:hidden pb-4">
            <div className="relative">
              <ClientOnly>
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              </ClientOnly>
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search videos..."
                className="w-full text-sm pl-10 pr-9"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  title="Clear search (or press Escape)"
                >
                  <ClientOnly>
                    <X className="w-4 h-4" />
                  </ClientOnly>
                </button>
              )}
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 w-full">
        {authWarnings.generatedAuthSecretFallback && (
          <div className="mb-6 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-500" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  Auto-generated auth secret is in use
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Set <code>BETTER_AUTH_SECRET</code> (32+ chars) in the server
                  environment. Changing the secret will log users out.
                </p>
              </div>
            </div>
          </div>
        )}
        {currentPage === "home" ? (
          <>
            {/* Page Header */}
            <div className="mb-10">
              <div className="flex items-center gap-4 mb-4">
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
                  Your Feed
                </h2>
                <Button
                  onClick={() => refreshData(true)}
                  variant="ghost"
                  size="sm"
                  disabled={isRefreshing}
                  title="Refresh feed"
                  className="h-auto px-2 mt-1"
                >
                  <ClientOnly>
                    <RefreshCw
                      className={`w-5 h-5 ${
                        isRefreshing ? "animate-spin" : ""
                      }`}
                    />
                  </ClientOnly>
                </Button>
                <ClientOnly>
                  <LoadingProgress isVisible={showLoadingProgress} />
                </ClientOnly>
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
                <span>
                  {(() => {
                    if (filterListId === "all") {
                      const uniqueChannels = new Set<string>();
                      subscriptionLists.forEach((list) => {
                        list.subscriptions.forEach((sub) => {
                          uniqueChannels.add(sub.channelId);
                        });
                      });
                      return uniqueChannels.size;
                    } else {
                      const selectedList = subscriptionLists.find(
                        (l) => l.id === filterListId
                      );
                      return selectedList?.subscriptions.length || 0;
                    }
                  })()}{" "}
                  subscriptions
                </span>
                <span>•</span>
                <span>{filteredVideos.length} videos</span>
              </div>
              {error && (
                <p className="text-sm text-destructive mt-2">{error}</p>
              )}
            </div>

            {/* Mobile Subscription Button */}
            <div className="sm:hidden mb-6">
              <Button
                onClick={() => setShowSubscriptions(true)}
                variant="default"
                className="w-full"
              >
                <ClientOnly>
                  <List className="w-5 h-5 mr-2" />
                </ClientOnly>
                Manage Subscriptions
              </Button>
            </div>

            {loading ? (
              <div className="text-center py-12">
                {/* Loading progress shown via LoadingProgress modal */}
              </div>
            ) : (
              <>
                {/* Tabs and Controls */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-6 border-b border-border/30">
                  <div className="flex gap-1 overflow-x-auto max-w-full [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    <button
                      onClick={() => setFeedTab("videos")}
                      className={`px-3 sm:px-4 py-3 font-medium transition-all duration-200 relative flex flex-shrink-0 items-center gap-2 whitespace-nowrap ${
                        feedTab === "videos"
                          ? "text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      } after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 ${
                        feedTab === "videos"
                          ? "after:bg-primary"
                          : "after:bg-transparent"
                      } hover:after:bg-primary/50`}
                    >
                      <ClientOnly>
                        <Play className="w-4 h-4" />
                      </ClientOnly>
                      Videos
                    </button>
                    <button
                      onClick={() => setFeedTab("watch-later")}
                      className={`px-3 sm:px-4 py-3 font-medium transition-all duration-200 relative flex flex-shrink-0 items-center gap-2 whitespace-nowrap ${
                        feedTab === "watch-later"
                          ? "text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      } after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 ${
                        feedTab === "watch-later"
                          ? "after:bg-primary"
                          : "after:bg-transparent"
                      } hover:after:bg-primary/50`}
                    >
                      <ClientOnly>
                        <Bookmark className="w-4 h-4" />
                      </ClientOnly>
                      Watch Later
                      {watchLater.length > 0 && (
                        <span className="bg-primary text-primary-foreground text-xs font-bold rounded-full px-1.5 min-w-[20px] text-center">
                          {watchLater.length}
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => setFeedTab("watch-history")}
                      className={`px-3 sm:px-4 py-3 font-medium transition-all duration-200 relative flex flex-shrink-0 items-center gap-2 whitespace-nowrap ${
                        feedTab === "watch-history"
                          ? "text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      } after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 ${
                        feedTab === "watch-history"
                          ? "after:bg-primary"
                          : "after:bg-transparent"
                      } hover:after:bg-primary/50`}
                    >
                      <ClientOnly>
                        <Clock className="w-4 h-4" />
                      </ClientOnly>
                      Watch History
                    </button>
                  </div>
                  <div className="relative flex items-center justify-end gap-3 min-w-0 pb-2">
                    {/* Filter menu - only show on home page videos tab */}
                    {currentPage === "home" && feedTab === "videos" && (
                      <div className="sm:relative" ref={moreMenuRef}>
                        <button
                          onClick={() => setShowMoreMenu((s) => !s)}
                          aria-label="More options"
                          title="Filter options"
                          className={`p-2 rounded-md transition-all duration-150 ${
                            showMoreMenu
                              ? "bg-primary/10 text-primary hover:bg-primary/20"
                              : "text-muted-foreground hover:text-foreground hover:bg-primary/5"
                          } focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-0`}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            className="w-4 h-4"
                          >
                            <circle cx="12" cy="5" r="2" />
                            <circle cx="12" cy="12" r="2" />
                            <circle cx="12" cy="19" r="2" />
                          </svg>
                        </button>

                        {showMoreMenu && (
                          <div className="absolute right-0 mt-2 w-72 max-w-[calc(100vw-2rem)] bg-card border border-border/50 rounded-lg shadow-xl backdrop-blur-sm p-0 z-50 overflow-hidden">
                            {/* Header */}
                            <div className="bg-gradient-to-r from-primary/5 to-transparent border-b border-border/30 px-4 py-3">
                              <h3 className="font-semibold text-sm text-foreground">
                                Filter Options
                              </h3>
                            </div>

                            {/* Items */}
                            <div className="p-3 space-y-2">
                              <label className="flex items-center justify-between px-3 py-2.5 rounded-md hover:bg-primary/5 transition-all cursor-pointer group">
                                <div className="text-sm font-medium text-foreground">
                                  Hide watched videos
                                </div>
                                <div className="flex-shrink-0 ml-3">
                                  <Switch
                                    checked={hideWatched}
                                    onCheckedChange={(checked) => {
                                      const previousValue = hideWatched;
                                      setHideWatched(checked);
                                      persistUserState({
                                        hideWatched: checked,
                                      }).catch(() => {
                                        setHideWatched(previousValue);
                                        showToast(
                                          "Failed to save setting",
                                          "error"
                                        );
                                      });
                                    }}
                                  />
                                </div>
                              </label>

                              <label className="flex items-center justify-between px-3 py-2.5 rounded-md hover:bg-primary/5 transition-all cursor-pointer group">
                                <div className="text-sm font-medium text-foreground">
                                  Hide member-only videos
                                </div>
                                <div className="flex-shrink-0 ml-3">
                                  <Switch
                                    checked={hideMemberOnly}
                                    onCheckedChange={
                                      toggleHideMemberOnlyPersist
                                    }
                                  />
                                </div>
                              </label>

                              <label className="flex items-center justify-between px-3 py-2.5 rounded-md hover:bg-primary/5 transition-all cursor-pointer group">
                                <div className="text-sm font-medium text-foreground">
                                  Hide Shorts
                                </div>
                                <div className="flex-shrink-0 ml-3">
                                  <Switch
                                    checked={hideShorts}
                                    onCheckedChange={toggleHideShortsPersist}
                                  />
                                </div>
                              </label>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* List Filter */}
                    {feedTab === "videos" && (
                      <select
                        value={filterListId}
                        onChange={(e) => handleChangeFilterList(e.target.value)}
                        className="min-w-0 max-w-full truncate px-3 py-1.5 text-sm bg-secondary border border-border/50 rounded-lg cursor-pointer hover:border-border transition-all duration-200 focus:border-primary focus:outline-none"
                      >
                        <option value="all">All Lists</option>
                        {subscriptionLists
                          .sort((a, b) =>
                            a.id === "default" ? -1 : b.id === "default" ? 1 : 0
                          )
                          .map((list) => (
                            <option key={list.id} value={list.id}>
                              {list.name}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </div>

                {/* Videos Tab */}
                {feedTab === "videos" && (
                  <>
                    {loading ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {Array.from({ length: 12 }).map((_, i) => (
                          <VideoCardSkeleton key={i} />
                        ))}
                      </div>
                    ) : filteredVideos.length === 0 ? (
                      <div className="text-center py-12">
                        <div className="text-5xl mb-4">🎬</div>
                        <h3 className="text-lg font-semibold mb-2">
                          {searchQuery
                            ? "No videos found"
                            : "Your feed is empty"}
                        </h3>
                        <p className="text-muted-foreground">
                          {searchQuery
                            ? "Try adjusting your search"
                            : "Subscribe to channels to populate your feed with fresh videos"}
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {filteredVideos.map((video, index) => (
                          <div
                            key={video.id}
                            ref={(el) => {
                              if (el) {
                                videoRefs.current.set(index, el);
                              } else {
                                videoRefs.current.delete(index);
                              }
                            }}
                            className={`transition-all duration-200 rounded-xl ${
                              highlightedVideoIndex === index
                                ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                                : ""
                            }`}
                          >
                            <VideoCard
                              id={video.id}
                              title={video.title}
                              channel={video.channel}
                              thumbnail={video.thumbnail}
                              durationSeconds={video.durationSeconds}
                              uploadedAt={video.uploadedAt}
                              views={video.views}
                              watched={watchedVideos.has(video.id)}
                              progressPercent={videoProgressPercents.get(
                                video.id
                              )}
                              videoUrl={video.url}
                              showDurationPlaceholder={true}
                              isMemberOnly={video.isMemberOnly}
                              onWatch={() => handleWatchVideo(video.id)}
                              onWatchLater={() => handleAddToWatchLater(video)}
                              onMarkWatched={() =>
                                handleToggleWatched(video.id)
                              }
                              onChannelClick={(channelName) =>
                                setSearchQuery(
                                  searchQuery === channelName ? "" : channelName
                                )
                              }
                              useBuiltInPlayer={
                                settings?.videoPlayerMode !== "new-tab"
                              }
                              onPlayInPlayer={(videoUrl) => {
                                handlePlayInPlayer(
                                  videoUrl,
                                  video.id,
                                  video.title,
                                  video.channel,
                                  video.channelId,
                                  video.thumbnail
                                );
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Watch Later Tab */}
                {feedTab === "watch-later" && (
                  <WatchLater
                    items={watchLater}
                    watchedVideos={watchedVideos}
                    progressPercents={videoProgressPercents}
                    onRemove={handleRemoveFromWatchLater}
                    onPlay={handlePlayWatchLater}
                    onToggleWatched={handleToggleWatched}
                    onThumbnailError={handleWatchLaterThumbnailError}
                    onShare={(videoId) => {
                      const url = `https://www.youtube.com/watch?v=${videoId}`;
                      navigator.clipboard.writeText(url).catch(() => {});
                    }}
                  />
                )}

                {/* Watch History Tab */}
                {feedTab === "watch-history" && (
                  <PlaybackHistory
                    onClose={() => setCurrentPage("home")}
                    watchedVideos={watchedVideos}
                    onToggleWatched={handleToggleWatched}
                    onPlayVideo={(videoId, progress, metadata) => {
                      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
                      handlePlayInPlayer(
                        videoUrl,
                        videoId,
                        metadata?.title || "Video",
                        metadata?.channel || "Unknown channel",
                        metadata?.channelId || undefined,
                        metadata?.thumbnail || undefined,
                        typeof progress === "number" ? progress : undefined
                      );
                    }}
                  />
                )}

                {/* UI simplified — only Videos tab content shown */}
              </>
            )}
          </>
        ) : currentPage === "watch-later" ? (
          <>
            {/* Watch Later Page */}
            <div className="mb-8">
              <button
                onClick={() => setCurrentPage("home")}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors mb-3 flex items-center gap-1 cursor-pointer"
              >
                ← Back to Feed
              </button>
              <h2 className="text-2xl sm:text-3xl font-bold mb-2">
                Watch Later
              </h2>
              <p className="text-sm text-muted-foreground">
                {watchLater.length} video{watchLater.length !== 1 ? "s" : ""}{" "}
                saved
              </p>
            </div>

            <div className="max-w-2xl">
              <WatchLater
                items={watchLater}
                watchedVideos={watchedVideos}
                progressPercents={videoProgressPercents}
                onRemove={handleRemoveFromWatchLater}
                onPlay={handlePlayWatchLater}
                onToggleWatched={handleToggleWatched}
                onThumbnailError={handleWatchLaterThumbnailError}
                onShare={(videoId) => {
                  const url = `https://www.youtube.com/watch?v=${videoId}`;
                  navigator.clipboard.writeText(url).catch(() => {});
                }}
              />
            </div>
          </>
        ) : currentPage === "dashboard" ? (
          <>
            {/* Unified Dashboard */}
            <UnifiedDashboardLayout
              currentSection={currentDashboardSection}
              onSectionChange={setCurrentDashboardSection}
              sections={[
                {
                  id: "profile",
                  label: "Profile Settings",
                  icon: <User className="w-4 h-4" />,
                  description: "Manage your account and preferences",
                  category: "profile",
                },
                {
                  id: "preferences",
                  label: "Preferences",
                  icon: <Settings className="w-4 h-4" />,
                  description: "Customize your experience",
                  category: "preferences",
                },
                ...(user?.isAdmin
                  ? [
                      {
                        id: "admin-oidc",
                        label: "OIDC Provider",
                        icon: <KeyRound className="w-4 h-4" />,
                        description: "Configure authentication",
                        category: "admin" as const,
                      },
                      {
                        id: "admin-users",
                        label: "User Management",
                        icon: <Users className="w-4 h-4" />,
                        description: "Manage users and permissions",
                        category: "admin" as const,
                      },
                      {
                        id: "admin-system",
                        label: "System Settings",
                        icon: <Settings className="w-4 h-4" />,
                        description: "System configuration",
                        category: "admin" as const,
                      },
                    ]
                  : []),
                {
                  id: "danger-zone",
                  label: "Danger Zone",
                  icon: <AlertTriangle className="w-4 h-4" />,
                  description: "Dangerous operations",
                  category: "preferences",
                },
              ]}
            >
              {currentDashboardSection === "profile" && (
                <AccountSettings onShowToast={showToast} />
              )}

              {currentDashboardSection === "preferences" && settings && (
                <div>
                  <SettingsPanel
                    settings={settings}
                    videoRetentionDays={videoRetentionDays}
                    onRetentionChange={handleRetentionChange}
                    watchedThresholdPercent={watchedThresholdPercent}
                    onWatchedThresholdChange={handleWatchedThresholdChange}
                    onSave={handleSaveSettings}
                    onDeleteSubscriptions={handleDeleteAllSubscriptions}
                    onClearWatchHistory={handleClearWatchHistory}
                    onResetSettings={handleResetAllSettings}
                    subscriptionLists={subscriptionLists}
                    currentListId={currentListId}
                    isOpen={true}
                    onClose={() => setCurrentPage("home")}
                  />
                </div>
              )}

              {currentDashboardSection === "admin-oidc" && user?.isAdmin && (
                <AdminOIDC />
              )}
              {currentDashboardSection === "admin-users" && user?.isAdmin && (
                <AdminUsers />
              )}

              {currentDashboardSection === "admin-system" && user?.isAdmin && (
                <AdminSystem />
              )}

              {currentDashboardSection === "danger-zone" && (
                <DangerZonePanel
                  onDeleteSubscriptions={handleDeleteAllSubscriptions}
                  onClearWatchHistory={handleClearWatchHistory}
                  onResetSettings={handleResetAllSettings}
                  onDeleteAccount={handleDeleteAccount}
                  subscriptionLists={subscriptionLists}
                  currentListId={currentListId}
                  onShowToast={showToast}
                />
              )}
            </UnifiedDashboardLayout>
          </>
        ) : null}
      </main>

      {/* Subscription Manager Modal */}
      <SubscriptionManager
        lists={subscriptionLists}
        currentListId={currentListId}
        onSelectList={setCurrentListId}
        onCreateList={async (name: string) => {
          const res = await fetch("/api/subscription-lists", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ action: "create", name }),
          });
          if (!res.ok) throw new Error("Failed to create list");
          const newList = await res.json();

          // Fetch only the updated subscription lists (not videos)
          const listsRes = await fetch("/api/subscription-lists", {
            credentials: "include",
          });
          const listsData = await listsRes.json();

          // Update lists first, then set the IDs
          setSubscriptionLists(listsData.lists);

          // Use setTimeout to ensure state updates happen after lists are set
          setTimeout(() => {
            setCurrentListId(newList.id);
            setFilterListId(newList.id);

            // Persist only the changed field.
            persistUserState({ filterListId: newList.id }).catch((e) =>
              console.error("Failed to persist filter list:", e)
            );
          }, 0);
        }}
        onDeleteList={async (listId: string) => {
          const res = await fetch("/api/subscription-lists", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ action: "delete", listId }),
          });
          if (!res.ok) throw new Error("Failed to delete list");
          await refreshData();
        }}
        onAdd={handleAddSubscription}
        onRemove={handleRemoveSubscription}
        onMove={handleMoveSubscription}
        onImport={handleImportSubscriptions}
        onExport={handleExportSubscriptions}
        isOpen={showSubscriptions}
        onClose={() => setShowSubscriptions(false)}
      />

      {/* Video Player Modal */}
      {showPlayer && playerVideo && (
        <VideoPlayer
          videoId={playerVideo.videoId}
          videoTitle={playerVideo.title}
          channelName={playerVideo.channel}
          channelId={playerVideo.channelId}
          channelThumbnail={
            playerVideo.channelId
              ? subscriptionLists
                  .flatMap((list) => list.subscriptions)
                  .find((sub) => sub.channelId === playerVideo.channelId)
                  ?.thumbnail
              : undefined
          }
          videoUrl={playerVideo.videoUrl}
          onClose={handleClosePlayer}
          onMarkWatched={() => handleWatchVideo(playerVideo.videoId)}
          onChannelClick={(channelName) =>
            setSearchQuery(searchQuery === channelName ? "" : channelName)
          }
          quality={playerQuality}
          defaultResolution={settings?.defaultPlayerResolution ?? "1080p"}
          onQualityChange={(q) => setPlayerQuality(q as typeof playerQuality)}
          watchedThresholdPercent={watchedThresholdPercent}
          watched={watchedVideos.has(playerVideo.videoId)}
          onToggleWatched={() =>
            handleToggleWatched(playerVideo.videoId, { silent: true })
          }
          sponsorBlockEnabled={settings?.sponsorBlockEnabled ?? true}
          onSponsorBlockEnabledChange={(enabled) => {
            setSettings((prev) =>
              prev ? { ...prev, sponsorBlockEnabled: enabled } : prev
            );
            void handleSaveSettings({ sponsorBlockEnabled: enabled });
          }}
          debugOverlayEnabled={settings?.playerDebugEnabled ?? false}
          onDebugOverlayEnabledChange={(enabled) => {
            setSettings((prev) =>
              prev ? { ...prev, playerDebugEnabled: enabled } : prev
            );
            void handleSaveSettings({ playerDebugEnabled: enabled });
          }}
          onDefaultResolutionChange={(res) => {
            setPlayerQuality(res);
            setSettings((prev) =>
              prev ? { ...prev, defaultPlayerResolution: res } : prev
            );
            void handleSaveSettings({ defaultPlayerResolution: res });
          }}
          onProgress={handlePlayerProgress}
          initialProgress={initialProgress}
        />
      )}

      {/* Footer */}
      <footer className="border-t border-border mt-16 bg-card/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-sm text-muted-foreground">
          <p>TubeShelf © 2025 • Licensed under AGPL-3</p>
          <p className="mt-2 text-xs">
            A clean, chronological YouTube feed. No algorithm. No tracking.
          </p>
        </div>
      </footer>

      {/* Scroll to top */}
      {currentPage === "home" && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          title="Back to top"
          aria-label="Back to top"
          className={`fixed bottom-6 right-6 z-50 cursor-pointer rounded-full border border-border/60 bg-card/95 p-3 shadow-lg backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:bg-card ${
            showScrollTop
              ? "opacity-100"
              : "pointer-events-none translate-y-2 opacity-0"
          }`}
        >
          <ClientOnly>
            <ArrowUp className="h-5 w-5 text-foreground" />
          </ClientOnly>
        </button>
      )}

      {/* Welcome Wizard */}
      {showWelcomeWizard && (
        <WelcomeWizard
          onComplete={handleWelcomeWizardComplete}
          onSkip={handleWelcomeWizardSkip}
          onImportFile={handleWelcomeWizardImportFile}
        />
      )}

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onClose={closeToast} />
    </div>
  );
}
