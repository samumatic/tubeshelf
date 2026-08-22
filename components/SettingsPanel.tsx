"use client";

import React, { useState, useContext, useEffect, useRef } from "react";
import { AlertTriangle, HelpCircle, Palette, Zap } from "lucide-react";
import { Button } from "./ui/button";
import { ThemeContext } from "./ThemeProvider";
import { useClickOutside } from "@/hooks/useClickOutside";
import {
  RETENTION_OPTIONS,
  WATCHED_THRESHOLD_DEFAULT,
  WATCHED_THRESHOLD_MAX,
  WATCHED_THRESHOLD_MIN,
  formatRetention,
  type AppSettings,
} from "@/lib/settingsSchema";

interface SettingsPanelProps {
  settings: AppSettings;
  /** Per-user retention override; null means "follow the instance default". */
  videoRetentionDays?: number | null;
  onRetentionChange?: (days: number | null) => void;
  /** How far a video must play before it counts as watched. */
  watchedThresholdPercent?: number;
  onWatchedThresholdChange?: (percent: number) => void;
  onSave?: (settings: Partial<AppSettings>) => void;
  onDeleteSubscriptions?: (listId?: string) => Promise<void>;
  onClearWatchHistory?: () => Promise<void>;
  onResetSettings?: () => Promise<void>;
  subscriptionLists?: Array<{ id: string; name: string }>;
  currentListId?: string;
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsPanel({
  settings,
  videoRetentionDays = null,
  onRetentionChange,
  watchedThresholdPercent = WATCHED_THRESHOLD_DEFAULT,
  onWatchedThresholdChange,
  onSave,
  onDeleteSubscriptions,
  onClearWatchHistory,
  onResetSettings,
  subscriptionLists = [],
  currentListId,
  isOpen,
  onClose,
}: SettingsPanelProps) {
  const { setTheme } = useContext(ThemeContext);
  const [local, setLocal] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<"all" | string>("all");
  const [version, setVersion] = useState<string>("...");
  const [showFeedLoadingHelp, setShowFeedLoadingHelp] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Sync local state when settings prop changes
    setLocal(settings);
  }, [settings]);

  // Auto-save whenever local settings change
  useEffect(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        setError(null);
        const changes: Record<string, any> = {};
        Object.entries(local).forEach(([key, value]) => {
          if (value !== (settings as Record<string, any>)[key]) {
            changes[key] = value;
          }
        });

        if (Object.keys(changes).length > 0) {
          await onSave?.(changes as Partial<AppSettings>);
        }
      } catch (err: any) {
        setError(err?.message || "Failed to save settings");
      }
    }, 500); // 500ms debounce

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [local, settings, onSave]);

  // Close tooltip when clicking outside
  useClickOutside(tooltipRef, showFeedLoadingHelp, () =>
    setShowFeedLoadingHelp(false)
  );

  useEffect(() => {
    fetch("/api/version")
      .then((res) => res.json())
      .then((data) => setVersion(data.version))
      .catch(() => setVersion("unknown"));
  }, []);

  const handleDangerAction = async (
    action: "subscriptions" | "history" | "settings"
  ) => {
    setError(null);
    try {
      if (action === "subscriptions") {
        const targetListId = deleteTarget === "all" ? undefined : deleteTarget;
        await onDeleteSubscriptions?.(targetListId);
      } else if (action === "history") await onClearWatchHistory?.();
      else if (action === "settings") await onResetSettings?.();
      setConfirmAction(null);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to complete action");
    }
  };

  if (!isOpen) return null;

  return (
    <div className="space-y-6">
      {confirmAction ? (
        // Confirmation Dialog
        <div className="space-y-4">
          <div className="flex items-start gap-4 p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
            <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold text-sm">
                {confirmAction === "subscriptions"
                  ? "Delete Subscriptions"
                  : confirmAction === "history"
                  ? "Clear Watch History"
                  : "Reset Settings"}
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                {confirmAction === "subscriptions"
                  ? deleteTarget === "all"
                    ? "This will permanently remove all your subscriptions from all lists. This action cannot be undone."
                    : "This will permanently remove all your subscriptions from the selected list. This action cannot be undone."
                  : confirmAction === "history"
                  ? "This will permanently clear all your watched/unwatched video states. This action cannot be undone."
                  : "Your settings will be reset to default values. Your subscriptions and watch history will not be affected."}
              </p>
            </div>
          </div>

          {confirmAction === "subscriptions" && (
            <div className="space-y-2">
              <label className="block text-sm font-medium">Delete from:</label>
              <select
                value={deleteTarget}
                onChange={(e) => setDeleteTarget(e.target.value)}
                className="w-full px-3 py-2 bg-card border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-primary/50 transition-colors"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 0.75rem center",
                  paddingRight: "2rem",
                }}
              >
                <option value="all">All Lists</option>
                {subscriptionLists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button
              onClick={() => {
                setConfirmAction(null);
                setDeleteTarget("all");
              }}
              variant="outline"
              size="sm"
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                handleDangerAction(
                  confirmAction as "subscriptions" | "history" | "settings"
                )
              }
              variant="destructive"
              size="sm"
            >
              Confirm
            </Button>
          </div>
        </div>
      ) : (
        <>
          {error && (
            <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-xl text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Preferences Section */}
          <div className="space-y-6">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Palette className="w-5 h-5 text-primary" />
              Appearance
            </h3>

            <div className="bg-card/50 border border-border/30 rounded-xl p-5 space-y-4 backdrop-blur-sm">
              <div>
                <p className="text-sm font-semibold text-foreground">Theme</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Choose your preferred color scheme
                </p>
              </div>
              <div className="flex gap-2">
                {(["system", "light", "dark"] as const).map((theme) => (
                  <button
                    key={theme}
                    onClick={() => {
                      const updated = { ...local, theme };
                      setLocal(updated);
                      setTheme(theme);
                    }}
                    className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                      local.theme === theme
                        ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                        : "bg-muted/60 hover:bg-muted text-foreground hover:shadow-md"
                    }`}
                  >
                    {theme === "system"
                      ? "System"
                      : theme === "light"
                      ? "Light"
                      : "Dark"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Settings Section */}
          <div className="space-y-6 border-t border-border/20 pt-8">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Settings
            </h3>

            {/* Default Sort Order */}
            <div className="bg-card/50 border border-border/30 rounded-xl p-5 space-y-4 backdrop-blur-sm">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Default Sort Order
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  How to organize videos in your feed
                </p>
              </div>
              <div className="flex gap-2">
                {(["newest", "oldest"] as const).map((order) => (
                  <button
                    key={order}
                    onClick={() =>
                      setLocal({ ...local, defaultSortOrder: order })
                    }
                    className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                      local.defaultSortOrder === order
                        ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                        : "bg-muted/60 hover:bg-muted text-foreground hover:shadow-md"
                    }`}
                  >
                    {order === "newest" ? "Newest First" : "Oldest First"}
                  </button>
                ))}
              </div>
            </div>

            {/* Feed Loading Method */}
            <div
              className="bg-card/50 border border-border/30 rounded-xl p-5 space-y-4 relative backdrop-blur-sm"
              ref={tooltipRef}
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Feed Loading Method
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Speed vs completeness trade-off
                  </p>
                </div>
                <button
                  onClick={() => setShowFeedLoadingHelp(!showFeedLoadingHelp)}
                  className="text-muted-foreground hover:text-primary transition-colors"
                  title="Learn about feed loading methods"
                >
                  <HelpCircle size={18} />
                </button>
              </div>

              {showFeedLoadingHelp && (
                <div className="absolute right-0 top-16 z-50 bg-card/95 border border-border/50 rounded-xl shadow-2xl p-5 w-96 text-xs space-y-4 animate-in fade-in backdrop-blur-sm">
                  <p className="font-semibold text-sm text-foreground">
                    How Feed Loading Works
                  </p>
                  <div className="space-y-4">
                    <div>
                      <p className="font-medium text-foreground mb-1.5">
                        Default (Complete)
                      </p>
                      <p className="text-muted-foreground">
                        Fetches full channel data. Slower but includes all info.
                      </p>
                    </div>
                    <div className="border-t border-border/30 pt-4">
                      <p className="font-medium text-foreground mb-1.5">
                        Fast (RSS Feed)
                      </p>
                      <p className="text-muted-foreground">
                        Uses YouTube RSS. Much faster but limited info (~15
                        videos).
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                {(["standard", "rss"] as const).map((method) => (
                  <button
                    key={method}
                    onClick={() => setLocal({ ...local, fetchMethod: method })}
                    className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                      local.fetchMethod === method
                        ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                        : "bg-muted/60 hover:bg-muted text-foreground hover:shadow-md"
                    }`}
                  >
                    {method === "standard" ? "Complete" : "Fast"}
                  </button>
                ))}
              </div>
            </div>

            {/* Video Retention */}
            <div className="bg-card/50 border border-border/30 rounded-xl p-5 space-y-4 backdrop-blur-sm">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Keep Videos For
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  How far back your feed remembers videos, even after they drop
                  off YouTube&apos;s recent list
                </p>
              </div>
              <select
                value={videoRetentionDays === null ? "default" : videoRetentionDays}
                onChange={(e) =>
                  onRetentionChange?.(
                    e.target.value === "default"
                      ? null
                      : Number.parseInt(e.target.value, 10)
                  )
                }
                className="w-full px-3 py-2 bg-card border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-primary/50 transition-colors"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 0.75rem center",
                  paddingRight: "2rem",
                }}
              >
                <option value="default">
                  Use instance default (
                  {formatRetention(settings.videoRetentionDays)})
                </option>
                {RETENTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Videos are only deleted once no one subscribed to that channel
                wants them any more, so a longer window here always wins.
              </p>
            </div>

            {/* Video Player Mode */}
            <div className="bg-card/50 border border-border/30 rounded-xl p-5 space-y-4 backdrop-blur-sm">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Video Player
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Where to watch videos
                </p>
              </div>
              <div className="flex gap-2">
                {(["built-in", "new-tab"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() =>
                      setLocal({ ...local, videoPlayerMode: mode })
                    }
                    className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                      local.videoPlayerMode === mode
                        ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                        : "bg-muted/60 hover:bg-muted text-foreground hover:shadow-md"
                    }`}
                  >
                    {mode === "built-in" ? "Built-in" : "New Tab"}
                  </button>
                ))}
              </div>
            </div>

            {/* Watched threshold */}
            <div className="bg-card/50 border border-border/30 rounded-xl p-5 space-y-4 backdrop-blur-sm">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Mark as Watched
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  How far a video must play in the built-in player before it
                  counts as watched. Opening a video on YouTube marks it watched
                  right away.
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="watched-threshold"
                    className="text-xs text-muted-foreground"
                  >
                    Watched after
                  </label>
                  <span className="text-sm font-medium tabular-nums">
                    {watchedThresholdPercent}%
                  </span>
                </div>
                <input
                  id="watched-threshold"
                  type="range"
                  min={WATCHED_THRESHOLD_MIN}
                  max={WATCHED_THRESHOLD_MAX}
                  step={5}
                  value={watchedThresholdPercent}
                  onChange={(e) =>
                    onWatchedThresholdChange?.(Number(e.target.value))
                  }
                  className="w-full accent-primary cursor-pointer"
                />
                <p className="text-xs text-muted-foreground">
                  Measured by position in the video, so seeking past the mark
                  counts. Until then the thumbnail shows how far you got.
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
