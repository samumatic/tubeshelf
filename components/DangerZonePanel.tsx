"use client";

import React, { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";

interface DangerZonePanelProps {
  onDeleteSubscriptions?: (listId?: string) => Promise<void>;
  onClearWatchHistory?: () => Promise<void>;
  onResetSettings?: () => Promise<void>;
  onClearVideoCache?: () => Promise<void>;
  onDeleteAccount?: () => Promise<void>;
  subscriptionLists?: Array<{ id: string; name: string }>;
  currentListId?: string;
  onShowToast?: (message: string, type: "success" | "error") => void;
}

export function DangerZonePanel({
  onDeleteSubscriptions,
  onClearWatchHistory,
  onResetSettings,
  onClearVideoCache,
  onDeleteAccount,
  subscriptionLists = [],
  currentListId,
  onShowToast,
}: DangerZonePanelProps) {
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<"all" | string>("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDangerAction = async (
    action: "subscriptions" | "history" | "settings" | "videoCache" | "account"
  ) => {
    setSaving(true);
    setError(null);
    try {
      if (action === "subscriptions") {
        const targetListId = deleteTarget === "all" ? undefined : deleteTarget;
        await onDeleteSubscriptions?.(targetListId);
        onShowToast?.(
          deleteTarget === "all"
            ? "All subscriptions deleted successfully"
            : "Subscriptions deleted from list successfully",
          "success"
        );
      } else if (action === "history") {
        await onClearWatchHistory?.();
        onShowToast?.("Watch history cleared successfully", "success");
      } else if (action === "settings") {
        await onResetSettings?.();
        onShowToast?.("Settings reset to default successfully", "success");
      } else if (action === "videoCache") {
        await onClearVideoCache?.();
        onShowToast?.(
          "Video cache cleared - your subscriptions will refetch fresh",
          "success"
        );
      } else if (action === "account") {
        await onDeleteAccount?.();
        onShowToast?.(
          "Account deleted successfully. Redirecting...",
          "success"
        );
        // Redirect to login after a short delay
        setTimeout(() => {
          window.location.href = "/login";
        }, 2000);
      }
      setConfirmAction(null);
    } catch (err: any) {
      const errorMsg = err?.message || "Failed to complete action";
      setError(errorMsg);
      onShowToast?.(errorMsg, "error");
    } finally {
      setSaving(false);
    }
  };

  if (confirmAction) {
    return (
      <div className="space-y-6">
        <div className="space-y-4">
          <div className="flex items-start gap-4 p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
            <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold text-sm">
                {confirmAction === "subscriptions"
                  ? "Delete Subscriptions"
                  : confirmAction === "history"
                  ? "Clear Watch History"
                  : confirmAction === "settings"
                  ? "Reset Settings"
                  : confirmAction === "videoCache"
                  ? "Clear Video Cache"
                  : "Delete Account"}
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                {confirmAction === "subscriptions"
                  ? deleteTarget === "all"
                    ? "This will permanently remove all your subscriptions from all lists. This action cannot be undone."
                    : "This will permanently remove all your subscriptions from the selected list. This action cannot be undone."
                  : confirmAction === "history"
                  ? "This will permanently clear all your watched/unwatched video states. This action cannot be undone."
                  : confirmAction === "settings"
                  ? "Your settings will be reset to default values. Your subscriptions and watch history will not be affected."
                  : confirmAction === "videoCache"
                  ? "This clears the cached video data for every channel you're subscribed to, so they refetch from scratch. Useful if videos are stuck showing wrong durations or dates. Since the cache is shared, this also affects other users subscribed to the same channels - it doesn't touch your subscriptions, watch history, or watch later."
                  : "This will permanently delete your account and all associated data including subscriptions, watch history, and settings. This action cannot be undone. You will be logged out immediately."}
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

          {error && (
            <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-xl text-sm text-destructive">
              {error}
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
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                handleDangerAction(
                  confirmAction as
                    | "subscriptions"
                    | "history"
                    | "settings"
                    | "videoCache"
                )
              }
              variant="destructive"
              size="sm"
              disabled={saving}
            >
              {saving ? "Processing..." : "Confirm"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Dangerous operations that can permanently delete your data
      </p>

      <div className="space-y-3">
        <button
          onClick={() => setConfirmAction("history")}
          className="w-full bg-destructive/5 border border-destructive/20 hover:border-destructive/40 hover:bg-destructive/10 rounded-xl p-4 text-left transition-all duration-200"
        >
          <p className="font-semibold text-sm text-destructive">
            Clear Watch History
          </p>
          <p className="text-xs text-muted-foreground mt-1.5">
            Delete all watched/unwatched video states permanently
          </p>
        </button>

        <button
          onClick={() => setConfirmAction("subscriptions")}
          className="w-full bg-destructive/5 border border-destructive/20 hover:border-destructive/40 hover:bg-destructive/10 rounded-xl p-4 text-left transition-all duration-200"
        >
          <p className="font-semibold text-sm text-destructive">
            Delete All Subscriptions
          </p>
          <p className="text-xs text-muted-foreground mt-1.5">
            Remove all your channel subscriptions permanently
          </p>
        </button>

        <button
          onClick={() => setConfirmAction("settings")}
          className="w-full bg-destructive/5 border border-destructive/20 hover:border-destructive/40 hover:bg-destructive/10 rounded-xl p-4 text-left transition-all duration-200"
        >
          <p className="font-semibold text-sm text-destructive">
            Reset Settings
          </p>
          <p className="text-xs text-muted-foreground mt-1.5">
            Restore all settings to default values
          </p>
        </button>

        <button
          onClick={() => setConfirmAction("videoCache")}
          className="w-full bg-destructive/5 border border-destructive/20 hover:border-destructive/40 hover:bg-destructive/10 rounded-xl p-4 text-left transition-all duration-200"
        >
          <p className="font-semibold text-sm text-destructive">
            Clear Video Cache
          </p>
          <p className="text-xs text-muted-foreground mt-1.5">
            Refetch cached video data for your subscribed channels from
            scratch
          </p>
        </button>

        <button
          onClick={() => setConfirmAction("account")}
          className="w-full bg-red-950/30 border border-red-700/40 hover:border-red-600/60 hover:bg-red-950/50 rounded-xl p-4 text-left transition-all duration-200"
        >
          <p className="font-semibold text-sm text-red-600 dark:text-red-400">
            Delete Account
          </p>
          <p className="text-xs text-muted-foreground mt-1.5">
            Permanently delete your account and all associated data
          </p>
        </button>
      </div>
    </div>
  );
}
