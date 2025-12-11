import React from "react";
import { Clock, Eye } from "lucide-react";
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
  onWatch?: () => void;
  onWatchLater?: () => void;
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
  onWatch,
  onWatchLater,
}: VideoCardProps) {
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
        <div className="absolute top-2 right-2 bg-black/80 px-2 py-1 rounded text-white text-xs font-semibold">
          {duration || "—"}
        </div>
        {watched && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <Eye className="w-8 h-8 text-white" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4">
        <h3 className="font-semibold text-sm leading-tight mb-2 line-clamp-2 group-hover:text-primary transition-colors">
          {title}
        </h3>
        <p className="text-xs text-muted-foreground mb-2">{channel}</p>

        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
          {views && <span>{views.toLocaleString()} views</span>}
          {uploadedAt && <span>{uploadedAt}</span>}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            onClick={onWatch}
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
