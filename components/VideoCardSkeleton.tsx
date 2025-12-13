export function VideoCardSkeleton() {
  return (
    <div className="group overflow-visible rounded-lg bg-card border border-border animate-pulse">
      {/* Thumbnail skeleton */}
      <div className="relative overflow-hidden bg-secondary aspect-video rounded-t-lg">
        <div className="w-full h-full bg-muted" />
        {/* Duration badge skeleton */}
        <div className="absolute top-2 right-2 bg-muted/50 h-5 w-12 rounded" />
      </div>

      {/* Content skeleton */}
      <div className="p-3 flex flex-col">
        {/* Title skeleton - 2 lines */}
        <div className="space-y-2 mb-2">
          <div className="h-4 bg-muted rounded w-full" />
          <div className="h-4 bg-muted rounded w-4/5" />
        </div>

        {/* Channel name skeleton */}
        <div className="h-3 bg-muted rounded w-2/3 mb-2" />

        {/* Metadata skeleton */}
        <div className="flex items-center gap-2 text-xs">
          <div className="h-3 bg-muted rounded w-16" />
          <div className="h-3 w-1 bg-muted rounded-full" />
          <div className="h-3 bg-muted rounded w-20" />
        </div>
      </div>
    </div>
  );
}
