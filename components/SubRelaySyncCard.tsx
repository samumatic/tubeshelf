"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

interface SubRelaySyncSettings {
  url: string;
  hasApiKey: boolean;
  syncWatched: boolean;
  lastSyncAt: string | null;
  lastStatus: "success" | "partial" | "error" | null;
  lastMessage: string | null;
}

interface SubRelaySyncCardProps {
  onShowToast?: (message: string, type: "success" | "error" | "info") => void;
}

/** Fired after a sync so the feed can reload subscriptions and watched state. */
export const SUBRELAY_SYNCED_EVENT = "tubeshelf:subrelay-synced";

const STATUS_STYLES: Record<string, string> = {
  success: "text-green-500",
  partial: "text-yellow-500",
  error: "text-red-500",
};

export function SubRelaySyncCard({ onShowToast }: SubRelaySyncCardProps) {
  const [settings, setSettings] = useState<SubRelaySyncSettings | null>(null);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [syncWatched, setSyncWatched] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const toastRef = useRef(onShowToast);
  useEffect(() => {
    toastRef.current = onShowToast;
  }, [onShowToast]);

  const applySettings = (next: SubRelaySyncSettings) => {
    setSettings(next);
    setUrl(next.url);
    setSyncWatched(next.syncWatched);
  };

  const loadSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/subrelay-sync");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to load SubRelay sync settings");
      applySettings(data);
    } catch (error: any) {
      toastRef.current?.(error?.message || "Failed to load SubRelay sync settings", "error");
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const save = async (extra: { clearApiKey?: boolean } = {}) => {
    setSaving(true);
    try {
      const response = await fetch("/api/subrelay-sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, syncWatched, apiKey: apiKey.trim(), ...extra }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to save SubRelay sync settings");
      applySettings(data);
      setApiKey("");
      toastRef.current?.(extra.clearApiKey ? "SubRelay API key removed" : "SubRelay sync settings saved", "success");
      return true;
    } catch (error: any) {
      toastRef.current?.(error?.message || "Failed to save SubRelay sync settings", "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const hasUnsavedChanges =
    !!settings &&
    (url.trim() !== settings.url || syncWatched !== settings.syncWatched || apiKey.trim() !== "");

  const syncNow = async () => {
    if (hasUnsavedChanges && !(await save())) return;
    setSyncing(true);
    try {
      const response = await fetch("/api/subrelay-sync", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (data.settings) applySettings(data.settings);
      if (!response.ok) throw new Error(data.error || "Sync failed");

      const result = data.result;
      window.dispatchEvent(new CustomEvent(SUBRELAY_SYNCED_EVENT));
      toastRef.current?.(
        result.status === "success" ? "Synced with SubRelay" : "Synced with SubRelay, with warnings",
        result.status === "success" ? "success" : "info"
      );
    } catch (error: any) {
      toastRef.current?.(error?.message || "Sync failed", "error");
    } finally {
      setSyncing(false);
    }
  };

  const canSync = !!url.trim() && (settings?.hasApiKey || !!apiKey.trim());

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <h3 className="text-xl font-semibold mb-2 flex items-center gap-2">
        <RefreshCw className="w-5 h-5" />
        Sync with SubRelay
      </h3>
      <p className="text-sm text-muted-foreground mb-6">
        Keep your subscriptions and watched videos in step with SubRelay. Lists sync as SubRelay
        channel groups. Syncing only ever adds - nothing is removed on either side.
      </p>

      <div className="space-y-4">
        <div>
          <label htmlFor="subrelay-url" className="block text-sm font-medium mb-2">
            SubRelay URL
          </label>
          <input
            id="subrelay-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://subrelay:5173"
            className="w-full px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <div>
          <label htmlFor="subrelay-api-key" className="block text-sm font-medium mb-2">
            SubRelay API key
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id="subrelay-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings?.hasApiKey ? "Saved - paste a new key to replace it" : "Paste a SubRelay API key"}
              className="flex-1 min-w-0 px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {settings?.hasApiKey && (
              <button
                type="button"
                onClick={() => {
                  if (confirm("Remove the saved SubRelay API key?")) save({ clearApiKey: true });
                }}
                disabled={saving}
                className="px-3 py-2 rounded border border-border hover:bg-muted text-sm disabled:opacity-50"
              >
                Remove key
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Create one in SubRelay under Settings → API keys. Use an admin user&apos;s key to sync
            both ways; any other key can only pull. Changing to a different SubRelay host removes a
            saved key.
          </p>
        </div>

        <label className="flex items-center justify-between gap-4 text-sm">
          <span>
            <strong className="block">Sync watched videos</strong>
            <span className="text-muted-foreground">Share which videos you&apos;ve watched with SubRelay.</span>
          </span>
          <input
            type="checkbox"
            checked={syncWatched}
            onChange={(e) => setSyncWatched(e.target.checked)}
            className="h-4 w-4"
          />
        </label>

        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={() => save()}
            disabled={saving || syncing || !hasUnsavedChanges}
            className="px-4 py-2 rounded-lg border border-border hover:bg-muted font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing || saving || !canSync}
            className="bg-primary hover:bg-primary/90 text-primary-foreground py-2 px-4 rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync now"}
          </button>
        </div>

        {settings?.lastSyncAt && (
          <div className="text-sm border-t border-border pt-4">
            <p>
              Last sync {new Date(settings.lastSyncAt).toLocaleString()}:{" "}
              <strong className={STATUS_STYLES[settings.lastStatus ?? ""] ?? ""}>
                {settings.lastStatus === "partial" ? "completed with warnings" : settings.lastStatus}
              </strong>
            </p>
            {settings.lastMessage && (
              <p className="text-muted-foreground mt-1">{settings.lastMessage}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
