import React, { useState, useRef, useEffect } from "react";
import {
  Clock,
  Eye,
  EyeOff,
  MoreVertical,
  Check,
  Share2,
  CheckCircle2,
} from "lucide-react";
import { Button } from "./ui/button";
import { getProxiedImageUrl } from "@/lib/videoUtils";
import { formatVideoDuration } from "@/lib/duration";

function formatViewCount(views: number): string {
  if (views >= 1000000) {
    return (views / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (views >= 1000) {
    return (views / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  }
  return views.toString();
}

function formatTimeAgo(dateString: string): string {
  // Parse ISO 8601 timestamp properly
  const date = new Date(dateString);
  const now = new Date();

  // If date is invalid, return empty
  if (isNaN(date.getTime())) return "";

  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w ago`;
  return `${Math.floor(seconds / 2592000)}mo ago`;
}

interface VideoCardProps {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
  durationSeconds?: number;
  uploadedAt?: string;
  views?: number;
  watched?: boolean;
  videoUrl?: string;
  showDurationPlaceholder?: boolean;
  isMemberOnly?: boolean;
  // Render inline action buttons under the card (used in Watch Later section)
  inlineActions?: boolean;
  onWatch?: () => void;
  onWatchLater?: () => void;
  onMarkWatched?: () => void;
  onChannelClick?: (channelName: string) => void;
  onPlayInPlayer?: (videoUrl: string) => void;
  useBuiltInPlayer?: boolean;
}

export function VideoCard({
  id,
  title,
  channel,
  thumbnail,
  durationSeconds,
  uploadedAt,
  views,
  watched,
  videoUrl,
  showDurationPlaceholder,
  isMemberOnly = false,
  inlineActions,
  onWatch,
  onWatchLater,
  onMarkWatched,
  onChannelClick,
  onPlayInPlayer,
  useBuiltInPlayer = false,
}: VideoCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  // Only show skeleton if image takes longer than 50ms to load
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [skeletonThumbnail, setSkeletonThumbnail] = useState(thumbnail);
  const menuRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const thumbnailSrc = getProxiedImageUrl(thumbnail);
  const durationLabel = showDurationPlaceholder
    ? formatVideoDuration(durationSeconds)
    : null;

  const handleWatch = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Prevent the default link behavior
    e.preventDefault();
    e.stopPropagation();

    if (useBuiltInPlayer && videoUrl) {
      // Use built-in player
      onPlayInPlayer?.(videoUrl);
    } else {
      // Get the URL from the link's href attribute
      const url = e.currentTarget.href;

      // Open in new tab - only once, with full control
      if (url) {
        const newTab = window.open(url, "_blank", "noopener,noreferrer");
        if (newTab) newTab.opener = null;
      }
    }

    // Call callback for tracking
    onWatch?.();
  };

  const handleWatchLater = () => {
    onWatchLater?.();
    setShowMenu(false);
  };

  const handleMarkWatched = () => {
    onMarkWatched?.();
    setShowMenu(false);
  };

  const handleShare = () => {
    if (videoUrl) {
      navigator.clipboard.writeText(videoUrl);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setShowMenu(false);
      }, 2000);
    }
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [showMenu]);

  {
    /* Inline action row (used in Watch Later page) */
  }
  {
    inlineActions && (
      <div className="flex items-center gap-2 mb-2">
        {/* Order consistent with start page: Mark watched/unwatched, Share */}
        <Button
          onClick={handleMarkWatched}
          variant="secondary"
          size="sm"
          className="h-7 px-2"
        >
          <Eye className="w-4 h-4 mr-1" />
          {watched ? "Unwatch" : "Mark watched"}
        </Button>
        <Button
          onClick={handleShare}
          variant="outline"
          size="sm"
          className="h-7 px-2"
        >
          <Share2 className="w-4 h-4 mr-1" />
          {copied ? "Copied" : "Share"}
        </Button>
      </div>
    );
  }
  // Reset the skeleton while rendering the new thumbnail instead of in an
  // effect, so it never flashes for an image that is already cached.
  if (thumbnail !== skeletonThumbnail) {
    setSkeletonThumbnail(thumbnail);
    setShowSkeleton(false);
  }

  // Only show skeleton if image hasn't loaded after 50ms
  useEffect(() => {
    const timer = setTimeout(() => {
      if (imgRef.current && !imgRef.current.complete) {
        setShowSkeleton(true);
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [thumbnail]);
  return (
    <div
      className="group overflow-visible rounded-xl hover:shadow-xl transition-all duration-300 bg-card border border-border/50 hover:border-border"
      ref={menuRef}
    >
      {/* Thumbnail */}
      <a
        href={videoUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="relative overflow-hidden bg-secondary aspect-video cursor-pointer block rounded-t-xl"
        onClick={handleWatch}
      >
        {/* Skeleton placeholder while image loads - only render if needed */}
        {showSkeleton && (
          <div className="absolute inset-0 bg-muted animate-pulse pointer-events-none" />
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={thumbnailSrc}
          alt=""
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          draggable="false"
          loading="lazy"
          decoding="async"
          onLoad={(e) => {
            setShowSkeleton(false);
          }}
          onError={(e) => {
            setShowSkeleton(false);
          }}
        />

        {watched && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none">
            <Eye className="w-8 h-8 text-white" />
          </div>
        )}
      </a>

      {/* Content */}
      <div className="p-3 flex flex-col">
        {/* Title and Menu */}
        <div className="flex items-start justify-between gap-2 mb-1">
          <h3 className="font-semibold text-sm leading-tight line-clamp-2 group-hover:text-primary transition-colors flex-1">
            {title}
          </h3>
          <div className="relative flex-shrink-0">
            <Button
              onClick={() => setShowMenu(!showMenu)}
              variant="ghost"
              size="icon"
              className={`h-8 w-8 transition-all duration-150 ${
                showMenu
                  ? "bg-primary/10 text-primary hover:bg-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-primary/5"
              } focus:ring-2 focus:ring-primary/50 focus:ring-offset-0`}
            >
              <MoreVertical className="w-4 h-4" />
            </Button>
            {showMenu && (
              <div className="absolute right-0 top-full mt-2 bg-card border border-border/50 rounded-lg shadow-xl backdrop-blur-sm z-10 min-w-56 overflow-hidden">
                {/* Header */}
                <div className="bg-gradient-to-r from-primary/5 to-transparent border-b border-border/30 px-4 py-2.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Video Options
                  </p>
                </div>

                {/* Menu Items */}
                <div className="py-1">
                  <button
                    onClick={handleMarkWatched}
                    className="w-full text-left px-4 py-2.5 text-sm hover:bg-primary/5 transition-colors flex items-center gap-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-inset"
                  >
                    <Eye className="w-4 h-4 flex-shrink-0" />
                    {watched ? "Mark as unwatched" : "Mark as watched"}
                  </button>
                  <button
                    onClick={handleWatchLater}
                    className="w-full text-left px-4 py-2.5 text-sm hover:bg-primary/5 transition-colors flex items-center gap-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-inset"
                  >
                    <Clock className="w-4 h-4 flex-shrink-0" />
                    Watch later
                  </button>
                  <button
                    onClick={handleShare}
                    className="w-full text-left px-4 py-2.5 text-sm hover:bg-primary/5 transition-colors flex items-center gap-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-inset"
                  >
                    {copied ? (
                      <>
                        <Check className="w-4 h-4 flex-shrink-0 text-green-500" />
                        <span className="text-green-600">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Share2 className="w-4 h-4 flex-shrink-0" />
                        Copy link
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <p
          className="text-xs text-muted-foreground mb-0.5 line-clamp-1 cursor-pointer hover:text-primary transition-colors"
          onClick={() => onChannelClick?.(channel)}
        >
          {channel}
        </p>

        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2 line-clamp-1">
          {isMemberOnly ? (
            <span className="px-1.5 py-px bg-green-500/20 text-green-500 rounded text-xs font-medium">
              Member
            </span>
          ) : (
            views && <span>{formatViewCount(views)} views</span>
          )}
          {uploadedAt && (isMemberOnly || views) && <span>•</span>}
          {uploadedAt && <span>{formatTimeAgo(uploadedAt)}</span>}
          {/* Length sits at the far right of this row. It is backfilled per
              video, so it is simply absent until the lookup resolves. */}
          {durationLabel && (
            <span className="ml-auto pl-2 flex-shrink-0">{durationLabel}</span>
          )}
        </div>
      </div>
    </div>
  );
}
