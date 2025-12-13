import React, { useState, useRef, useEffect } from "react";
import { Clock, Eye, MoreVertical, Check, Share2 } from "lucide-react";
import { Button } from "./ui/button";

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
  duration?: string;
  uploadedAt?: string;
  views?: number;
  watched?: boolean;
  videoUrl?: string;
  onWatch?: () => void;
  onWatchLater?: () => void;
  onMarkWatched?: () => void;
  onChannelClick?: (channelName: string) => void;
}

export function VideoCard({
  id,
  title,
  channel,
  thumbnail,
  duration,
  uploadedAt,
  views,
  watched,
  videoUrl,
  onWatch,
  onWatchLater,
  onMarkWatched,
  onChannelClick,
}: VideoCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleWatch = () => {
    if (videoUrl) {
      window.open(videoUrl, "_blank");
    }
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
  return (
    <div
      className="group overflow-visible rounded-lg hover:shadow-lg transition-all duration-300 bg-card border border-border"
      ref={menuRef}
    >
      {/* Thumbnail */}
      <a
        href={videoUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="relative overflow-hidden bg-secondary aspect-video cursor-pointer block rounded-t-lg"
        onClick={(e) => {
          // Let middle-click and ctrl/cmd+click pass through naturally
          if (e.button !== 0) return;
          e.preventDefault();
          handleWatch();
        }}
      >
        {/* Skeleton placeholder while image loads */}
        {!imageLoaded && (
          <div className="absolute inset-0 bg-muted animate-pulse" />
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbnail}
          alt={title}
          className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 ${
            imageLoaded ? "opacity-100" : "opacity-0"
          }`}
          draggable="false"
          onLoad={() => setImageLoaded(true)}
        />

        {/* Duration badge - top right */}
        {duration && (
          <div className="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
            {duration}
          </div>
        )}

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
              className="h-6 w-6"
            >
              <MoreVertical className="w-4 h-4" />
            </Button>
            {showMenu && (
              <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-md shadow-lg z-10 min-w-48">
                <button
                  onClick={handleMarkWatched}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-secondary transition-colors flex items-center gap-2 first:rounded-t-md"
                >
                  <Eye className="w-4 h-4" />
                  {watched ? "Mark as unwatched" : "Mark as watched"}
                </button>
                <button
                  onClick={handleWatchLater}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-secondary transition-colors flex items-center gap-2"
                >
                  <Clock className="w-4 h-4" />
                  Watch later
                </button>
                <button
                  onClick={handleShare}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-secondary transition-colors flex items-center gap-2 last:rounded-b-md"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 text-green-500" />
                      Copied to clipboard
                    </>
                  ) : (
                    <>
                      <Share2 className="w-4 h-4" />
                      Share
                    </>
                  )}
                </button>
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
          {views && <span>{views.toLocaleString()} views</span>}
          {uploadedAt && <span>•</span>}
          {uploadedAt && <span>{formatTimeAgo(uploadedAt)}</span>}
        </div>
      </div>
    </div>
  );
}
