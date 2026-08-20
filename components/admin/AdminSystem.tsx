"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import {
  Shield,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Lock,
  Users,
} from "lucide-react";
import { RETENTION_OPTIONS, defaultSettings } from "@/lib/settingsSchema";

type FeedSettings = {
  videoRetentionDays: number;
  feedConcurrency: number;
  feedChannelTimeoutSeconds: number;
  feedRequestTimeoutSeconds: number;
  feedRefreshMinutes: number;
  feedErrorRetryMinutes: number;
};

const FEED_SETTING_FIELDS: Array<{
  key: keyof Omit<FeedSettings, "videoRetentionDays">;
  label: string;
  hint: string;
}> = [
  {
    key: "feedConcurrency",
    label: "Parallel channel fetches",
    hint: "Higher is faster, but hits YouTube harder",
  },
  {
    key: "feedChannelTimeoutSeconds",
    label: "Channel timeout (seconds)",
    hint: "Give up on a single channel after this long",
  },
  {
    key: "feedRequestTimeoutSeconds",
    label: "Request timeout (seconds)",
    hint: "Answer from the cache after this long; the refresh keeps running",
  },
  {
    key: "feedRefreshMinutes",
    label: "Refresh channels every (minutes)",
    hint: "Minimum age before a channel is fetched again",
  },
  {
    key: "feedErrorRetryMinutes",
    label: "Retry failed channels after (minutes)",
    hint: "Shorter retry for channels whose last fetch failed",
  },
];

const defaultFeedSettings: FeedSettings = {
  videoRetentionDays: defaultSettings.videoRetentionDays,
  feedConcurrency: defaultSettings.feedConcurrency,
  feedChannelTimeoutSeconds: defaultSettings.feedChannelTimeoutSeconds,
  feedRequestTimeoutSeconds: defaultSettings.feedRequestTimeoutSeconds,
  feedRefreshMinutes: defaultSettings.feedRefreshMinutes,
  feedErrorRetryMinutes: defaultSettings.feedErrorRetryMinutes,
};

export function AdminSystem() {
  const { user, loading } = useAuth();
  const [oidcOnly, setOidcOnly] = useState(false);
  const [publicRegistration, setPublicRegistration] = useState(false);
  const [feedSettings, setFeedSettings] =
    useState<FeedSettings>(defaultFeedSettings);
  const [savingFeedSettings, setSavingFeedSettings] = useState(false);
  const [hasOIDCProvider, setHasOIDCProvider] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [lastSavedOidcOnly, setLastSavedOidcOnly] = useState<boolean>(false);
  const [lastSavedPublicReg, setLastSavedPublicReg] = useState<boolean>(false);

  useEffect(() => {
    loadSettings();
  }, []);

  // Auto-save when oidcOnly or publicRegistration changes
  useEffect(() => {
    const oidcChanged = oidcOnly !== lastSavedOidcOnly;
    const regChanged = publicRegistration !== lastSavedPublicReg;

    if (!oidcChanged && !regChanged) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        setMessage(null);
        const response = await fetch("/api/admin/system-settings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            oidcOnly,
            publicRegistration,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          setMessage({
            type: "error",
            message: data.error || "Failed to save settings",
          });
          // On error, reload to get the actual state from server
          setTimeout(() => {
            loadSettings();
          }, 500);
          return;
        }

        setMessage({ type: "success", message: "Settings saved" });
        setLastSavedOidcOnly(oidcOnly);
        setLastSavedPublicReg(publicRegistration);
        // Clear success message after 2 seconds
        setTimeout(() => {
          setMessage(null);
        }, 2000);
      } catch (error) {
        setMessage({
          type: "error",
          message: "An error occurred while saving",
        });
        console.error("Auto-save error:", error);
        // On error, reload to get the actual state from server
        setTimeout(() => {
          loadSettings();
        }, 500);
      }
    }, 500); // 500ms debounce

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [oidcOnly, publicRegistration, lastSavedOidcOnly, lastSavedPublicReg]);

  const loadSettings = async () => {
    try {
      const [settingsRes, oidcRes] = await Promise.all([
        fetch("/api/admin/system-settings"),
        fetch("/api/admin/oidc-providers"),
      ]);

      const [settingsData, oidcData] = await Promise.all([
        settingsRes.json(),
        oidcRes.json(),
      ]);

      setOidcOnly(settingsData.oidcOnly || false);
      setPublicRegistration(settingsData.publicRegistration || false);
      setFeedSettings({
        videoRetentionDays:
          settingsData.videoRetentionDays ??
          defaultFeedSettings.videoRetentionDays,
        feedConcurrency:
          settingsData.feedConcurrency ?? defaultFeedSettings.feedConcurrency,
        feedChannelTimeoutSeconds:
          settingsData.feedChannelTimeoutSeconds ??
          defaultFeedSettings.feedChannelTimeoutSeconds,
        feedRequestTimeoutSeconds:
          settingsData.feedRequestTimeoutSeconds ??
          defaultFeedSettings.feedRequestTimeoutSeconds,
        feedRefreshMinutes:
          settingsData.feedRefreshMinutes ??
          defaultFeedSettings.feedRefreshMinutes,
        feedErrorRetryMinutes:
          settingsData.feedErrorRetryMinutes ??
          defaultFeedSettings.feedErrorRetryMinutes,
      });
      setLastSavedOidcOnly(settingsData.oidcOnly || false);
      setLastSavedPublicReg(settingsData.publicRegistration || false);
      setHasOIDCProvider(
        !!(
          oidcData.providers &&
          oidcData.providers.length > 0 &&
          oidcData.providers.some((p: any) => p.enabled)
        )
      );
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setLoadingSettings(false);
    }
  };

  const saveFeedSettings = async () => {
    setSavingFeedSettings(true);
    try {
      setMessage(null);
      const response = await fetch("/api/admin/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedSettings),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({
          type: "error",
          message: data.error || "Failed to save settings",
        });
        return;
      }

      setMessage({ type: "success", message: "Feed settings saved" });
      setTimeout(() => setMessage(null), 2000);
      await loadSettings();
    } catch (error) {
      console.error("Failed to save feed settings:", error);
      setMessage({ type: "error", message: "An error occurred while saving" });
    } finally {
      setSavingFeedSettings(false);
    }
  };

  const handleToggle = (checked: boolean) => {
    if (checked && !hasOIDCProvider) {
      setMessage({
        type: "error",
        message: "Please configure an OIDC provider first",
      });
      return;
    }
    setOidcOnly(checked);
  };

  if (loadingSettings) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (!user?.isAdmin) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <h2 className="text-2xl sm:text-3xl font-bold">System Settings</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Configure system-wide security and authentication settings
      </p>

      {/* Settings Card */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-6">Authentication Settings</h2>

        {/* Warning if OIDC not configured */}
        {!hasOIDCProvider && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4 mb-6 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-yellow-500">
                OIDC Provider Required
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                You must configure and enable an OIDC provider before disabling
                password login to prevent being locked out.
              </p>
            </div>
          </div>
        )}

        {/* OIDC-Only Login */}
        <div
          className={`rounded-lg p-6 border-2 transition-all mb-6 ${
            oidcOnly
              ? "bg-blue-500/5 border-blue-500/50"
              : "bg-card border-border"
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                {oidcOnly && (
                  <Lock className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                )}
                <label className="block text-lg font-semibold">
                  OIDC-Only Login
                </label>
                {oidcOnly && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/30 text-blue-700 dark:text-blue-400 border border-blue-500/40">
                    <CheckCircle className="w-3 h-3" />
                    Enabled
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                When enabled, users can only authenticate via OIDC provider.
                Local password login will be hidden from the login page.
              </p>
              {hasOIDCProvider && (
                <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1 mt-2">
                  <CheckCircle className="w-3.5 h-3.5" />
                  OIDC provider is configured and enabled
                </p>
              )}
            </div>

            {/* Toggle Switch */}
            <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={oidcOnly}
                onChange={(e) => handleToggle(e.target.checked)}
                disabled={!hasOIDCProvider}
              />
              <div className="w-14 h-8 bg-gray-300 dark:bg-gray-600 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-500/30 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:start-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-blue-600 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed"></div>
            </label>
          </div>
        </div>

        {/* Public Registration */}
        <div
          className={`rounded-lg p-6 border-2 transition-all mb-6 ${
            publicRegistration
              ? "bg-green-500/5 border-green-500/50"
              : "bg-card border-border"
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                {publicRegistration && (
                  <Users className="w-5 h-5 text-green-600 dark:text-green-400" />
                )}
                <label className="block text-lg font-semibold">
                  Public Registration
                </label>
                {publicRegistration && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-500/30 text-green-700 dark:text-green-400 border border-green-500/40">
                    <CheckCircle className="w-3 h-3" />
                    Enabled
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                When enabled, new users can register accounts without an
                invitation. By default, registration is disabled after admin
                setup for security.
              </p>
            </div>

            {/* Toggle Switch */}
            <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={publicRegistration}
                onChange={(e) => setPublicRegistration(e.target.checked)}
              />
              <div className="w-14 h-8 bg-gray-300 dark:bg-gray-600 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-green-500/30 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:start-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-green-600"></div>
            </label>
          </div>
        </div>

        {/* Message */}
        {message && (
          <div
            className={`rounded-lg p-4 mb-6 border ${
              message.type === "success"
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
                : "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400"
            }`}
          >
            <div className="flex items-center gap-2">
              {message.type === "success" ? (
                <CheckCircle className="w-5 h-5 flex-shrink-0" />
              ) : (
                <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              )}
              <p className="text-sm font-medium">{message.message}</p>
            </div>
          </div>
        )}
      </div>

      {/* Feed & video cache */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-2">Feed &amp; Video Cache</h2>
        <p className="text-sm text-muted-foreground mb-6">
          Instance-wide fetch behaviour and the default retention window. Users
          can pick their own retention in their settings; a video is only
          deleted once nobody subscribed to that channel still wants it.
        </p>

        <div className="mb-6">
          <label className="block text-sm font-medium mb-1">
            Keep videos for (default)
          </label>
          <p className="text-xs text-muted-foreground mb-2">
            Applies to every user who has not chosen their own window
          </p>
          <select
            value={feedSettings.videoRetentionDays}
            onChange={(e) =>
              setFeedSettings({
                ...feedSettings,
                videoRetentionDays: Number.parseInt(e.target.value, 10),
              })
            }
            className="w-full max-w-xs px-3 py-2 bg-background border border-border rounded-lg text-sm"
          >
            {RETENTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {FEED_SETTING_FIELDS.map((field) => (
            <div key={field.key}>
              <label className="block text-sm font-medium mb-1">
                {field.label}
              </label>
              <p className="text-xs text-muted-foreground mb-2">{field.hint}</p>
              <input
                type="number"
                value={feedSettings[field.key]}
                onChange={(e) =>
                  setFeedSettings({
                    ...feedSettings,
                    [field.key]: e.target.value === "" ? 0 : Number(e.target.value),
                  })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              />
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={saveFeedSettings}
            disabled={savingFeedSettings}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground disabled:opacity-50"
          >
            {savingFeedSettings ? "Saving..." : "Save feed settings"}
          </button>
          <button
            onClick={() => setFeedSettings(defaultFeedSettings)}
            disabled={savingFeedSettings}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-muted hover:bg-muted/80 disabled:opacity-50"
          >
            Reset to defaults
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Out-of-range values are clamped when saved.
        </p>
      </div>
    </div>
  );
}
