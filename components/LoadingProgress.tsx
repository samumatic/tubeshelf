import React, { useEffect, useState, useRef } from "react";

interface FeedProgress {
  total: number;
  completed: number;
  currentChannel?: string;
  currentChannelTitle?: string;
}

interface LoadingProgressProps {
  isVisible: boolean;
}

export function LoadingProgress({ isVisible }: LoadingProgressProps) {
  const [progress, setProgress] = useState<FeedProgress>({
    total: 0,
    completed: 0,
  });
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!isVisible) {
      // Reset progress when becoming invisible
      setProgress({ total: 0, completed: 0 });
      // Close any existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    // Avoid creating multiple EventSource connections
    if (!eventSourceRef.current) {
      eventSourceRef.current = new EventSource("/api/feed/progress");
    }

    const eventSource = eventSourceRef.current;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setProgress(data);
      } catch (e) {
        console.error("Failed to parse progress update:", e);
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      eventSourceRef.current = null;
    };

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [isVisible]);

  if (!isVisible || progress.total === 0) {
    return null;
  }

  const percentage = Math.round((progress.completed / progress.total) * 100);

  return (
    <div className="fixed inset-0 flex items-center justify-center pointer-events-none z-40">
      <div className="bg-card border border-border rounded-lg shadow-lg p-6 w-96 pointer-events-auto space-y-4">
        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {progress.completed} / {progress.total} channels
            </span>
            <span className="text-sm font-semibold text-primary">
              {percentage}%
            </span>
          </div>
          <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-primary via-primary/80 to-primary rounded-full transition-all duration-300 ease-out"
              style={{ width: `${Math.min(percentage, 100)}%` }}
            />
          </div>
        </div>

        {/* Current Channel */}
        {progress.currentChannelTitle && (
          <p className="text-xs text-muted-foreground truncate">
            <span className="font-medium text-foreground">
              {progress.currentChannelTitle}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
