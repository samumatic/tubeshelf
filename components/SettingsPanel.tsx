"use client";

import React, { useState } from "react";
import { X, AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import type { AppSettings } from "@/lib/settingsStore";

interface SettingsPanelProps {
  settings: AppSettings;
  onSave?: (settings: Partial<AppSettings>) => void;
  onDeleteSubscriptions?: () => Promise<void>;
  onClearWatchHistory?: () => Promise<void>;
  onResetSettings?: () => Promise<void>;
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsPanel({
  settings,
  onSave,
  onDeleteSubscriptions,
  onClearWatchHistory,
  onResetSettings,
  isOpen,
  onClose,
}: SettingsPanelProps) {
  const [local, setLocal] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave?.(local);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleDangerAction = async (
    action: "subscriptions" | "history" | "settings"
  ) => {
    setSaving(true);
    setError(null);
    try {
      if (action === "subscriptions") await onDeleteSubscriptions?.();
      else if (action === "history") await onClearWatchHistory?.();
      else if (action === "settings") await onResetSettings?.();
      setConfirmAction(null);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to complete action");
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-bold">Settings</h2>
          <Button
            onClick={onClose}
            variant="ghost"
            size="icon"
            className="h-8 w-8"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {confirmAction ? (
            // Confirmation Dialog
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-destructive/10 rounded-lg border border-destructive/20">
                <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0" />
                <div>
                  <p className="font-semibold text-sm">
                    {confirmAction === "subscriptions"
                      ? "Delete all subscriptions?"
                      : confirmAction === "history"
                      ? "Clear all watch history?"
                      : "Reset all settings to defaults?"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {confirmAction === "subscriptions"
                      ? "This will remove all subscriptions. This action cannot be undone."
                      : confirmAction === "history"
                      ? "This will clear all watched/unwatched states. This action cannot be undone."
                      : "All settings will be reset to their default values. This action cannot be undone."}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  onClick={() => setConfirmAction(null)}
                  variant="outline"
                  size="sm"
                  disabled={saving}
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
                  disabled={saving}
                >
                  {saving ? "Deleting..." : "Delete"}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* Normal Settings */}
              {/* Default Sort Order */}
              <div className="space-y-2">
                <label className="block text-sm font-medium">
                  Default Sort
                </label>
                <div className="flex gap-2">
                  {(["newest", "oldest"] as const).map((order) => (
                    <button
                      key={order}
                      onClick={() =>
                        setLocal({ ...local, defaultSortOrder: order })
                      }
                      className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                        local.defaultSortOrder === order
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary hover:bg-secondary/80"
                      }`}
                    >
                      {order.charAt(0).toUpperCase() + order.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Theme */}
              <div className="space-y-2">
                <label className="block text-sm font-medium">Theme</label>
                <div className="flex gap-2">
                  {(["light", "dark", "system"] as const).map((theme) => (
                    <button
                      key={theme}
                      onClick={() => setLocal({ ...local, theme })}
                      className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
                        local.theme === theme
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary hover:bg-secondary/80"
                      }`}
                    >
                      {theme.charAt(0).toUpperCase() + theme.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              {/* Danger Zone */}
              <div className="border-t pt-6">
                <div className="flex items-center gap-2 mb-4">
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                  <h3 className="font-semibold text-sm text-destructive">
                    Danger Zone
                  </h3>
                </div>
                <div className="space-y-2">
                  <button
                    onClick={() => setConfirmAction("history")}
                    className="w-full px-4 py-2 text-left text-sm rounded border border-destructive/30 hover:bg-destructive/10 transition-colors"
                  >
                    <p className="font-medium text-destructive">
                      Clear Watch History
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Delete all watched/unwatched states
                    </p>
                  </button>
                  <button
                    onClick={() => setConfirmAction("subscriptions")}
                    className="w-full px-4 py-2 text-left text-sm rounded border border-destructive/30 hover:bg-destructive/10 transition-colors"
                  >
                    <p className="font-medium text-destructive">
                      Delete All Subscriptions
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Remove all channels
                    </p>
                  </button>
                  <button
                    onClick={() => setConfirmAction("settings")}
                    className="w-full px-4 py-2 text-left text-sm rounded border border-destructive/30 hover:bg-destructive/10 transition-colors"
                  >
                    <p className="font-medium text-destructive">
                      Reset All Settings
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Restore default settings
                    </p>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-4 flex justify-end gap-2">
          <Button onClick={onClose} variant="outline" size="sm">
            Cancel
          </Button>
          {!confirmAction && (
            <Button onClick={handleSave} disabled={saving} size="sm">
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
