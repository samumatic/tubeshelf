import React from "react";
import { Bookmark, Trash2, Eye } from "lucide-react";

interface WatchLaterItem {
  id: string;
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  addedAt: Date;
}

interface WatchLaterProps {
  items: WatchLaterItem[];
  watchedVideos?: Set<string>;
  onRemove?: (id: string) => void;
  onPlay?: (videoId: string) => void;
}

export function WatchLater({
  items,
  watchedVideos,
  onRemove,
  onPlay,
}: WatchLaterProps) {
  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <Bookmark className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-lg font-semibold mb-2">No videos saved</h3>
        <p className="text-muted-foreground">
          Videos you save for later will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const isWatched = watchedVideos?.has(item.videoId);

        return (
          <div
            key={item.id}
            className="flex gap-3 p-3 rounded border border-border hover:bg-secondary transition-colors group"
          >
            {/* Thumbnail */}
            <div className="relative w-24 h-16 flex-shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.thumbnail}
                alt={item.title}
                className="w-full h-full object-cover rounded cursor-pointer"
                onClick={() => onPlay?.(item.videoId)}
              />

              {isWatched && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center pointer-events-none rounded">
                  <Eye className="w-6 h-6 text-white" />
                </div>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <h4
                className="font-medium text-sm line-clamp-2 text-foreground group-hover:text-primary transition-colors cursor-pointer"
                onClick={() => onPlay?.(item.videoId)}
              >
                {item.title}
              </h4>
              <p className="text-xs text-muted-foreground mt-1">
                {item.channel}
              </p>
              <p className="text-xs text-muted-foreground">
                Saved{" "}
                {item.addedAt.toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-2 flex-shrink-0">
              <button
                onClick={() => onRemove?.(item.id)}
                className="p-2 hover:bg-destructive/10 rounded transition-colors"
              >
                <Trash2 className="w-4 h-4 text-destructive" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
