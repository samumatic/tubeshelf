import React, { useState, useRef, useEffect } from "react";
import { Clock, Eye, MoreVertical, Check, Share2 } from "lucide-react";
import { Button } from "./ui/button";

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
}: VideoCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleWatch = () => {
    if (videoUrl) {
      window.open(videoUrl, "_blank");
    }
    onWatch?.();
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
    <div className="group overflow-hidden rounded-lg hover:shadow-lg transition-all duration-300 bg-card border border-border">
      {/* Thumbnail */}
      <div className="relative overflow-hidden bg-secondary h-56 sm:h-40">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbnail}
          alt={title}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
        />
        {/* Menu Button */}
        <div className="absolute top-2 right-2" ref={menuRef}>
          <Button
            onClick={() => setShowMenu(!showMenu)}
            variant="ghost"
            size="icon"
            className="w-8 h-8 bg-black/60 hover:bg-black/80 text-white"
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
        {watched && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none">
            <Eye className="w-8 h-8 text-white" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4 flex flex-col h-48">
        <h3 className="font-semibold text-sm leading-tight mb-2 line-clamp-2 group-hover:text-primary transition-colors">
          {title}
        </h3>
        <p className="text-xs text-muted-foreground mb-1 line-clamp-1">
          {channel}
        </p>

        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3 line-clamp-1">
          {views && <span>{views.toLocaleString()} views</span>}
          {uploadedAt && <span>•</span>}
          {uploadedAt && <span>{uploadedAt}</span>}
        </div>

        {/* Actions */}
        <div className="flex gap-2 mt-auto">
          <Button
            onClick={handleWatch}
            variant="default"
            size="sm"
            className="flex-1 text-xs"
          >
            Watch
          </Button>
          <Button
            onClick={onWatchLater}
            variant="outline"
            size="sm"
            className="flex-1 text-xs"
          >
            <Clock className="w-3 h-3 mr-1" />
            Later
          </Button>
        </div>
      </div>
    </div>
  );
}
