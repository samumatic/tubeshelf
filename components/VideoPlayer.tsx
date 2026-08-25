"use client";

import React, { useState, useEffect, useRef, memo } from "react";
import { createPortal } from "react-dom";
import {
  X,
  ExternalLink,
  Keyboard,
  Settings,
  Loader2,
  ThumbsUp,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  FastForward,
  Rewind,
  Gauge,
  Volume2,
  VolumeX,
  Eye,
  EyeOff,
  Captions,
  CaptionsOff,
} from "lucide-react";
import { getProxiedImageUrl } from "@/lib/videoUtils";

type SponsorBlockSegment = {
  segment: [number, number];
  UUID: string;
  category: string;
  actionType?: string;
  votes?: number;
  locked?: number;
  description?: string;
};

type SponsorSkipNotice = {
  kind: "skipped" | "unskipped";
  uuid: string;
  category: string;
  start: number;
  end: number;
  skippedTo?: number;
};

type SponsorSkipSuppression = {
  uuid: string;
  start: number;
  end: number;
  expiresAtMs: number;
  seenInside: boolean;
};

type SponsorProgrammaticSeek = {
  targetTime: number;
  expiresAtMs: number;
};

type SponsorManualSeekGuard = {
  expiresAtMs: number;
};

type PlayerActionHud =
  | {
      kind: "seek";
      direction: "forward" | "backward";
      totalSeconds: number;
    }
  | {
      kind: "volume";
      muted: boolean;
      percent: number;
    }
  | {
      kind: "speed";
      rate: number;
    }
  | {
      kind: "watched";
      watched: boolean;
    }
  | {
      kind: "captions";
      enabled: boolean;
    };

type PlayerDebugSnapshot = {
  quality: string | null;
  speed: number;
  volumePercent: number;
  muted: boolean;
  currentTime: number;
  duration: number;
  fullscreen: boolean;
  sponsorCategory: string | null;
  sponsorSegmentsCount: number;
};

type PlyrEventName =
  | "play"
  | "pause"
  | "ended"
  | "ready"
  | "timeupdate"
  | "seeking"
  | "ratechange"
  | "volumechange"
  | "qualitychange"
  | "seeked"
  | "enterfullscreen"
  | "exitfullscreen";

type PlyrPlayer = {
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  speed: number;
  quality: number | string;
  embed?: {
    getPlaybackQuality?: () => string;
    getAvailableQualityLevels?: () => string[];
    setPlaybackQuality?: (quality: string) => void;
    setPlaybackQualityRange?: (...qualities: string[]) => void;
    getIframe?: () => HTMLIFrameElement | null;
  };
  fullscreen?: {
    enabled: boolean;
    toggle: () => void;
  };
  elements?: {
    controls: HTMLElement | null;
  };
  togglePlay: (toggle?: boolean) => boolean;
  toggleCaptions: (toggle?: boolean) => void;
  on: (event: PlyrEventName, callback: () => void) => void;
  destroy: () => void;
};

type PlyrConstructor = new (
  target: HTMLElement,
  options?: Record<string, unknown>
) => PlyrPlayer;

const SPONSORBLOCK_API_BASE = "https://sponsor.ajay.app";
const SPONSORBLOCK_AUTO_SKIP_CATEGORIES = ["sponsor"] as const;

const SPONSORBLOCK_CATEGORY_LABELS: Record<string, string> = {
  sponsor: "Sponsor",
};

const SPONSORBLOCK_CATEGORY_COLORS: Record<string, string> = {
  sponsor: "#00d400",
};

const SPONSOR_SKIP_NOTICE_MS = 5000;
const SPONSOR_SKIP_INFO_MS = 5000;
const SPONSOR_SKIP_UNDO_SUPPRESSION_MS = 20_000;
const SPONSOR_SKIP_NOTICE_HOLD_POLL_MS = 500;

const hexToRgba = (hex: string, alpha: number) => {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return hex;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const formatDebugTime = (seconds: number) => {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(
      2,
      "0"
    )}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
};

const formatYouTubeQualityLabel = (quality: string) => {
  const q = quality.trim();
  if (!q) return null;
  const map: Record<string, string> = {
    auto: "Auto",
    default: "Auto",
    highres: "Highres",
    hd2160: "2160p",
    hd1440: "1440p",
    hd1080: "1080p",
    hd720: "720p",
    large: "480p",
    medium: "360p",
    small: "240p",
    tiny: "144p",
  };
  return map[q] || q;
};

const toYouTubeQualityKey = (quality: string) => {
  const normalized = quality.trim().toLowerCase();
  const numeric = Number.parseInt(normalized.replace(/[^0-9]/g, ""), 10);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric >= 2160) return "hd2160";
    if (numeric >= 1440) return "hd1440";
    if (numeric >= 1080) return "hd1080";
    if (numeric >= 720) return "hd720";
    if (numeric >= 480) return "large";
    if (numeric >= 360) return "medium";
    if (numeric >= 240) return "small";
    return "tiny";
  }
  if (normalized === "auto") return "auto";
  return normalized || null;
};

const normalizeYouTubeQualityKey = (quality: string) => quality.trim().toLowerCase();

interface VideoPlayerProps {
  videoId: string;
  videoTitle: string;
  channelName: string;
  channelId?: string;
  channelThumbnail?: string;
  videoUrl: string;
  onClose: () => void;
  onMarkWatched?: () => void;
  onChannelClick?: (channelName: string) => void;
  quality?: "360p" | "480p" | "720p" | "1080p";
  defaultResolution?: "360p" | "480p" | "720p" | "1080p";
  onQualityChange?: (quality: string) => void;
  sponsorBlockEnabled?: boolean;
  onSponsorBlockEnabledChange?: (enabled: boolean) => void | Promise<void>;
  /** Share of the video that must be reached before it counts as watched. */
  watchedThresholdPercent?: number;
  /** Whether this video is currently marked watched, for the header toggle. */
  watched?: boolean;
  /** Flip the watched flag from the header button or the `W` shortcut. */
  onToggleWatched?: () => void;
  debugOverlayEnabled?: boolean;
  onDebugOverlayEnabledChange?: (enabled: boolean) => void | Promise<void>;
  captionsEnabled?: boolean;
  onCaptionsEnabledChange?: (enabled: boolean) => void | Promise<void>;
  onDefaultResolutionChange?: (
    resolution: "360p" | "480p" | "720p" | "1080p"
  ) => void | Promise<void>;
  onProgress?: (progress: number, duration: number) => void;
  initialProgress?: number;
}

interface PlayerComment {
  id: string;
  author: string;
  text: string;
  publishedTime: string;
  likeCountText?: string;
  authorAvatarUrl?: string;
  authorIsCreator?: boolean;
  pinned?: boolean;
  replyCount?: number;
  replyCountText?: string;
  repliesToken?: string;
}

interface ReplyThreadState {
  expanded: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  items: PlayerComment[];
  nextPageToken?: string;
  initialToken?: string;
}

function SettingsToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm text-white">{label}</div>
        <div className="text-[11px] text-gray-400">{description}</div>
      </div>
      <div className="flex items-center gap-1 rounded-md bg-white/5 p-1">
        {([
          { label: "On", value: true },
          { label: "Off", value: false },
        ] as const).map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => onChange(option.value)}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              value === option.value
                ? "bg-white text-black"
                : "text-gray-300 hover:bg-white/10"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const VideoPlayerComponent = ({
  videoId,
  videoTitle,
  channelName,
  channelId,
  channelThumbnail,
  videoUrl,
  onClose,
  onMarkWatched,
  onChannelClick,
  quality = "1080p",
  defaultResolution = "1080p",
  onQualityChange,
  sponsorBlockEnabled = true,
  onSponsorBlockEnabledChange,
  watchedThresholdPercent = 90,
  watched = false,
  onToggleWatched,
  debugOverlayEnabled = false,
  onDebugOverlayEnabledChange,
  captionsEnabled = false,
  onCaptionsEnabledChange,
  onDefaultResolutionChange,
  onProgress,
  initialProgress = 0,
}: VideoPlayerProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoFrameRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlyrPlayer | null>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerReadyRef = useRef(false);
  const componentMountedRef = useRef(true);
  const playerInstanceSeqRef = useRef(0);
  const [playerReady, setPlayerReady] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showPlayerSettingsMenu, setShowPlayerSettingsMenu] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  const playerSettingsMenuRef = useRef<HTMLDivElement>(null);
  const [controlsPortalTarget, setControlsPortalTarget] =
    useState<HTMLDivElement | null>(null);
  const controlsPortalTargetRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [hasRequestedComments, setHasRequestedComments] = useState(false);
  const [commentsSort, setCommentsSort] = useState<"top" | "new">("top");
  const [comments, setComments] = useState<PlayerComment[]>([]);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [nextCommentsToken, setNextCommentsToken] = useState<string | undefined>(
    undefined
  );
  const [commentsDisabled, setCommentsDisabled] = useState(false);
  const [failedAvatarIds, setFailedAvatarIds] = useState<Set<string>>(new Set());
  const [replyThreads, setReplyThreads] = useState<Record<string, ReplyThreadState>>(
    {}
  );
  const commentsRequestIdRef = useRef(0);
  const replyRequestIdRef = useRef<Record<string, number>>({});
  const onMarkWatchedRef = useRef(onMarkWatched);
  const onQualityChangeRef = useRef(onQualityChange);
  const sponsorSegmentsRef = useRef<SponsorBlockSegment[]>([]);
  const lastSponsorSkipRef = useRef<{
    uuid: string;
    category: string;
    start: number;
    end: number;
    skippedTo: number;
    atMs: number;
  } | null>(null);
  const sponsorSkipSuppressionRef = useRef<SponsorSkipSuppression | null>(null);
  const sponsorProgrammaticSeekRef = useRef<SponsorProgrammaticSeek | null>(null);
  const sponsorManualSeekGuardRef = useRef<SponsorManualSeekGuard | null>(null);
  const sponsorNoticeTimerRef = useRef<number | null>(null);
  const sponsorNoticeExpiresAtRef = useRef<number | null>(null);
  const sponsorViewedRef = useRef<Set<string>>(new Set());
  const [sponsorSegments, setSponsorSegments] = useState<SponsorBlockSegment[]>([]);
  const [sponsorSkipNotice, setSponsorSkipNotice] = useState<SponsorSkipNotice | null>(
    null
  );
  const sponsorSkipNoticeRef = useRef<SponsorSkipNotice | null>(null);
  const [sponsorSkipNoticeNowMs, setSponsorSkipNoticeNowMs] = useState(0);
  const [sponsorSeekThumbColor, setSponsorSeekThumbColor] = useState("#ff0000");
  const sponsorSeekThumbColorRef = useRef("#ff0000");
  const sponsorBlockEnabledRef = useRef(sponsorBlockEnabled);
  const debugOverlayEnabledRef = useRef(debugOverlayEnabled);
  const captionsEnabledRef = useRef(captionsEnabled);
  const [playerActionHud, setPlayerActionHud] = useState<PlayerActionHud | null>(
    null
  );
  const playerActionHudTimerRef = useRef<number | null>(null);
  const seekHudAccumRef = useRef<{
    direction: "forward" | "backward";
    totalSeconds: number;
    atMs: number;
  } | null>(null);
  const [playerDebugSnapshot, setPlayerDebugSnapshot] =
    useState<PlayerDebugSnapshot | null>(null);
  const watchedThresholdRef = useRef(watchedThresholdPercent);
  const watchedRef = useRef(watched);
  const autoWatchedFiredRef = useRef(false);
  const onToggleWatchedRef = useRef(onToggleWatched);

  // Extract video ID from YouTube URL
  const getYouTubeVideoId = (url: string) => {
    const match =
      url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/) ||
      url.match(/^([a-zA-Z0-9_-]{11})$/);
    return match ? match[1] : videoId;
  };

  const ytVideoId = getYouTubeVideoId(videoUrl);
  const displayChannelName = channelName?.trim() || "Unknown channel";

  useEffect(() => {
    onMarkWatchedRef.current = onMarkWatched;
  }, [onMarkWatched]);

  useEffect(() => {
    onQualityChangeRef.current = onQualityChange;
  }, [onQualityChange]);

  useEffect(() => {
    playerReadyRef.current = playerReady;
  }, [playerReady]);

  useEffect(() => {
    componentMountedRef.current = true;
    return () => {
      componentMountedRef.current = false;
      playerReadyRef.current = false;
      playerRef.current = null;
    };
  }, []);

  const hasAttachedPlayerIframe = () => {
    const container = playerContainerRef.current;
    if (!container || !container.isConnected) return false;
    const iframe = container.querySelector("iframe");
    return !!iframe && iframe.isConnected;
  };

  const isLivePlayerInstance = (player?: PlyrPlayer | null) => {
    if (!player) return false;
    if (!componentMountedRef.current) return false;
    if (!containerRef.current?.isConnected) return false;
    if (!playerContainerRef.current?.isConnected) return false;
    return playerRef.current === player;
  };

  const canCallPlayerApi = (player?: PlyrPlayer | null) => {
    if (!isLivePlayerInstance(player)) return false;
    if (!playerReadyRef.current) return false;
    return hasAttachedPlayerIframe();
  };

  useEffect(() => {
    watchedThresholdRef.current = watchedThresholdPercent;
  }, [watchedThresholdPercent]);

  useEffect(() => {
    watchedRef.current = watched;
  }, [watched]);

  useEffect(() => {
    onToggleWatchedRef.current = onToggleWatched;
  }, [onToggleWatched]);

  useEffect(() => {
    sponsorSkipNoticeRef.current = sponsorSkipNotice;
  }, [sponsorSkipNotice]);

  useEffect(() => {
    sponsorBlockEnabledRef.current = sponsorBlockEnabled;
  }, [sponsorBlockEnabled]);

  useEffect(() => {
    captionsEnabledRef.current = captionsEnabled;
    // Re-applies whenever the setting changes for any reason (the settings
    // menu toggle, or the initial value on mount) - the player-ready handler
    // covers the case of a brand new video/iframe.
    if (playerReadyRef.current) {
      setYouTubeCaptions(captionsEnabled);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captionsEnabled]);

  useEffect(() => {
    debugOverlayEnabledRef.current = debugOverlayEnabled;
    if (!debugOverlayEnabled) {
      setPlayerDebugSnapshot(null);
      return;
    }
    updatePlayerDebugSnapshot();
  }, [debugOverlayEnabled]);

  useEffect(() => {
    if (!sponsorSkipNotice) return;
    setSponsorSkipNoticeNowMs(Date.now());
    const interval = window.setInterval(() => {
      setSponsorSkipNoticeNowMs(Date.now());
    }, 200);
    return () => window.clearInterval(interval);
  }, [sponsorSkipNotice]);

  useEffect(() => {
    return () => {
      if (sponsorNoticeTimerRef.current) {
        window.clearTimeout(sponsorNoticeTimerRef.current);
        sponsorNoticeTimerRef.current = null;
      }
      sponsorNoticeExpiresAtRef.current = null;
      clearPlayerActionHudTimer();
    };
  }, []);

  useEffect(() => {
    if (!debugOverlayEnabled) return;
    updatePlayerDebugSnapshot();
  }, [debugOverlayEnabled, isFullscreen]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    sponsorSegmentsRef.current = [];
    setSponsorSegments([]);
    lastSponsorSkipRef.current = null;
    sponsorSkipSuppressionRef.current = null;
    sponsorProgrammaticSeekRef.current = null;
    sponsorManualSeekGuardRef.current = null;
    sponsorViewedRef.current = new Set();
    setSponsorSkipNotice(null);
    sponsorSeekThumbColorRef.current = "#ff0000";
    setSponsorSeekThumbColor("#ff0000");
    if (sponsorNoticeTimerRef.current) {
      window.clearTimeout(sponsorNoticeTimerRef.current);
      sponsorNoticeTimerRef.current = null;
    }
    sponsorNoticeExpiresAtRef.current = null;
    if (!sponsorBlockEnabled) {
      syncSponsorSeekThumbColor(Number(playerRef.current?.currentTime || 0));
      updatePlayerDebugSnapshot(playerRef.current);
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const loadSponsorSegments = async () => {
      try {
        const url = new URL("/api/skipSegments", SPONSORBLOCK_API_BASE);
        url.searchParams.set("videoID", ytVideoId);
        url.searchParams.set("service", "YouTube");
        for (const category of SPONSORBLOCK_AUTO_SKIP_CATEGORIES) {
          url.searchParams.append("category", category);
        }

        const res = await fetch(url.toString(), {
          signal: controller.signal,
          mode: "cors",
          cache: "no-store",
        });

        if (res.status === 404) {
          sponsorSegmentsRef.current = [];
          setSponsorSegments([]);
          return;
        }

        if (!res.ok) {
          throw new Error(`SponsorBlock API ${res.status}`);
        }

        const data = (await res.json()) as SponsorBlockSegment[];
        if (cancelled || !Array.isArray(data)) return;

        const normalized = data
          .filter((segment): segment is SponsorBlockSegment => {
            return (
              !!segment &&
              Array.isArray(segment.segment) &&
              segment.segment.length === 2 &&
              typeof segment.segment[0] === "number" &&
              typeof segment.segment[1] === "number" &&
              segment.segment[1] > segment.segment[0] &&
              typeof segment.category === "string" &&
              (!!segment.UUID || segment.UUID === "")
            );
          })
          .filter(
            (segment) =>
              segment.category === "sponsor" &&
              (!segment.actionType || segment.actionType === "skip")
          )
          .sort((a, b) => {
            const startDiff = a.segment[0] - b.segment[0];
            if (startDiff !== 0) return startDiff;
            return a.segment[1] - b.segment[1];
          });

        sponsorSegmentsRef.current = normalized;
        setSponsorSegments(normalized);
        syncSponsorSeekThumbColor(Number(playerRef.current?.currentTime || 0));
        updatePlayerDebugSnapshot(playerRef.current);
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "AbortError" || controller.signal.aborted)
        ) {
          return;
        }
        sponsorSegmentsRef.current = [];
        setSponsorSegments([]);
        syncSponsorSeekThumbColor(Number(playerRef.current?.currentTime || 0));
        updatePlayerDebugSnapshot(playerRef.current);
        console.warn("[VideoPlayer] SponsorBlock unavailable:", err);
      }
    };

    void loadSponsorSegments();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [ytVideoId, sponsorBlockEnabled]);

  const toggleFullscreen = async () => {
    try {
      const player = playerRef.current;

      const fullscreenElement =
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement;

      const container = containerRef.current;
      const fullscreenTarget = videoFrameRef.current || containerRef.current;
      if (!container || !fullscreenTarget) return;

      const isPlayerFullscreen =
        !!fullscreenElement &&
        (fullscreenElement === fullscreenTarget ||
          (fullscreenElement instanceof Node &&
            fullscreenTarget.contains(fullscreenElement)) ||
          (fullscreenElement instanceof Node &&
            fullscreenElement.contains(fullscreenTarget)) ||
          fullscreenElement === container ||
          (fullscreenElement instanceof Node &&
            container.contains(fullscreenElement)));

      if (isPlayerFullscreen) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        } else if ((document as any).mozCancelFullScreen) {
          await (document as any).mozCancelFullScreen();
        } else if ((document as any).msExitFullscreen) {
          await (document as any).msExitFullscreen();
        } else if (player?.fullscreen?.enabled) {
          // Last-resort fallback for environments where Plyr emulates fullscreen.
          player.fullscreen.toggle();
        }
        container.focus();
        return;
      }

      if (fullscreenTarget.requestFullscreen) {
        await fullscreenTarget.requestFullscreen();
      } else if ((fullscreenTarget as any).webkitRequestFullscreen) {
        await (fullscreenTarget as any).webkitRequestFullscreen();
      } else if ((fullscreenTarget as any).mozRequestFullScreen) {
        await (fullscreenTarget as any).mozRequestFullScreen();
      } else if ((fullscreenTarget as any).msRequestFullscreen) {
        await (fullscreenTarget as any).msRequestFullscreen();
      } else if (player?.fullscreen?.enabled) {
        // Fallback only if the native Fullscreen API is unavailable.
        player.fullscreen.toggle();
      }

      // Keep focus on the app player, not the iframe, so shortcuts keep working.
      container.focus();
    } catch (err) {
      console.error("Fullscreen error:", err);
    }
  };

  const seekBy = (seconds: number) => {
    const player = playerRef.current;
    if (!player) return;
    try {
      const nextTime = Math.max(
        0,
        Math.min(player.duration || 0, player.currentTime + seconds)
      );
      player.currentTime = nextTime;
      setCurrentTime(Math.floor(nextTime));
    } catch (err) {
      console.error("Seek error:", err);
    }
  };

  const applyPreferredQuality = (player?: PlyrPlayer | null) => {
    const targetPlayer = player || playerRef.current;
    if (!targetPlayer) return;
    if (!canCallPlayerApi(targetPlayer)) return;

    const parsedQuality = Number.parseInt(
      String(quality).replace(/[^0-9]/g, ""),
      10
    );
    if (!Number.isFinite(parsedQuality) || parsedQuality <= 0) return;

    try {
      targetPlayer.quality = parsedQuality;
    } catch {
      // Ignore unsupported provider quality selections.
    }

    const embed = targetPlayer.embed;
    const requestedKey = toYouTubeQualityKey(String(quality));
    if (!embed || !requestedKey || requestedKey === "auto") return;

    try {
      const availableLevels = embed
        .getAvailableQualityLevels?.()
        ?.map((level) => normalizeYouTubeQualityKey(level))
        .filter(Boolean);
      const availableSet = availableLevels ? new Set(availableLevels) : null;
      const requestedNormalized = normalizeYouTubeQualityKey(requestedKey);

      // If exact match isn't reported yet, still try requesting it; YouTube
      // often populates available levels after initial buffering starts.
      if (!availableSet || availableSet.size === 0 || availableSet.has(requestedNormalized)) {
        try {
          embed.setPlaybackQualityRange?.(requestedKey, requestedKey);
        } catch {
          // Some YT API versions reject the 2-arg range call; try single arg.
          try {
            embed.setPlaybackQualityRange?.(requestedKey);
          } catch {
            // Ignore unsupported method signatures.
          }
        }
        embed.setPlaybackQuality?.(requestedKey);
      } else {
        // Best effort fallback to highest available quality.
        const fallbackOrder = [
          "highres",
          "hd2160",
          "hd1440",
          "hd1080",
          "hd720",
          "large",
          "medium",
          "small",
          "tiny",
        ];
        const fallback = fallbackOrder.find((key) => availableSet.has(key));
        if (fallback) {
          try {
            embed.setPlaybackQualityRange?.(fallback, fallback);
          } catch {
            try {
              embed.setPlaybackQualityRange?.(fallback);
            } catch {
              // Ignore unsupported method signatures.
            }
          }
          embed.setPlaybackQuality?.(fallback);
        }
      }
    } catch {
      // Ignore provider-specific quality API errors.
    }
  };

  const getPlayerFullscreenState = () => {
    const fullscreenElement =
      document.fullscreenElement ||
      (document as any).webkitFullscreenElement ||
      (document as any).mozFullScreenElement ||
      (document as any).msFullscreenElement ||
      null;

    if (!fullscreenElement) return false;

    const frame = videoFrameRef.current;
    const container = containerRef.current;
    if (frame) {
      if (
        fullscreenElement === frame ||
        (fullscreenElement instanceof Node && frame.contains(fullscreenElement)) ||
        (fullscreenElement instanceof Node && fullscreenElement.contains(frame))
      ) {
        return true;
      }
    }
    if (container) {
      if (
        fullscreenElement === container ||
        (fullscreenElement instanceof Node &&
          container.contains(fullscreenElement)) ||
        (fullscreenElement instanceof Node &&
          fullscreenElement.contains(container))
      ) {
        return true;
      }
    }

    return false;
  };

  const findSponsorSegmentAtTime = (time: number, epsilon = 0.15) => {
    if (!sponsorBlockEnabledRef.current) return null;
    if (!Number.isFinite(time)) return null;
    return (
      sponsorSegmentsRef.current.find((segment) => {
        const [start, end] = segment.segment;
        return (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          end > start &&
          time >= start - epsilon &&
          time < end - 0.05
        );
      }) || null
    );
  };

  const updatePlayerDebugSnapshot = (
    player?: PlyrPlayer | null,
    options?: { currentTime?: number; duration?: number }
  ) => {
    if (!debugOverlayEnabledRef.current) return;
    const targetPlayer = player || playerRef.current;
    if (!targetPlayer) return;
    if (player && !isLivePlayerInstance(player)) return;
    if (!player && !canCallPlayerApi(targetPlayer)) return;

    let current = 0;
    let duration = 0;
    let volume = 0;
    let muted = false;
    try {
      current = Number.isFinite(options?.currentTime)
        ? Number(options?.currentTime)
        : Number(targetPlayer.currentTime || 0);
      duration = Number.isFinite(options?.duration)
        ? Number(options?.duration)
        : Number(targetPlayer.duration || 0);
      volume = Math.max(0, Math.min(1, Number(targetPlayer.volume || 0)));
      muted = !!targetPlayer.muted;
    } catch {
      return;
    }
    const activeSegment = findSponsorSegmentAtTime(current, 0.05);
    let qualityFromPlyr: string | null = null;
    try {
      qualityFromPlyr =
        typeof targetPlayer.quality === "number" &&
        Number.isFinite(targetPlayer.quality) &&
        targetPlayer.quality > 0
          ? `${Math.round(targetPlayer.quality)}p`
          : typeof targetPlayer.quality === "string"
            ? formatYouTubeQualityLabel(targetPlayer.quality)
            : null;
    } catch {
      qualityFromPlyr = null;
    }

    let qualityFromYouTubeEmbed: string | null = null;
    if (canCallPlayerApi(targetPlayer)) {
      try {
        qualityFromYouTubeEmbed = formatYouTubeQualityLabel(
          targetPlayer.embed?.getPlaybackQuality?.() || ""
        );
      } catch {
        qualityFromYouTubeEmbed = null;
      }
    }

    setPlayerDebugSnapshot({
      quality: qualityFromPlyr || qualityFromYouTubeEmbed,
      speed:
        typeof targetPlayer.speed === "number" && Number.isFinite(targetPlayer.speed)
          ? targetPlayer.speed
          : 1,
      volumePercent: muted ? 0 : Math.round(volume * 100),
      muted,
      currentTime: Number.isFinite(current) ? current : 0,
      duration: Number.isFinite(duration) ? duration : 0,
      fullscreen: getPlayerFullscreenState(),
      sponsorCategory: activeSegment?.category || null,
      sponsorSegmentsCount: sponsorSegmentsRef.current.length,
    });
  };

  const syncSponsorSeekThumbColor = (time: number) => {
    const activeSegment = sponsorBlockEnabledRef.current
      ? findSponsorSegmentAtTime(time, 0.05)
      : null;
    const nextColor = activeSegment
      ? SPONSORBLOCK_CATEGORY_COLORS[activeSegment.category] || "#22c55e"
      : "#ff0000";
    if (sponsorSeekThumbColorRef.current !== nextColor) {
      sponsorSeekThumbColorRef.current = nextColor;
      setSponsorSeekThumbColor(nextColor);
    }
  };

  const suppressSponsorSegment = (
    segment: SponsorBlockSegment,
    options?: { seenInside?: boolean; durationMs?: number }
  ) => {
    if (!sponsorBlockEnabledRef.current) return;
    const now = Date.now();
    const [start, end] = segment.segment;
    sponsorSkipSuppressionRef.current = {
      uuid: segment.UUID,
      start,
      end,
      expiresAtMs:
        now +
        (options?.durationMs ??
          Math.max(SPONSOR_SKIP_UNDO_SUPPRESSION_MS, (end - start + 6) * 1000)),
      seenInside: options?.seenInside ?? false,
    };
  };

  const markSponsorProgrammaticSeek = (targetTime: number) => {
    sponsorProgrammaticSeekRef.current = {
      targetTime,
      expiresAtMs: Date.now() + 1200,
    };
  };

  const isSponsorProgrammaticSeek = (time: number) => {
    const pending = sponsorProgrammaticSeekRef.current;
    if (!pending) return false;
    if (Date.now() >= pending.expiresAtMs) {
      sponsorProgrammaticSeekRef.current = null;
      return false;
    }
    return Number.isFinite(time) && Math.abs(time - pending.targetTime) < 1.5;
  };

  const armManualSponsorSeekGuard = () => {
    sponsorManualSeekGuardRef.current = {
      expiresAtMs: Date.now() + 2000,
    };
  };

  const hasActiveManualSponsorSeekGuard = () => {
    const guard = sponsorManualSeekGuardRef.current;
    if (!guard) return false;
    if (Date.now() >= guard.expiresAtMs) {
      sponsorManualSeekGuardRef.current = null;
      return false;
    }
    return true;
  };

  const clearPlayerActionHudTimer = () => {
    if (playerActionHudTimerRef.current) {
      window.clearTimeout(playerActionHudTimerRef.current);
      playerActionHudTimerRef.current = null;
    }
  };

  const showPlayerActionHud = (hud: PlayerActionHud, durationMs = 900) => {
    clearPlayerActionHudTimer();
    setPlayerActionHud(hud);
    playerActionHudTimerRef.current = window.setTimeout(() => {
      setPlayerActionHud((current) => {
        if (!current) return null;
        if (current.kind !== hud.kind) return current;
        if (hud.kind === "seek" && current.kind === "seek") {
          return current.direction === hud.direction &&
            current.totalSeconds === hud.totalSeconds
            ? null
            : current;
        }
        if (hud.kind === "volume" && current.kind === "volume") {
          return current.muted === hud.muted && current.percent === hud.percent
            ? null
            : current;
        }
        if (hud.kind === "speed" && current.kind === "speed") {
          return Math.abs(current.rate - hud.rate) < 0.001 ? null : current;
        }
        if (hud.kind === "watched" && current.kind === "watched") {
          return current.watched === hud.watched ? null : current;
        }
        if (hud.kind === "captions" && current.kind === "captions") {
          return current.enabled === hud.enabled ? null : current;
        }
        return current;
      });
      playerActionHudTimerRef.current = null;
    }, durationMs);
  };

  const showSeekActionHud = (seconds: number) => {
    const direction = seconds >= 0 ? "forward" : "backward";
    const absSeconds = Math.abs(seconds);
    const now = Date.now();
    const prev = seekHudAccumRef.current;
    const totalSeconds =
      prev && prev.direction === direction && now - prev.atMs < 900
        ? prev.totalSeconds + absSeconds
        : absSeconds;
    seekHudAccumRef.current = { direction, totalSeconds, atMs: now };
    showPlayerActionHud({ kind: "seek", direction, totalSeconds }, 850);
  };

  const showVolumeActionHud = (player: PlyrPlayer) => {
    const muted = !!player.muted || Number(player.volume || 0) <= 0;
    const percent = muted
      ? 0
      : Math.round(Math.max(0, Math.min(1, Number(player.volume || 0))) * 100);
    showPlayerActionHud({ kind: "volume", muted, percent }, 950);
  };

  const showSpeedActionHud = (player: PlyrPlayer) => {
    const rate = Number(player.speed || 1);
    if (!Number.isFinite(rate)) return;
    showPlayerActionHud({ kind: "speed", rate }, 1000);
  };

  const showCaptionsActionHud = (enabled: boolean) => {
    showPlayerActionHud({ kind: "captions", enabled }, 900);
  };

  /**
   * Plyr's own toggleCaptions()/captions config is built for its native
   * HTML5 <track>-based captions and is a no-op for the YouTube provider -
   * confirmed live, it does nothing here. YouTube's IFrame API has no public
   * JS method for this either; the only thing that actually works is this
   * postMessage command straight to the embed. It's also the only way to
   * override a viewer's own YouTube/Google account "always show captions"
   * preference, which forces captions on regardless of the embed's own
   * cc_load_policy=0 - that's the bug this exists to fix.
   */
  const setYouTubeCaptions = (enabled: boolean, player?: PlyrPlayer | null) => {
    const targetPlayer = player || playerRef.current;
    const iframe = targetPlayer?.embed?.getIframe?.();
    if (!iframe?.contentWindow) return;

    const track = enabled
      ? { languageCode: (navigator.language || "en").split("-")[0] }
      : {};

    try {
      iframe.contentWindow.postMessage(
        JSON.stringify({
          event: "command",
          func: "setOption",
          args: ["captions", "track", track],
        }),
        "*"
      );
    } catch (err) {
      console.error("Error setting YouTube captions:", err);
    }
  };

  const toggleCaptions = () => {
    const nextCaptionsEnabled = !captionsEnabledRef.current;
    setYouTubeCaptions(nextCaptionsEnabled, playerRef.current);
    showCaptionsActionHud(nextCaptionsEnabled);
    void onCaptionsEnabledChange?.(nextCaptionsEnabled);
  };

  const clearSponsorSkipNoticeTimer = () => {
    if (sponsorNoticeTimerRef.current) {
      window.clearTimeout(sponsorNoticeTimerRef.current);
      sponsorNoticeTimerRef.current = null;
    }
    sponsorNoticeExpiresAtRef.current = null;
  };

  const isSponsorSkipNoticeActive = (
    current: SponsorSkipNotice | null,
    expected: SponsorSkipNotice
  ) => {
    return (
      !!current &&
      current.uuid === expected.uuid &&
      current.kind === expected.kind &&
      current.start === expected.start &&
      current.end === expected.end
    );
  };

  const shouldHoldSponsorSkipNotice = (notice: SponsorSkipNotice) => {
    if (notice.kind !== "unskipped") return false;
    const player = playerRef.current;
    if (!player) return false;
    const time = Number(player.currentTime || 0);
    if (!Number.isFinite(time)) return false;
    return time >= notice.start - 0.25 && time <= notice.end + 0.5;
  };

  const showSponsorSkipNoticePopup = (
    notice: SponsorSkipNotice,
    durationMs: number
  ) => {
    clearSponsorSkipNoticeTimer();
    sponsorNoticeExpiresAtRef.current = Date.now() + durationMs;
    setSponsorSkipNoticeNowMs(Date.now());
    setSponsorSkipNotice(notice);
    const scheduleHide = (delayMs: number) => {
      sponsorNoticeExpiresAtRef.current = Date.now() + delayMs;
      sponsorNoticeTimerRef.current = window.setTimeout(() => {
        sponsorNoticeTimerRef.current = null;

        const currentNotice = sponsorSkipNoticeRef.current;
        if (!isSponsorSkipNoticeActive(currentNotice, notice)) {
          sponsorNoticeExpiresAtRef.current = null;
          return;
        }

        if (shouldHoldSponsorSkipNotice(notice)) {
          scheduleHide(SPONSOR_SKIP_NOTICE_HOLD_POLL_MS);
          return;
        }

        setSponsorSkipNotice((current) =>
          isSponsorSkipNoticeActive(current, notice) ? null : current
        );
        sponsorNoticeExpiresAtRef.current = null;
      }, delayMs);
    };

    scheduleHide(durationMs);
  };

  const undoLastSponsorSkip = () => {
    if (!sponsorBlockEnabledRef.current) return false;
    const player = playerRef.current;
    const lastSkip = lastSponsorSkipRef.current;
    const activeNotice = sponsorSkipNoticeRef.current;
    if (!player || !lastSkip) return false;
    if (!activeNotice || activeNotice.kind !== "skipped") return false;
    if (activeNotice.uuid !== lastSkip.uuid) return false;

    const targetTime = Math.max(0, lastSkip.start + 0.01);
    suppressSponsorSegment(
      {
        UUID: lastSkip.uuid,
        category: lastSkip.category,
        segment: [lastSkip.start, lastSkip.end],
      },
      { seenInside: false, durationMs: SPONSOR_SKIP_UNDO_SUPPRESSION_MS }
    );

    try {
      markSponsorProgrammaticSeek(targetTime);
      player.currentTime = targetTime;
      setCurrentTime(Math.floor(targetTime));
      syncSponsorSeekThumbColor(targetTime);
      showSponsorSkipNoticePopup(
        {
          kind: "unskipped",
          uuid: lastSkip.uuid,
          category: lastSkip.category,
          start: lastSkip.start,
          end: lastSkip.end,
          skippedTo: lastSkip.skippedTo,
        },
        SPONSOR_SKIP_INFO_MS
      );
      containerRef.current?.focus();
      return true;
    } catch (err) {
      console.error("SponsorBlock unskip error:", err);
      return false;
    }
  };

  const reskipLastSponsorSegment = () => {
    if (!sponsorBlockEnabledRef.current) return false;
    const player = playerRef.current;
    const lastSkip = lastSponsorSkipRef.current;
    const activeNotice = sponsorSkipNoticeRef.current;
    if (!player || !lastSkip) return false;
    if (!activeNotice || activeNotice.kind !== "unskipped") return false;
    if (activeNotice.uuid !== lastSkip.uuid) return false;

    const targetTime = Number.isFinite(lastSkip.skippedTo)
      ? Math.max(0, lastSkip.skippedTo)
      : Math.max(0, lastSkip.end + 0.05);

    sponsorSkipSuppressionRef.current = null;

    try {
      markSponsorProgrammaticSeek(targetTime);
      player.currentTime = targetTime;
      setCurrentTime(Math.floor(targetTime));
      syncSponsorSeekThumbColor(targetTime);
      lastSponsorSkipRef.current = {
        ...lastSkip,
        skippedTo: targetTime,
        atMs: Date.now(),
      };
      showSponsorSkipNoticePopup(
        {
          kind: "skipped",
          uuid: lastSkip.uuid,
          category: lastSkip.category,
          start: lastSkip.start,
          end: lastSkip.end,
          skippedTo: targetTime,
        },
        SPONSOR_SKIP_NOTICE_MS
      );
      containerRef.current?.focus();
      return true;
    } catch (err) {
      console.error("SponsorBlock reskip error:", err);
      return false;
    }
  };

  const triggerSponsorSkipNoticePrimaryAction = () => {
    if (!sponsorBlockEnabledRef.current) return false;
    const notice = sponsorSkipNoticeRef.current;
    if (!notice) return false;
    if (notice.kind === "skipped") {
      return undoLastSponsorSkip();
    }
    if (notice.kind === "unskipped") {
      return reskipLastSponsorSegment();
    }
    return false;
  };

  const reportSponsorSegmentViewed = async (uuid: string) => {
    if (!sponsorBlockEnabledRef.current) return;
    if (!uuid || sponsorViewedRef.current.has(uuid)) return;
    sponsorViewedRef.current.add(uuid);
    try {
      await fetch(
        `${SPONSORBLOCK_API_BASE}/api/viewedVideoSponsorTime?UUID=${encodeURIComponent(
          uuid
        )}`,
        {
          method: "POST",
          mode: "cors",
          keepalive: true,
        }
      );
    } catch {
      // Non-critical telemetry ping for SponsorBlock statistics.
    }
  };

  const maybeAutoSkipSponsorSegment = (
    player: PlyrPlayer,
    currentTimeOverride?: number
  ) => {
    if (!sponsorBlockEnabledRef.current) return;
    const segments = sponsorSegmentsRef.current;
    if (!segments.length) return;

    const currentTime =
      typeof currentTimeOverride === "number" && Number.isFinite(currentTimeOverride)
        ? currentTimeOverride
        : Number(player.currentTime || 0);
    if (!Number.isFinite(currentTime)) return;

    const suppressed = sponsorSkipSuppressionRef.current;
    if (suppressed) {
      if (Date.now() >= suppressed.expiresAtMs) {
        sponsorSkipSuppressionRef.current = null;
      } else {
        const inSuppressedWindow =
          currentTime >= suppressed.start - 0.5 &&
          currentTime <= suppressed.end + 0.5;

        if (inSuppressedWindow) {
          if (!suppressed.seenInside) {
            sponsorSkipSuppressionRef.current = {
              ...suppressed,
              seenInside: true,
            };
          }
        } else if (suppressed.seenInside) {
          // Clear once the user has actually moved away after entering the segment.
          const movedPastSegment = currentTime > suppressed.end + 0.5;
          const movedBeforeSegment = currentTime < suppressed.start - 2;
          if (movedPastSegment || movedBeforeSegment) {
            sponsorSkipSuppressionRef.current = null;
          }
        }
      }
    }

    const activeSegment = segments.find((segment) => {
      const [start, end] = segment.segment;
      return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end > start &&
        currentTime >= start - 0.15 &&
        currentTime < end - 0.1
      );
    });

    if (!activeSegment) return;

    const activeSuppression = sponsorSkipSuppressionRef.current;
    if (
      activeSuppression &&
      activeSuppression.uuid === activeSegment.UUID &&
      Date.now() < activeSuppression.expiresAtMs
    ) {
      return;
    }

    const [start, end] = activeSegment.segment;
    const targetTime = Math.min(
      Number.isFinite(player.duration) && player.duration > 0
        ? player.duration
        : end + 0.05,
      end + 0.05
    );

    if (!Number.isFinite(targetTime) || targetTime <= currentTime + 0.05) {
      return;
    }

    const lastSkip = lastSponsorSkipRef.current;
    if (
      lastSkip &&
      lastSkip.uuid === activeSegment.UUID &&
      Math.abs(lastSkip.skippedTo - targetTime) < 0.2 &&
      Date.now() - lastSkip.atMs < 2000
    ) {
      return;
    }

    try {
      markSponsorProgrammaticSeek(targetTime);
      player.currentTime = targetTime;
      setCurrentTime(Math.floor(targetTime));
      syncSponsorSeekThumbColor(targetTime);
      lastSponsorSkipRef.current = {
        uuid: activeSegment.UUID,
        category: activeSegment.category,
        start,
        end,
        skippedTo: targetTime,
        atMs: Date.now(),
      };
      sponsorSkipSuppressionRef.current = null;
      showSponsorSkipNoticePopup(
        {
          kind: "skipped",
          uuid: activeSegment.UUID,
          category: activeSegment.category,
          start,
          end,
          skippedTo: targetTime,
        },
        SPONSOR_SKIP_NOTICE_MS
      );
      void reportSponsorSegmentViewed(activeSegment.UUID);
    } catch (err) {
      console.error("SponsorBlock skip error:", err);
    }
  };

  useEffect(() => {
    // Reset comments state when switching videos.
    setShowComments(false);
    setHasRequestedComments(false);
    setCommentsSort("top");
    setComments([]);
    setCommentsError(null);
    setCommentsLoading(false);
    setLoadingMoreComments(false);
    setNextCommentsToken(undefined);
    setCommentsDisabled(false);
    setFailedAvatarIds(new Set());
    setReplyThreads({});
    commentsRequestIdRef.current += 1;
    replyRequestIdRef.current = {};
    autoWatchedFiredRef.current = false;
  }, [ytVideoId]);

  /**
   * Mark watched once playback passes the threshold.
   *
   * Same position test as auto-like: seeking past the mark counts, and a live
   * stream (duration 0 or unknown) never qualifies.
   */
  const maybeMarkWatched = (time: number, duration: number) => {
    if (autoWatchedFiredRef.current) return;
    if (watchedRef.current) return;
    if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const percent = (time / duration) * 100;
    if (percent < watchedThresholdRef.current) return;

    autoWatchedFiredRef.current = true;
    onMarkWatchedRef.current?.();
    showPlayerActionHud({ kind: "watched", watched: true }, 2600);
  };

  const handleToggleWatched = () => {
    const next = !watchedRef.current;
    // A hand toggle settles it; the threshold must not undo the user's choice.
    autoWatchedFiredRef.current = true;
    watchedRef.current = next;
    onToggleWatchedRef.current?.();
    showPlayerActionHud({ kind: "watched", watched: next }, 1200);
  };

  /**
   * Handing off to youtube.com ends our ability to follow the position, so the
   * video counts as watched right away.
   */
  const handleOpenOnYouTube = () => {
    if (!watchedRef.current) {
      autoWatchedFiredRef.current = true;
      watchedRef.current = true;
      onMarkWatchedRef.current?.();
    }
  };

  const loadCommentsPage = async (options?: {
    append?: boolean;
    pageToken?: string;
    sortOverride?: "top" | "new";
  }) => {
    const append = !!options?.append;
    const pageToken = options?.pageToken;
    const sortToUse = options?.sortOverride || commentsSort;
    const requestId = ++commentsRequestIdRef.current;

    if (append) {
      setLoadingMoreComments(true);
    } else {
      setCommentsLoading(true);
    }
    setCommentsError(null);

    try {
      const params = new URLSearchParams({
        videoId: ytVideoId,
        sort: sortToUse,
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const res = await fetch(`/api/video-comments?${params.toString()}`, {
        credentials: "include",
      });

      if (!res.ok) {
        throw new Error("Failed to load comments");
      }

      const data = await res.json();
      if (requestId !== commentsRequestIdRef.current) {
        return;
      }

      const incomingComments: PlayerComment[] = Array.isArray(data.comments)
        ? data.comments
            .filter((comment: any) => comment && typeof comment.id === "string")
            .map((comment: any) => ({
              id: comment.id,
              author:
                typeof comment.author === "string" && comment.author.length > 0
                  ? comment.author
                  : "Unknown",
              text:
                typeof comment.text === "string" ? comment.text : String(comment.text || ""),
              publishedTime:
                typeof comment.publishedTime === "string" ? comment.publishedTime : "",
              likeCountText:
                typeof comment.likeCountText === "string"
                  ? comment.likeCountText
                  : undefined,
              authorAvatarUrl:
                typeof comment.authorAvatarUrl === "string"
                  ? comment.authorAvatarUrl
                  : undefined,
              authorIsCreator: !!comment.authorIsCreator,
              pinned: !!comment.pinned,
            }))
        : [];

      if (append) {
        setComments((prev) => {
          const merged = [...prev, ...incomingComments];
          const seen = new Set<string>();
          return merged.filter((comment) => {
            if (seen.has(comment.id)) return false;
            seen.add(comment.id);
            return true;
          });
        });
      } else {
        setComments(incomingComments);
      }

      setCommentsDisabled(!!data.disabled);
      setNextCommentsToken(
        typeof data.nextPageToken === "string" && data.nextPageToken.length > 0
          ? data.nextPageToken
          : undefined
      );
    } catch (error) {
      if (requestId !== commentsRequestIdRef.current) {
        return;
      }
      setCommentsError("Could not load comments right now.");
      if (!append) {
        setComments([]);
        setNextCommentsToken(undefined);
      }
    } finally {
      if (requestId === commentsRequestIdRef.current) {
        setCommentsLoading(false);
        setLoadingMoreComments(false);
      }
    }
  };

  const loadReplies = async (
    parentCommentId: string,
    token: string,
    append = false
  ) => {
    const requestId = (replyRequestIdRef.current[parentCommentId] || 0) + 1;
    replyRequestIdRef.current[parentCommentId] = requestId;

    setReplyThreads((prev) => {
      const current = prev[parentCommentId];
      return {
        ...prev,
        [parentCommentId]: {
          expanded: true,
          loading: append ? current?.loading || false : true,
          loadingMore: append ? true : false,
          error: null,
          items: current?.items || [],
          nextPageToken: current?.nextPageToken,
          initialToken: current?.initialToken || token,
        },
      };
    });

    try {
      const params = new URLSearchParams({
        videoId: ytVideoId,
        pageToken: token,
      });

      const res = await fetch(`/api/video-comments?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error("Failed to load replies");
      }

      const data = await res.json();
      if (replyRequestIdRef.current[parentCommentId] !== requestId) {
        return;
      }

      const incomingReplies: PlayerComment[] = Array.isArray(data.comments)
        ? data.comments
            .filter((comment: any) => comment && typeof comment.id === "string")
            .map((comment: any) => ({
              id: comment.id,
              author:
                typeof comment.author === "string" && comment.author.length > 0
                  ? comment.author
                  : "Unknown",
              text:
                typeof comment.text === "string"
                  ? comment.text
                  : String(comment.text || ""),
              publishedTime:
                typeof comment.publishedTime === "string"
                  ? comment.publishedTime
                  : "",
              likeCountText:
                typeof comment.likeCountText === "string"
                  ? comment.likeCountText
                  : undefined,
              authorAvatarUrl:
                typeof comment.authorAvatarUrl === "string"
                  ? comment.authorAvatarUrl
                  : undefined,
              authorIsCreator: !!comment.authorIsCreator,
              pinned: !!comment.pinned,
            }))
        : [];

      setReplyThreads((prev) => {
        const current = prev[parentCommentId];
        const merged = append
          ? [...(current?.items || []), ...incomingReplies]
          : incomingReplies;
        const seen = new Set<string>();
        const deduped = merged.filter((reply) => {
          if (seen.has(reply.id)) return false;
          seen.add(reply.id);
          return true;
        });

        return {
          ...prev,
          [parentCommentId]: {
            expanded: true,
            loading: false,
            loadingMore: false,
            error: null,
            items: deduped,
            nextPageToken:
              typeof data.nextPageToken === "string" && data.nextPageToken.length > 0
                ? data.nextPageToken
                : undefined,
            initialToken: current?.initialToken || token,
          },
        };
      });
    } catch {
      if (replyRequestIdRef.current[parentCommentId] !== requestId) {
        return;
      }
      setReplyThreads((prev) => {
        const current = prev[parentCommentId];
        return {
          ...prev,
          [parentCommentId]: {
            expanded: true,
            loading: false,
            loadingMore: false,
            error: "Could not load replies.",
            items: current?.items || [],
            nextPageToken: current?.nextPageToken,
            initialToken: current?.initialToken || token,
          },
        };
      });
    }
  };

  const openComments = () => {
    setShowComments(true);
    if (!hasRequestedComments || (commentsError && comments.length === 0)) {
      setHasRequestedComments(true);
      loadCommentsPage({ sortOverride: commentsSort });
    }
  };

  // Prevent background page scrolling while player modal is open.
  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let localPlayer: PlyrPlayer | null = null;
    const playerInstanceSeq = ++playerInstanceSeqRef.current;

    const isLocalPlayerLive = () =>
      !disposed &&
      componentMountedRef.current &&
      playerInstanceSeqRef.current === playerInstanceSeq &&
      !!localPlayer &&
      playerRef.current === localPlayer &&
      playerReadyRef.current &&
      hasAttachedPlayerIframe();

    const mountPlyr = async () => {
      if (!playerContainerRef.current) return;

      setPlayerReady(false);
      setCurrentTime(0);

      const startSeconds = initialProgress > 0 ? Math.floor(initialProgress) : 0;
      const origin = encodeURIComponent(window.location.origin);
      playerContainerRef.current.innerHTML = `
        <div class="plyr__video-embed w-full h-full">
          <iframe
            src="https://www.youtube.com/embed/${ytVideoId}?origin=${origin}&iv_load_policy=3&modestbranding=1&playsinline=1&rel=0&enablejsapi=1&start=${startSeconds}"
            allowfullscreen
            allow="autoplay; fullscreen"
            referrerpolicy="strict-origin-when-cross-origin"
            title="YouTube video player"
          ></iframe>
        </div>
      `;

      const target = playerContainerRef.current.querySelector(
        ".plyr__video-embed"
      ) as HTMLElement | null;
      if (!target) return;

      const plyrModule = (await import("plyr")) as unknown as
        | PlyrConstructor
        | { default?: PlyrConstructor };
      if (disposed) return;
      const PlyrLib =
        (typeof plyrModule === "function"
          ? plyrModule
          : plyrModule.default) ?? null;
      if (!PlyrLib) {
        throw new Error("Plyr constructor not found");
      }

      localPlayer = new PlyrLib(target, {
        autoplay: true,
        clickToPlay: true,
        keyboard: { focused: false, global: false },
        seekTime: 10,
        tooltips: { controls: true, seek: true },
        fullscreen: { enabled: true, fallback: true, iosNative: true },
        // Plyr's own "captions" button is a no-op for the YouTube provider
        // (see toggleCaptions below), and "settings" only offers Plyr's
        // fixed quality/speed submenu with no way to add our own options -
        // both are dropped here in favor of our own controls, portaled
        // directly into Plyr's control bar (elements.controls) once ready.
        controls: [
          "play-large",
          "play",
          "progress",
          "current-time",
          "mute",
          "volume",
          "pip",
          "airplay",
          "fullscreen",
        ],
        youtube: {
          rel: 0,
          iv_load_policy: 3,
          modestbranding: 1,
          noCookie: true,
        },
      });

      localPlayer.on("ready", () => {
        if (disposed) return;
        playerRef.current = localPlayer;
        playerReadyRef.current = true;
        setPlayerReady(true);

        // Insert a marker for our own controls (captions + settings) into
        // Plyr's real control bar, in the same slot the native captions/
        // settings buttons would have occupied (just before pip/airplay/
        // fullscreen). Being a real child of elements.controls means Plyr's
        // own mouseenter/focusin/idle-timer logic - which it binds directly
        // to that element - picks our buttons up automatically, with no
        // custom show/hide syncing needed on our side.
        const controlsEl = localPlayer?.elements?.controls;
        if (controlsEl && !controlsEl.contains(controlsPortalTargetRef.current)) {
          const marker = document.createElement("div");
          marker.className = "plyr__controls__item flex items-center gap-1";
          const anchor =
            controlsEl.querySelector('[data-plyr="pip"]') ||
            controlsEl.querySelector('[data-plyr="airplay"]') ||
            controlsEl.querySelector('[data-plyr="fullscreen"]');
          if (anchor?.parentElement) {
            anchor.parentElement.insertBefore(marker, anchor);
          } else {
            controlsEl.appendChild(marker);
          }
          controlsPortalTargetRef.current = marker;
          setControlsPortalTarget(marker);
        }

        // Enforces the captions setting for this video. This is the actual
        // fix for captions getting stuck on: the embed's own cc_load_policy=0
        // doesn't override a viewer's "always show captions" YouTube/Google
        // account preference, so without this, some viewers get captions
        // forced on for every video with no in-player way to turn them off.
        // YouTube's captions module isn't always ready the instant "ready"
        // fires, so this also retries once shortly after.
        setYouTubeCaptions(captionsEnabledRef.current, localPlayer);
        window.setTimeout(() => {
          if (disposed) return;
          setYouTubeCaptions(captionsEnabledRef.current, localPlayer);
        }, 750);
        if (
          localPlayer &&
          Number.isFinite(localPlayer.duration) &&
          localPlayer.duration > 0
        ) {
          setPlayerDuration(Math.floor(localPlayer.duration));
        }
        if (startSeconds > 0) {
          try {
            localPlayer!.currentTime = startSeconds;
          } catch {
            // Ignore seek failures during early provider init.
          }
        }
        containerRef.current?.focus();
        updatePlayerDebugSnapshot(localPlayer);
      });

      localPlayer.on("timeupdate", () => {
        if (!isLocalPlayerLive()) return;
        const time = Number(localPlayer?.currentTime || 0);
        const duration = Number(localPlayer?.duration || 0);
        if (Number.isFinite(time)) {
          setCurrentTime(Math.floor(time));
          syncSponsorSeekThumbColor(time);
          const manualGuardActive = hasActiveManualSponsorSeekGuard();
          const manuallyEnteredSegment = manualGuardActive
            ? findSponsorSegmentAtTime(time, 0.25)
            : null;
          if (manuallyEnteredSegment) {
            suppressSponsorSegment(manuallyEnteredSegment, {
              seenInside: true,
              durationMs: Math.max(
                SPONSOR_SKIP_UNDO_SUPPRESSION_MS,
                (manuallyEnteredSegment.segment[1] - time + 6) * 1000
              ),
            });
          } else if (localPlayer) {
            maybeAutoSkipSponsorSegment(localPlayer, time);
          }
        }
        if (Number.isFinite(duration) && duration > 0) {
          setPlayerDuration(Math.floor(duration));
        }
        maybeMarkWatched(time, duration);
        updatePlayerDebugSnapshot(localPlayer, { currentTime: time, duration });
      });

      // Closing the tab right at the end can beat the last timeupdate, and a
      // video shorter than the threshold gap never reports a position past it.
      localPlayer.on("ended", () => {
        if (!isLocalPlayerLive()) return;
        const duration = Number(localPlayer?.duration || 0);
        maybeMarkWatched(duration, duration);
      });

      localPlayer.on("seeking", () => {
        if (!isLocalPlayerLive()) return;
        const time = Number(localPlayer.currentTime || 0);
        if (!isSponsorProgrammaticSeek(time)) {
          armManualSponsorSeekGuard();
        }
      });

      localPlayer.on("seeked", () => {
        if (!isLocalPlayerLive()) return;
        const time = Number(localPlayer.currentTime || 0);
        const duration = Number(localPlayer.duration || 0);
        if (Number.isFinite(time)) {
          syncSponsorSeekThumbColor(time);
        }

        const sponsorProgrammatic = isSponsorProgrammaticSeek(time);
        if (sponsorProgrammatic) {
          sponsorProgrammaticSeekRef.current = null;
          sponsorManualSeekGuardRef.current = null;
          maybeAutoSkipSponsorSegment(localPlayer, time);
        } else {
          sponsorProgrammaticSeekRef.current = null;
          const manuallyEnteredSegment =
            Number.isFinite(time) ? findSponsorSegmentAtTime(time, 0.25) : null;
          if (manuallyEnteredSegment) {
            suppressSponsorSegment(manuallyEnteredSegment, {
              seenInside: true,
              durationMs: Math.max(
                SPONSOR_SKIP_UNDO_SUPPRESSION_MS,
                (manuallyEnteredSegment.segment[1] - time + 6) * 1000
              ),
            });
          } else {
            maybeAutoSkipSponsorSegment(localPlayer, time);
          }
          sponsorManualSeekGuardRef.current = null;
        }
        updatePlayerDebugSnapshot(localPlayer, { currentTime: time, duration });
      });

      localPlayer.on("qualitychange", () => {
        if (!isLocalPlayerLive()) return;
        const q = localPlayer.quality;
        if (
          onQualityChangeRef.current &&
          typeof q === "number" &&
          Number.isFinite(q) &&
          q > 0
        ) {
          onQualityChangeRef.current(`${q}p`);
        }
        updatePlayerDebugSnapshot(localPlayer);
      });

      localPlayer.on("ratechange", () => {
        if (!isLocalPlayerLive()) return;
        showSpeedActionHud(localPlayer);
        updatePlayerDebugSnapshot(localPlayer);
      });

      localPlayer.on("volumechange", () => {
        if (!isLocalPlayerLive()) return;
        updatePlayerDebugSnapshot(localPlayer);
      });

      localPlayer.on("enterfullscreen", () => {
        if (disposed) return;
        setIsFullscreen(true);
        updatePlayerDebugSnapshot(localPlayer);
      });
      localPlayer.on("exitfullscreen", () => {
        if (disposed) return;
        setIsFullscreen(false);
        updatePlayerDebugSnapshot(localPlayer);
      });
    };

    mountPlyr().catch((err) => {
      if (!disposed) {
        console.error("Failed to initialize Plyr:", err);
      }
    });

    return () => {
      disposed = true;
      setPlayerReady(false);
      playerReadyRef.current = false;
      setPlayerDuration(0);
      controlsPortalTargetRef.current = null;
      setControlsPortalTarget(null);
      const player = localPlayer || playerRef.current;
      if (playerRef.current === player) {
        playerRef.current = null;
      }
      if (player) {
        const canSafelyDestroy =
          !!playerContainerRef.current?.isConnected &&
          !!playerContainerRef.current?.querySelector("iframe")?.isConnected;
        if (canSafelyDestroy) {
          try {
            player.destroy();
          } catch (err) {
            console.warn("Failed to destroy Plyr instance:", err);
          }
        }
      }
      if (playerContainerRef.current) {
        playerContainerRef.current.innerHTML = "";
      }
    };
  }, [ytVideoId, initialProgress]);

  useEffect(() => {
    if (!playerReady || !playerRef.current) return;
    const player = playerRef.current;
    applyPreferredQuality(player);
    const retryDelays = [250, 1000, 2500];
    const timers = retryDelays.map((delay) =>
      window.setTimeout(() => {
        if (playerRef.current !== player) return;
        applyPreferredQuality(player);
        updatePlayerDebugSnapshot(player);
      }, delay)
    );
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [playerReady, quality, ytVideoId]);

  useEffect(() => {
    if (!playerReady || !playerRef.current) return;
    const timer = window.setTimeout(() => {
      if (!playerRef.current) return;
      applyPreferredQuality(playerRef.current);
      updatePlayerDebugSnapshot(playerRef.current);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [isFullscreen, playerReady, quality]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const syncMarkers = () => {
      const progress = root.querySelector(".plyr__progress") as HTMLElement | null;
      if (!progress) return;
      const rangeInput = progress.querySelector(
        'input[type="range"]'
      ) as HTMLElement | null;
      const progressRect = progress.getBoundingClientRect();
      const rangeRect = rangeInput?.getBoundingClientRect();
      const trackHeightPx = Math.max(
        2,
        Number.parseFloat(
          getComputedStyle(progress).getPropertyValue("--plyr-range-track-height")
        ) || 5
      );

      let layer = progress.querySelector(
        ".tubeshelf-sponsorblock-markers"
      ) as HTMLDivElement | null;

      if (!layer) {
        layer = document.createElement("div");
        layer.className = "tubeshelf-sponsorblock-markers";
        layer.setAttribute("aria-hidden", "true");
        Object.assign(layer.style, {
          position: "absolute",
          left: "0",
          width: "100%",
          top: "50%",
          bottom: "auto",
          height: "var(--plyr-range-track-height, 6px)",
          transform: "translateY(-50%)",
          pointerEvents: "none",
          zIndex: "3",
          borderRadius: "2px",
          overflow: "hidden",
        } as CSSStyleDeclaration);

        if (getComputedStyle(progress).position === "static") {
          progress.style.position = "relative";
        }
        progress.appendChild(layer);
      }

      if (rangeRect && progressRect.width > 0) {
        const leftPx = Math.max(0, rangeRect.left - progressRect.left);
        const topPx =
          rangeRect.top -
          progressRect.top +
          rangeRect.height / 2 -
          trackHeightPx / 2;
        layer.style.left = `${leftPx}px`;
        layer.style.width = `${Math.max(0, rangeRect.width)}px`;
        layer.style.top = `${Math.max(0, topPx)}px`;
        layer.style.height = `${trackHeightPx}px`;
        layer.style.transform = "none";
      } else {
        layer.style.left = "0";
        layer.style.width = "100%";
        layer.style.top = "50%";
        layer.style.height = "var(--plyr-range-track-height, 6px)";
        layer.style.transform = "translateY(-50%)";
      }

      layer.replaceChildren();

      if (
        !sponsorBlockEnabled ||
        !playerReady ||
        playerDuration <= 0 ||
        sponsorSegments.length === 0
      ) {
        layer.style.display = "none";
        return;
      }

      layer.style.display = "block";

      const mergedSegments = sponsorSegments
        .filter((segment) => {
          const [start, end] = segment.segment;
          return start < playerDuration && end > 0 && end > start;
        })
        .map((segment) => ({
          ...segment,
          segment: [
            Math.max(0, segment.segment[0]),
            Math.min(playerDuration, segment.segment[1]),
          ] as [number, number],
        }))
        .sort((a, b) => {
          const startDiff = a.segment[0] - b.segment[0];
          if (startDiff !== 0) return startDiff;
          return a.segment[1] - b.segment[1];
        });

      for (const segment of mergedSegments) {
        const [start, end] = segment.segment;
        const leftPct = (start / playerDuration) * 100;
        const widthPct = Math.max(((end - start) / playerDuration) * 100, 0.2);
        const marker = document.createElement("span");
        marker.className = "tubeshelf-sponsorblock-marker";
        marker.title = `${SPONSORBLOCK_CATEGORY_LABELS[segment.category] || segment.category} (${start.toFixed(0)}s-${end.toFixed(0)}s)`;
        Object.assign(marker.style, {
          position: "absolute",
          left: `${leftPct}%`,
          width: `${widthPct}%`,
          top: "0",
          bottom: "0",
          background:
            SPONSORBLOCK_CATEGORY_COLORS[segment.category] ||
            "#ffffff",
          opacity: "0.9",
          borderRadius: "0",
        } as CSSStyleDeclaration);
        layer.appendChild(marker);
      }
    };

    const raf = window.requestAnimationFrame(syncMarkers);
    return () => window.cancelAnimationFrame(raf);
  }, [playerReady, playerDuration, sponsorSegments, sponsorBlockEnabled, ytVideoId]);

  // Track playback progress and report to parent
  useEffect(() => {
    if (!playerReady || !playerRef.current) return;

    const interval = setInterval(() => {
      try {
        const player = playerRef.current;
        if (player) {
          const time = player.currentTime;
          const duration = player.duration;
          if (duration > 0) {
            onProgress?.(time, duration);
          }
        }
      } catch (err) {
        // Player might not be ready yet
      }
    }, 3000); // Report every 3 seconds (was 5 seconds)

    return () => clearInterval(interval);
  }, [playerReady, onProgress]);

  const youtubeUrlWithTimestamp = (() => {
    try {
      const url = new URL(videoUrl);
      if (currentTime > 0) {
        url.searchParams.set("t", `${currentTime}`);
      } else {
        url.searchParams.delete("t");
      }
      return url.toString();
    } catch {
      return videoUrl;
    }
  })();

  const sponsorNoticeRemainingMs =
    sponsorSkipNotice && sponsorNoticeExpiresAtRef.current
      ? Math.max(0, sponsorNoticeExpiresAtRef.current - sponsorSkipNoticeNowMs)
      : 0;
  const sponsorNoticeHeldByUnskippedSegment =
    !!sponsorSkipNotice &&
    sponsorSkipNotice.kind === "unskipped" &&
    Number.isFinite(currentTime) &&
    currentTime >= sponsorSkipNotice.start - 1 &&
    currentTime <= sponsorSkipNotice.end + 1;
  const sponsorNoticeHideCountdown = sponsorNoticeHeldByUnskippedSegment;
  const sponsorNoticeCountdownSeconds =
    sponsorSkipNotice && sponsorNoticeRemainingMs > 0 && !sponsorNoticeHideCountdown
      ? Math.max(1, Math.ceil(sponsorNoticeRemainingMs / 1000))
      : null;
  const sponsorNoticeActionLabel =
    sponsorSkipNotice?.kind === "skipped"
      ? "Unskip (Enter)"
      : sponsorSkipNotice?.kind === "unskipped"
        ? "Reskip (Enter)"
        : null;

  // Playback shortcuts - handled at the app level so they still work outside iframe focus.
  useEffect(() => {
    if (!playerReady || !playerRef.current) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't interfere with text entry fields, but allow shortcuts from range sliders.
      if (e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.target instanceof HTMLSelectElement) {
        return;
      }
      if (e.target instanceof HTMLInputElement) {
        const inputType = (e.target.type || "").toLowerCase();
        if (inputType !== "range") {
          return;
        }
      }
      if (
        e.target instanceof HTMLElement &&
        e.target.isContentEditable
      ) {
        return;
      }

      const player = playerRef.current;
      if (!player) return;

      try {
        switch (e.key.toLowerCase()) {
          case "enter":
            if (triggerSponsorSkipNoticePrimaryAction()) {
              e.preventDefault();
            }
            break;

          case "escape":
            e.preventDefault();
            onClose();
            break;

          case " ":
          case "k":
            // Play/Pause
            e.preventDefault();
            player.togglePlay();
            break;

          case "arrowleft":
            // Seek backward 5s
            e.preventDefault();
            seekBy(-5);
            showSeekActionHud(-5);
            break;

          case "arrowright":
            // Seek forward 5s
            e.preventDefault();
            seekBy(5);
            showSeekActionHud(5);
            break;

          case "j":
            // Seek backward 10s
            e.preventDefault();
            seekBy(-10);
            showSeekActionHud(-10);
            break;

          case "l":
            // Seek forward 10s
            e.preventDefault();
            seekBy(10);
            showSeekActionHud(10);
            break;

          case "arrowup":
            // Volume up 5%
            e.preventDefault();
            const currentVolume = player.muted ? 0 : player.volume;
            player.muted = false;
            player.volume = Math.min(1, currentVolume + 0.05);
            showVolumeActionHud(player);
            break;

          case "arrowdown":
            // Volume down 5%
            e.preventDefault();
            player.volume = Math.max(0, player.volume - 0.05);
            if (player.volume === 0) {
              player.muted = true;
            }
            showVolumeActionHud(player);
            break;

          case "m":
            // Mute/Unmute
            e.preventDefault();
            player.muted = !player.muted;
            showVolumeActionHud(player);
            break;

          case "f":
            // Fullscreen
            e.preventDefault();
            void toggleFullscreen();
            break;

          case "home":
            // Jump to beginning
            e.preventDefault();
            player.currentTime = 0;
            break;

          case "end":
            // Jump to end
            e.preventDefault();
            player.currentTime = player.duration;
            break;

          case "0":
          case "1":
          case "2":
          case "3":
          case "4":
          case "5":
          case "6":
          case "7":
          case "8":
          case "9":
            // Jump to 0-90% of video
            e.preventDefault();
            const percent = parseInt(e.key) / 10;
            player.currentTime = player.duration * percent;
            break;

          case ",":
          case "<":
          case ";":
            // Decrease playback speed (< or ; depending on keyboard layout)
            e.preventDefault();
            try {
              const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
              const currentRate = player.speed;
              let currentIndex = rates.findIndex(
                (r) => Math.abs(r - currentRate) < 0.01
              );
              if (currentIndex === -1) currentIndex = rates.indexOf(1);
              if (currentIndex > 0) {
                player.speed = rates[currentIndex - 1];
              }
            } catch (err) {
              console.error("Error changing playback speed:", err);
            }
            break;

          case ".":
          case ">":
          case ":":
            // Increase playback speed (> or : depending on keyboard layout)
            e.preventDefault();
            try {
              const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
              const currentRate = player.speed;
              let currentIndex = rates.findIndex(
                (r) => Math.abs(r - currentRate) < 0.01
              );
              if (currentIndex === -1) currentIndex = rates.indexOf(1);
              if (currentIndex < rates.length - 1) {
                player.speed = rates[currentIndex + 1];
              }
            } catch (err) {
              console.error("Error changing playback speed:", err);
            }
            break;

          case "c":
            // player.toggleCaptions() is Plyr's native-<track> captions API
            // and is a no-op for the YouTube provider - toggle our own
            // tracked state and drive the embed directly instead.
            e.preventDefault();
            toggleCaptions();
            break;

          case "w":
            // Same shortcut the feed grid uses for the highlighted card.
            e.preventDefault();
            handleToggleWatched();
            break;
        }
      } catch (err) {
        console.error("Error handling keyboard shortcut:", err);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, playerReady]);

  // Close header dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        showShortcuts &&
        shortcutsRef.current &&
        !shortcutsRef.current.contains(e.target as Node)
      ) {
        setShowShortcuts(false);
      }
      if (
        showPlayerSettingsMenu &&
        playerSettingsMenuRef.current &&
        !playerSettingsMenuRef.current.contains(e.target as Node)
      ) {
        setShowPlayerSettingsMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showShortcuts, showPlayerSettingsMenu]);

  // Track fullscreen state
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFS = getPlayerFullscreenState();
      setIsFullscreen(isFS);
      updatePlayerDebugSnapshot(playerRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("mozfullscreenchange", handleFullscreenChange);
    document.addEventListener("MSFullscreenChange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener(
        "webkitfullscreenchange",
        handleFullscreenChange
      );
      document.removeEventListener(
        "mozfullscreenchange",
        handleFullscreenChange
      );
      document.removeEventListener(
        "MSFullscreenChange",
        handleFullscreenChange
      );
    };
  }, []);

  // Keep Plyr fullscreen button state in sync with our native fullscreen target.
  useEffect(() => {
    if (!playerReady) return;
    const root = containerRef.current;
    if (!root) return;

    const syncPlyrFullscreenButtons = () => {
      const fullscreenNow = getPlayerFullscreenState();
      const buttons = root.querySelectorAll(
        '.plyr__control[data-plyr="fullscreen"]'
      );
      buttons.forEach((buttonNode) => {
        const button = buttonNode as HTMLButtonElement;
        button.classList.toggle("plyr__control--pressed", fullscreenNow);
        button.setAttribute("aria-pressed", String(fullscreenNow));
        const label = fullscreenNow ? "Exit fullscreen" : "Enter fullscreen";
        button.setAttribute("aria-label", label);
        button.title = label;
      });
    };

    syncPlyrFullscreenButtons();

    const handleFullscreenButtonClickCapture = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const button = target?.closest?.(
        '.plyr__control[data-plyr="fullscreen"]'
      ) as HTMLButtonElement | null;
      if (!button) return;

      // Bypass Plyr's internal fullscreen state machine so GUI and keyboard use
      // the same fullscreen target (our native video frame fullscreen).
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void toggleFullscreen();
    };

    const handleFullscreenButtonHoverOrFocus = (event: Event) => {
      const target = event.target as Element | null;
      const button = target?.closest?.(
        '.plyr__control[data-plyr="fullscreen"]'
      ) as HTMLButtonElement | null;
      if (!button) return;
      syncPlyrFullscreenButtons();
    };

    const handleNativeFullscreenChange = () => {
      syncPlyrFullscreenButtons();
    };

    root.addEventListener("click", handleFullscreenButtonClickCapture, true);
    root.addEventListener("mouseover", handleFullscreenButtonHoverOrFocus, true);
    root.addEventListener("focusin", handleFullscreenButtonHoverOrFocus, true);
    document.addEventListener("fullscreenchange", handleNativeFullscreenChange);
    document.addEventListener(
      "webkitfullscreenchange",
      handleNativeFullscreenChange as EventListener
    );
    return () => {
      root.removeEventListener("click", handleFullscreenButtonClickCapture, true);
      root.removeEventListener(
        "mouseover",
        handleFullscreenButtonHoverOrFocus,
        true
      );
      root.removeEventListener("focusin", handleFullscreenButtonHoverOrFocus, true);
      document.removeEventListener(
        "fullscreenchange",
        handleNativeFullscreenChange
      );
      document.removeEventListener(
        "webkitfullscreenchange",
        handleNativeFullscreenChange as EventListener
      );
    };
  }, [isFullscreen, playerReady, ytVideoId]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 bg-black/95 flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="border-b border-white/10 bg-black/95">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2 line-clamp-2">
                {videoTitle}
              </h1>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Keyboard Shortcuts */}
              <div className="relative" ref={shortcutsRef}>
                <button
                  onClick={() => {
                    setShowShortcuts(!showShortcuts);
                    setShowPlayerSettingsMenu(false);
                  }}
                  className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                  title="Keyboard shortcuts"
                >
                  <Keyboard className="w-5 h-5" />
                </button>

                {showShortcuts && (
                  <div className="absolute right-0 mt-2 w-96 bg-gray-900 border border-white/10 rounded-lg shadow-2xl z-50 overflow-hidden">
                    <div className="p-4 border-b border-white/10">
                      <h3 className="text-white font-semibold flex items-center gap-2">
                        <Keyboard className="w-4 h-4" />
                        Keyboard Shortcuts
                      </h3>
                    </div>
                    <div className="p-4 max-h-96 overflow-y-auto">
                      <div className="space-y-4">
                        {/* Playback */}
                        <div>
                          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-2">
                            Playback
                          </h4>
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">Play/Pause</span>
                              <div className="flex gap-1">
                                <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                  Space
                                </kbd>
                                <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                  K
                                </kbd>
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">Mute/Unmute</span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                M
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Increase speed
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                Shift + &gt;
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Decrease speed
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                Shift + &lt;
                              </kbd>
                            </div>
                          </div>
                        </div>

                        {/* Seeking */}
                        <div>
                          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-2">
                            Seeking
                          </h4>
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Forward 5 seconds
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                →
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Backward 5 seconds
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                ←
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Forward 10 seconds
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                L
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Backward 10 seconds
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                J
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Jump to beginning
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                Home
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">Jump to end</span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                End
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">Jump to %</span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                0-9
                              </kbd>
                            </div>
                          </div>
                        </div>

                        {/* Volume */}
                        <div>
                          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-2">
                            Volume
                          </h4>
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Increase volume
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                ↑
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Decrease volume
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                ↓
                              </kbd>
                            </div>
                          </div>
                        </div>

                        {/* Display */}
                        <div>
                          <h4 className="text-xs font-semibold text-gray-400 uppercase mb-2">
                            Display
                          </h4>
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">Fullscreen</span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                F
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Toggle captions
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                C
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                SponsorBlock popup action
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                Enter
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Toggle watched
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                W
                              </kbd>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-gray-300">
                                Close player
                              </span>
                              <kbd className="px-2 py-1 bg-white/10 rounded text-white font-mono text-xs">
                                Esc
                              </kbd>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={handleToggleWatched}
                aria-pressed={watched}
                className={`inline-flex items-center justify-center w-10 h-10 rounded-full transition-colors ${
                  watched
                    ? "bg-white/25 hover:bg-white/35 text-white"
                    : "bg-white/10 hover:bg-white/20 text-white"
                }`}
                title={
                  watched ? "Mark as unwatched (W)" : "Mark as watched (W)"
                }
                aria-label={watched ? "Mark as unwatched" : "Mark as watched"}
              >
                {watched ? (
                  <Eye className="w-5 h-5" />
                ) : (
                  <EyeOff className="w-5 h-5" />
                )}
              </button>

              <a
                href={youtubeUrlWithTimestamp}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleOpenOnYouTube}
                className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="Open on YouTube"
              >
                <ExternalLink className="w-5 h-5" />
              </a>
              <button
                onClick={onClose}
                className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                title="Close player (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        <div className="px-4 sm:px-6 lg:px-8 py-6">
          <div className="max-w-7xl mx-auto">
            {/* Video Container */}
            <div
              ref={videoFrameRef}
              className="w-full aspect-video relative rounded-xl overflow-hidden shadow-lg bg-black [&:fullscreen]:rounded-none [&:-webkit-full-screen]:rounded-none"
            >
              <div
                ref={playerContainerRef}
                className="w-full h-full [&_.plyr]:h-full [&_.plyr__video-wrapper]:h-full [&_.plyr__video-embed]:h-full"
                style={
                  {
                    "--plyr-color-main": "#ff0000",
                    "--plyr-range-fill-background": "#ff0000",
                    "--plyr-range-thumb-background": sponsorSeekThumbColor,
                    "--plyr-range-track-height": "4px",
                    "--plyr-range-thumb-height": "12px",
                    "--plyr-audio-range-thumb-active-shadow-color": hexToRgba(
                      sponsorSeekThumbColor,
                      0.35
                    ),
                  } as React.CSSProperties
                }
              />
              {controlsPortalTarget &&
                createPortal(
                  <>
                    <button
                      type="button"
                      onClick={toggleCaptions}
                      className="plyr__control"
                      aria-label={
                        captionsEnabled ? "Disable captions" : "Enable captions"
                      }
                      aria-pressed={captionsEnabled}
                      title={
                        captionsEnabled
                          ? "Disable captions (c)"
                          : "Enable captions (c)"
                      }
                    >
                      {captionsEnabled ? <Captions /> : <CaptionsOff />}
                    </button>

                    <div className="relative" ref={playerSettingsMenuRef}>
                      <button
                        type="button"
                        onClick={() => {
                          setShowPlayerSettingsMenu((prev) => !prev);
                          setShowShortcuts(false);
                        }}
                        className="plyr__control"
                        aria-label="Player settings"
                        aria-expanded={showPlayerSettingsMenu}
                        title="Player settings"
                      >
                        <Settings />
                      </button>

                      {showPlayerSettingsMenu && (
                        <div className="absolute right-0 bottom-full mb-2 w-[320px] max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-gray-900/95 shadow-2xl z-50 overflow-hidden backdrop-blur-md">
                          <div className="px-4 py-3 border-b border-white/10">
                            <h3 className="text-sm font-semibold text-white">
                              Player Settings
                            </h3>
                            <p className="mt-1 text-xs text-gray-400">
                              Saved for the built-in player
                            </p>
                          </div>

                          <div className="p-4 space-y-4">
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
                                Default Resolution
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                {(["720p", "1080p"] as const).map((res) => (
                                  <button
                                    key={res}
                                    type="button"
                                    onClick={() => {
                                      void onDefaultResolutionChange?.(res);
                                    }}
                                    className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                                      defaultResolution === res
                                        ? "bg-red-600 text-white"
                                        : "bg-white/5 text-gray-200 hover:bg-white/10"
                                    }`}
                                  >
                                    {res}
                                  </button>
                                ))}
                              </div>
                              <p className="mt-2 text-[11px] text-gray-500">
                                YouTube may override this based on
                                bandwidth/device.
                              </p>
                            </div>

                            <div className="space-y-2">
                              <SettingsToggleRow
                                label="SponsorBlock"
                                description="Auto-skip community segments"
                                value={sponsorBlockEnabled}
                                onChange={(value) => {
                                  void onSponsorBlockEnabledChange?.(value);
                                }}
                              />

                              <SettingsToggleRow
                                label="Debug Overlay"
                                description="Show quality/speed/volume diagnostics"
                                value={debugOverlayEnabled}
                                onChange={(value) => {
                                  void onDebugOverlayEnabledChange?.(value);
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </>,
                  controlsPortalTarget
                )}
              {playerActionHud && (
                <div className="pointer-events-none absolute inset-0 z-[25]">
                  {playerActionHud.kind === "seek" ? (
                    <div
                      className={`absolute top-1/2 -translate-y-1/2 ${
                        playerActionHud.direction === "forward"
                          ? "right-[12%]"
                          : "left-[12%]"
                      }`}
                    >
                      <div className="min-w-[110px] rounded-2xl border border-white/10 bg-black/65 px-4 py-3 text-center text-white shadow-2xl backdrop-blur-sm">
                        <div className="flex items-center justify-center gap-2">
                          {playerActionHud.direction === "forward" ? (
                            <FastForward className="w-5 h-5" />
                          ) : (
                            <Rewind className="w-5 h-5" />
                          )}
                          <span className="text-xl font-semibold tabular-nums">
                            {playerActionHud.direction === "forward" ? "+" : "-"}
                            {playerActionHud.totalSeconds}s
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-gray-300">
                          {playerActionHud.direction === "forward"
                            ? "Forward"
                            : "Back"}
                        </div>
                      </div>
                    </div>
                  ) : playerActionHud.kind === "watched" ? (
                    <div className="absolute left-1/2 bottom-20 -translate-x-1/2">
                      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/70 px-3 py-2 text-white shadow-xl backdrop-blur-sm">
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-white/5">
                          {playerActionHud.watched ? (
                            <Eye className="w-4 h-4" />
                          ) : (
                            <EyeOff className="w-4 h-4" />
                          )}
                        </span>
                        <div className="text-sm font-medium">
                          {playerActionHud.watched
                            ? "Marked as watched"
                            : "Marked as unwatched"}
                        </div>
                      </div>
                    </div>
                  ) : playerActionHud.kind === "captions" ? (
                    <div className="absolute left-1/2 bottom-20 -translate-x-1/2">
                      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/70 px-3 py-2 text-white shadow-xl backdrop-blur-sm">
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-white/5">
                          {playerActionHud.enabled ? (
                            <Captions className="w-4 h-4" />
                          ) : (
                            <CaptionsOff className="w-4 h-4" />
                          )}
                        </span>
                        <div className="text-sm font-medium">
                          {playerActionHud.enabled
                            ? "Captions on"
                            : "Captions off"}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="absolute left-1/2 bottom-20 -translate-x-1/2">
                      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/70 px-3 py-2 text-white shadow-xl backdrop-blur-sm">
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-white/5">
                          {playerActionHud.kind === "speed" ? (
                            <Gauge className="w-4 h-4" />
                          ) : playerActionHud.muted ? (
                            <VolumeX className="w-4 h-4" />
                          ) : (
                            <Volume2 className="w-4 h-4" />
                          )}
                        </span>

                        {playerActionHud.kind === "speed" ? (
                          <div className="text-sm font-medium tabular-nums">
                            Speed {playerActionHud.rate.toFixed(2).replace(/\.00$/, "")}x
                          </div>
                        ) : (
                          <>
                            <div className="text-sm font-medium tabular-nums min-w-[64px]">
                              {playerActionHud.muted
                                ? "Muted"
                                : `Volume ${playerActionHud.percent}%`}
                            </div>
                            <div className="w-20 h-1.5 rounded-full bg-white/10 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-white/90"
                                style={{
                                  width: `${Math.max(
                                    0,
                                    Math.min(100, playerActionHud.percent)
                                  )}%`,
                                }}
                              />
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {debugOverlayEnabled && playerDebugSnapshot && (
                <div className="pointer-events-none absolute top-2 left-2 z-20">
                  <div className="rounded-md border border-white/10 bg-black/70 px-2.5 py-2 text-[11px] leading-4 text-white/90 shadow-lg backdrop-blur-sm font-mono">
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-white/60">
                      Player Debug
                    </div>
                    <div>
                      Quality:{" "}
                      <span className="text-white">
                        {playerDebugSnapshot.quality || "auto/unknown"}
                      </span>
                      {quality ? (
                        <span className="text-white/50"> (pref {quality})</span>
                      ) : null}
                    </div>
                    <div>
                      Speed:{" "}
                      <span className="text-white">
                        {playerDebugSnapshot.speed
                          .toFixed(2)
                          .replace(/\.00$/, "")}
                        x
                      </span>
                    </div>
                    <div>
                      Volume:{" "}
                      <span className="text-white">
                        {playerDebugSnapshot.muted
                          ? "Muted"
                          : `${playerDebugSnapshot.volumePercent}%`}
                      </span>
                    </div>
                    <div>
                      Time:{" "}
                      <span className="text-white">
                        {formatDebugTime(playerDebugSnapshot.currentTime)} /{" "}
                        {formatDebugTime(playerDebugSnapshot.duration)}
                      </span>
                    </div>
                    <div>
                      Fullscreen:{" "}
                      <span className="text-white">
                        {playerDebugSnapshot.fullscreen ? "on" : "off"}
                      </span>
                    </div>
                    <div>
                      Sponsor:{" "}
                      <span className="text-white">
                        {playerDebugSnapshot.sponsorCategory || "none"}
                      </span>
                      <span className="text-white/50">
                        {" "}
                        ({playerDebugSnapshot.sponsorSegmentsCount} seg)
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {sponsorBlockEnabled && sponsorSkipNotice && (
                <div className="absolute left-2.5 right-2.5 bottom-14 sm:left-3 sm:right-auto sm:max-w-xl z-20 pointer-events-none">
                  <div
                    className="pointer-events-auto inline-flex max-w-full items-center rounded-md border border-white/10 bg-black/75 shadow-xl backdrop-blur-md overflow-hidden"
                    style={{
                      boxShadow: `0 8px 24px ${hexToRgba(
                        SPONSORBLOCK_CATEGORY_COLORS[sponsorSkipNotice.category] ||
                          "#ffffff",
                        0.14
                      )}`,
                    }}
                    title="SponsorBlock"
                  >
                    <div className="flex items-center gap-2 pl-2.5 pr-2 py-1.5 min-w-0">
                      <span
                        className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full shrink-0"
                        style={{
                          backgroundColor: hexToRgba(
                            SPONSORBLOCK_CATEGORY_COLORS[sponsorSkipNotice.category] ||
                              "#ffffff",
                            0.2
                          ),
                          color:
                            SPONSORBLOCK_CATEGORY_COLORS[sponsorSkipNotice.category] ||
                            "#ffffff",
                        }}
                        aria-hidden="true"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                      </span>
                      <span className="min-w-0 truncate text-sm text-white/90 font-medium">
                        {(SPONSORBLOCK_CATEGORY_LABELS[sponsorSkipNotice.category] ||
                          sponsorSkipNotice.category) +
                          (sponsorSkipNotice.kind === "skipped"
                            ? " skipped"
                            : " unskipped")}
                      </span>
                    </div>
                    {sponsorNoticeActionLabel && (
                      <>
                        <div className="h-5 w-px bg-white/10 shrink-0" />
                        <button
                          type="button"
                          onClick={() => {
                            void triggerSponsorSkipNoticePrimaryAction();
                          }}
                          className="shrink-0 px-3 py-1.5 text-sm text-gray-200 hover:text-white hover:bg-white/5 transition-colors"
                          title={
                            sponsorSkipNotice.kind === "skipped"
                              ? "Undo sponsor skip"
                              : "Skip this segment again"
                          }
                        >
                          {sponsorNoticeActionLabel}
                        </button>
                      </>
                    )}
                    <div className="flex items-center gap-1 pr-1 pl-1.5 shrink-0">
                      {sponsorNoticeCountdownSeconds ? (
                        <span className="inline-flex items-center justify-center min-w-8 h-6 rounded-md border border-white/10 bg-black/35 px-1.5 text-xs text-gray-200">
                          {sponsorNoticeCountdownSeconds}s
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          clearSponsorSkipNoticeTimer();
                          setSponsorSkipNotice(null);
                        }}
                        className="inline-flex items-center justify-center w-6 h-6 rounded-md text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                        title="Dismiss SponsorBlock popup"
                        aria-label="Dismiss SponsorBlock popup"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Channel Row + Comments Toggle */}
            <div className="mt-4 border border-white/10 bg-black/90 rounded-xl px-4 sm:px-5 py-3">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <button
                  onClick={() => {
                    onChannelClick?.(displayChannelName);
                    onClose();
                  }}
                  className="flex items-center gap-3 hover:bg-white/10 rounded-lg p-2 -m-2 transition-colors group cursor-pointer"
                >
                  {channelThumbnail ? (
                    <img
                      src={getProxiedImageUrl(channelThumbnail)}
                      alt={displayChannelName}
                      className="w-10 h-10 rounded-full ring-2 ring-white/10 group-hover:ring-white/30 transition-all"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center ring-2 ring-white/10 group-hover:ring-white/30 transition-all">
                      <span className="text-white font-semibold text-sm">
                        {displayChannelName.charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}
                  <div className="flex flex-col items-start">
                    <span className="text-white font-medium group-hover:text-gray-100 transition-colors">
                      {displayChannelName}
                    </span>
                    <span className="text-xs text-gray-500">
                      Click to view channel videos
                    </span>
                  </div>
                </button>

                <div className="flex items-center gap-4">
                  <button
                    onClick={() => {
                      if (showComments) {
                        setShowComments(false);
                      } else {
                        openComments();
                      }
                    }}
                    className="inline-flex items-center gap-1.5 text-sm text-gray-300 hover:text-white transition-colors cursor-pointer"
                    aria-expanded={showComments}
                    aria-label="Toggle comments"
                  >
                    {showComments ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                    {showComments ? "Hide comments" : "View comments"}
                  </button>

                </div>
              </div>
            </div>

            {showComments && (
              <div className="mt-4 rounded-xl border border-white/10 bg-black/90">
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10">
                  <h2 className="text-sm font-medium text-white">Comments</h2>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowComments(false)}
                      className="inline-flex items-center gap-1.5 text-xs text-gray-300 hover:text-white transition-colors cursor-pointer"
                      aria-label="Collapse comments"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                      Hide comments
                    </button>
                    <select
                      value={commentsSort}
                      onChange={(e) => {
                        const newSort = e.target.value === "new" ? "new" : "top";
                        if (newSort === commentsSort) return;
                        setCommentsSort(newSort);
                        setComments([]);
                        setCommentsError(null);
                        setNextCommentsToken(undefined);
                        setCommentsDisabled(false);
                        setReplyThreads({});
                        setHasRequestedComments(true);
                        loadCommentsPage({ sortOverride: newSort });
                      }}
                      className="h-8 rounded-md border border-white/20 bg-black/70 px-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-white/30"
                      title="Sort comments"
                    >
                      <option value="top">Top</option>
                      <option value="new">Newest</option>
                    </select>
                  </div>
                </div>

                <div className="px-4 py-3 space-y-3">
                  {commentsLoading && comments.length === 0 ? (
                    <div className="h-full min-h-[160px] flex items-center justify-center text-gray-300">
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      Loading comments...
                    </div>
                  ) : commentsError ? (
                    <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                      <p>{commentsError}</p>
                      <button
                        onClick={() => loadCommentsPage({ sortOverride: commentsSort })}
                        className="mt-2 text-xs underline underline-offset-2 hover:text-red-100"
                      >
                        Retry
                      </button>
                    </div>
                  ) : commentsDisabled ? (
                    <div className="rounded-lg border border-white/15 bg-white/5 p-3 text-sm text-gray-300">
                      Comments are disabled for this video.
                    </div>
                  ) : comments.length === 0 ? (
                    <div className="rounded-lg border border-white/15 bg-white/5 p-3 text-sm text-gray-300">
                      No comments available.
                    </div>
                  ) : (
                    comments.map((comment) => {
                      const thread = replyThreads[comment.id];
                      return (
                        <article
                          key={comment.id}
                          className="rounded-lg border border-white/10 bg-white/5 p-3"
                        >
                          <div className="flex items-start gap-3">
                            {comment.authorAvatarUrl &&
                            !failedAvatarIds.has(comment.id) ? (
                              <img
                                src={getProxiedImageUrl(comment.authorAvatarUrl)}
                                alt={comment.author}
                                className="w-8 h-8 rounded-full ring-1 ring-white/10 flex-shrink-0"
                                referrerPolicy="no-referrer"
                                onError={() => {
                                  setFailedAvatarIds((prev) => {
                                    const next = new Set(prev);
                                    next.add(comment.id);
                                    return next;
                                  });
                                }}
                              />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-white/10 text-white text-xs font-semibold flex items-center justify-center flex-shrink-0">
                                {comment.author.charAt(0).toUpperCase()}
                              </div>
                            )}

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                                <span className="font-semibold text-white truncate">
                                  {comment.author}
                                </span>
                                {comment.authorIsCreator && (
                                  <span className="px-1.5 py-0.5 rounded bg-white/15 text-[10px] text-gray-200">
                                    Creator
                                  </span>
                                )}
                                {comment.pinned && (
                                  <span className="px-1.5 py-0.5 rounded bg-white/15 text-[10px] text-gray-200">
                                    Pinned
                                  </span>
                                )}
                                {comment.publishedTime && (
                                  <span className="text-gray-400">{comment.publishedTime}</span>
                                )}
                              </div>

                              <p className="mt-2 text-sm text-gray-100 whitespace-pre-wrap break-words">
                                {comment.text}
                              </p>

                              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                                {comment.likeCountText && (
                                  <span className="inline-flex items-center gap-1 text-gray-400">
                                    <ThumbsUp className="w-3 h-3" />
                                    <span>{comment.likeCountText}</span>
                                  </span>
                                )}

                                {(comment.replyCount || comment.repliesToken) && (
                                  <button
                                    onClick={() => {
                                      if (thread?.expanded) {
                                        setReplyThreads((prev) => ({
                                          ...prev,
                                          [comment.id]: {
                                            ...prev[comment.id],
                                            expanded: false,
                                          },
                                        }));
                                        return;
                                      }

                                      if (thread?.items?.length) {
                                        setReplyThreads((prev) => ({
                                          ...prev,
                                          [comment.id]: {
                                            ...prev[comment.id],
                                            expanded: true,
                                          },
                                        }));
                                        return;
                                      }

                                      const initialToken = comment.repliesToken;
                                      if (initialToken) {
                                        loadReplies(comment.id, initialToken, false);
                                      }
                                    }}
                                    className="inline-flex items-center gap-1 text-gray-300 hover:text-white transition-colors"
                                  >
                                    {thread?.expanded ? (
                                      <ChevronUp className="w-3 h-3" />
                                    ) : (
                                      <ChevronDown className="w-3 h-3" />
                                    )}
                                    <span>
                                      {comment.replyCountText ||
                                        (comment.replyCount
                                          ? `${comment.replyCount} replies`
                                          : "Replies")}
                                    </span>
                                  </button>
                                )}
                              </div>

                              {thread?.expanded && (
                                <div className="mt-3 pl-3 border-l border-white/10 space-y-2">
                                  {thread.loading ? (
                                    <div className="text-xs text-gray-400 inline-flex items-center gap-2">
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                      Loading replies...
                                    </div>
                                  ) : thread.error ? (
                                    <div className="text-xs text-red-300">
                                      {thread.error}
                                    </div>
                                  ) : thread.items.length === 0 ? (
                                    <div className="text-xs text-gray-400">
                                      No replies found.
                                    </div>
                                  ) : (
                                    <>
                                      {thread.items.map((reply) => (
                                        <div
                                          key={reply.id}
                                          className="rounded-md border border-white/10 bg-black/30 p-2"
                                        >
                                          <div className="text-xs text-gray-300">
                                            <span className="font-semibold text-white mr-2">
                                              {reply.author}
                                            </span>
                                            {reply.publishedTime}
                                          </div>
                                          <p className="mt-1 text-sm text-gray-100 whitespace-pre-wrap break-words">
                                            {reply.text}
                                          </p>
                                        </div>
                                      ))}
                                    </>
                                  )}

                                  {thread.nextPageToken && (
                                    <button
                                      onClick={() =>
                                        thread.nextPageToken &&
                                        loadReplies(comment.id, thread.nextPageToken, true)
                                      }
                                      disabled={thread.loadingMore}
                                      className="inline-flex items-center text-xs text-gray-300 hover:text-white disabled:opacity-50"
                                    >
                                      {thread.loadingMore ? (
                                        <>
                                          <Loader2 className="w-3 h-3 animate-spin mr-1" />
                                          Loading more replies...
                                        </>
                                      ) : (
                                        "Load more replies"
                                      )}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>

                <div className="border-t border-white/10 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <button
                      onClick={() =>
                        nextCommentsToken &&
                        loadCommentsPage({
                          append: true,
                          pageToken: nextCommentsToken,
                          sortOverride: commentsSort,
                        })
                      }
                      disabled={!nextCommentsToken || loadingMoreComments || commentsLoading}
                      className="inline-flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-3 py-2 transition-colors"
                    >
                      {loadingMoreComments ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          Loading...
                        </>
                      ) : (
                        "Load more comments"
                      )}
                    </button>

                    <a
                      href={youtubeUrlWithTimestamp}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-gray-300 hover:text-white underline underline-offset-2"
                    >
                      Open full thread on YouTube
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Memoize to prevent re-renders that cause iframe stuttering
export const VideoPlayer = memo(
  VideoPlayerComponent,
  (prevProps, nextProps) => {
    return (
      prevProps.videoId === nextProps.videoId &&
      prevProps.videoTitle === nextProps.videoTitle &&
      prevProps.channelName === nextProps.channelName &&
      prevProps.channelId === nextProps.channelId &&
      prevProps.channelThumbnail === nextProps.channelThumbnail &&
      prevProps.videoUrl === nextProps.videoUrl &&
      prevProps.quality === nextProps.quality &&
      prevProps.defaultResolution === nextProps.defaultResolution &&
      prevProps.sponsorBlockEnabled === nextProps.sponsorBlockEnabled &&
      prevProps.debugOverlayEnabled === nextProps.debugOverlayEnabled &&
      prevProps.captionsEnabled === nextProps.captionsEnabled &&
      prevProps.initialProgress === nextProps.initialProgress &&
      prevProps.watched === nextProps.watched &&
      prevProps.watchedThresholdPercent === nextProps.watchedThresholdPercent
    );
  }
);
