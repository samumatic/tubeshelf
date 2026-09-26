"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, KeyRound, Trash2 } from "lucide-react";

interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ApiKeysCardProps {
  onShowToast?: (message: string, type: "success" | "error" | "info") => void;
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export function ApiKeysCard({ onShowToast }: ApiKeysCardProps) {
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  // Parents often pass an inline toast callback; reading it through a ref
  // keeps loadKeys stable so the initial load doesn't re-run on every render.
  const toastRef = useRef(onShowToast);
  useEffect(() => {
    toastRef.current = onShowToast;
  }, [onShowToast]);

  const loadKeys = useCallback(async () => {
    try {
      const response = await fetch("/api/user/api-keys");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to load API keys");
      setApiKeys(data.apiKeys || []);
    } catch (error: any) {
      toastRef.current?.(error?.message || "Failed to load API keys", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      onShowToast?.("Give the key a name, e.g. SubRelay", "error");
      return;
    }
    setCreating(true);
    try {
      const response = await fetch("/api/user/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to create API key");
      setNewKey({ name: data.apiKey.name, key: data.key });
      setName("");
      await loadKeys();
    } catch (error: any) {
      onShowToast?.(error?.message || "Failed to create API key", "error");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (apiKey: ApiKeySummary) => {
    if (
      !confirm(
        `Revoke "${apiKey.name}"? Anything using this key will stop working immediately.`
      )
    ) {
      return;
    }
    setRevokingId(apiKey.id);
    try {
      const response = await fetch(
        `/api/user/api-keys?id=${encodeURIComponent(apiKey.id)}`,
        { method: "DELETE" }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to revoke API key");
      onShowToast?.(`Revoked ${apiKey.name}`, "success");
      await loadKeys();
    } catch (error: any) {
      onShowToast?.(error?.message || "Failed to revoke API key", "error");
    } finally {
      setRevokingId(null);
    }
  };

  const copyNewKey = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey.key);
      onShowToast?.("API key copied", "success");
    } catch {
      onShowToast?.("Copy failed - select the key and copy it manually", "error");
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <h3 className="text-xl font-semibold mb-2 flex items-center gap-2">
        <KeyRound className="w-5 h-5" />
        API Keys
      </h3>
      <p className="text-sm text-muted-foreground mb-6">
        Let other tools, like SubRelay, read and sync your subscriptions and
        lists. Keys only work for subscription endpoints - they can&apos;t
        change your account or settings. Send one as{" "}
        <code className="text-xs">Authorization: Bearer &lt;key&gt;</code>.
      </p>

      {newKey && (
        <div className="mb-6 rounded-lg border border-green-500/30 bg-green-500/10 p-4 space-y-3">
          <p className="text-sm">
            <strong>{newKey.name}</strong> created. Copy it now - you won&apos;t
            be able to see it again.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={newKey.key}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="New API key"
              className="flex-1 min-w-0 px-3 py-2 bg-background border border-border rounded font-mono text-xs"
            />
            <button
              type="button"
              onClick={copyNewKey}
              className="px-3 py-2 rounded border border-border hover:bg-muted flex items-center gap-1 text-sm"
            >
              <Copy className="w-4 h-4" />
              Copy
            </button>
          </div>
          <button
            type="button"
            onClick={() => setNewKey(null)}
            className="text-xs text-muted-foreground underline"
          >
            I&apos;ve saved it
          </button>
        </div>
      )}

      <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-2 mb-6">
        <input
          type="text"
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name, e.g. SubRelay"
          aria-label="API key name"
          className="flex-1 min-w-0 px-3 py-2 bg-background border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          type="submit"
          disabled={creating}
          className="bg-primary hover:bg-primary/90 text-primary-foreground py-2 px-4 rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? "Creating..." : "Create key"}
        </button>
      </form>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading keys...</p>
      ) : apiKeys.length === 0 ? (
        <p className="text-sm text-muted-foreground">No API keys yet.</p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg">
          {apiKeys.map((apiKey) => (
            <li
              key={apiKey.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3"
            >
              <div className="min-w-0">
                <p className="font-medium truncate">{apiKey.name}</p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{apiKey.prefix}…</span> · Created{" "}
                  {formatDate(apiKey.createdAt)} · Last used{" "}
                  {formatDate(apiKey.lastUsedAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleRevoke(apiKey)}
                disabled={revokingId === apiKey.id}
                className="self-start sm:self-auto px-3 py-1.5 rounded border border-red-500/40 text-red-500 hover:bg-red-500/10 text-sm flex items-center gap-1 disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                {revokingId === apiKey.id ? "Revoking..." : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
