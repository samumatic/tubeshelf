"use client";

import React, { useRef, useState, useEffect } from "react";
import {
  X,
  Plus,
  Upload,
  Download,
  Trash2,
  Rss,
  FolderPlus,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const isDefaultListId = (id: string) =>
  id === "default" || id.startsWith("default-");

interface Subscription {
  id: string;
  channelId: string;
  title: string;
  thumbnail?: string;
  url: string;
  addedAt: string;
}

interface SubscriptionList {
  id: string;
  name: string;
  subscriptions: Subscription[];
}

interface SubscriptionManagerProps {
  lists: SubscriptionList[];
  currentListId: string;
  onSelectList?: (listId: string) => void;
  onCreateList?: (name: string) => Promise<void>;
  onDeleteList?: (listId: string) => Promise<void>;
  onAdd?: (url: string) => void;
  onRemove?: (id: string) => void;
  onMove?: (subscriptionId: string, targetListId: string) => Promise<void>;
  onImport?: (data: string, format?: string) => Promise<void> | void;
  onExport?: (format: "opml" | "json") => Promise<void> | void;
  isOpen: boolean;
  onClose: () => void;
}

export function SubscriptionManager({
  lists,
  currentListId,
  onSelectList,
  onCreateList,
  onDeleteList,
  onAdd,
  onRemove,
  onMove,
  onImport,
  onExport,
  isOpen,
  onClose,
}: SubscriptionManagerProps) {
  // Thumbnail cache for persistence
  const [thumbnailCache, setThumbnailCache] = useState<Record<string, string>>(
    {}
  );

  // Load thumbnail cache from localStorage on mount
  useEffect(() => {
    try {
      const cached = localStorage.getItem("subscriptionThumbnailCache");
      if (cached) {
        const parsed = JSON.parse(cached);
        setThumbnailCache(parsed);
      }
    } catch (err) {
      console.error("Failed to load thumbnail cache:", err);
    }
  }, []);

  // Save thumbnail cache to localStorage whenever it changes
  useEffect(() => {
    if (Object.keys(thumbnailCache).length > 0) {
      try {
        localStorage.setItem(
          "subscriptionThumbnailCache",
          JSON.stringify(thumbnailCache)
        );
      } catch (err) {
        console.error("Failed to save thumbnail cache:", err);
      }
    }
  }, [thumbnailCache]);

  // Ensure we always have a valid selected list
  const currentList = lists.find((l) => l.id === currentListId);
  const fallbackList = lists.length > 0 ? lists[0] : null;
  const displayedList = currentList || fallbackList;

  // If the provided currentListId is invalid but we have lists, auto-select the first
  React.useEffect(() => {
    if (!currentList && fallbackList && onSelectList) {
      onSelectList(fallbackList.id);
    }
  }, [currentListId, lists, currentList, fallbackList, onSelectList]);

  const subscriptions = displayedList?.subscriptions || [];

  // Merge cached thumbnails into subscriptions
  const subscriptionsWithCache = subscriptions.map((sub) => {
    const cached = thumbnailCache[sub.url];
    return {
      ...sub,
      thumbnail: cached || sub.thumbnail,
    };
  });

  const [input, setInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showCreateList, setShowCreateList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [movingSubId, setMovingSubId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAdd = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await onAdd?.(input);
      setInput("");
    } catch (err: any) {
      setError(err?.message || "Failed to add");
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setError(null);
    setSuccess(null);
    try {
      const text = await file.text();
      // Detect format based on content
      const format = text.trim().startsWith("<") ? "opml" : "json";
      // Guard against long-running imports (network stalls)
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Import timed out")), 20000)
      );
      await Promise.race([
        onImport?.(text, format) ?? Promise.resolve(),
        timeout,
      ]);
      setSuccess("Imported subscriptions successfully");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err?.message || "Failed to import");
    } finally {
      setImporting(false);
      event.target.value = "";
    }
  };

  const handleCreateList = async () => {
    if (!newListName.trim()) return;
    try {
      await onCreateList?.(newListName);
      setNewListName("");
      setShowCreateList(false);
    } catch (err: any) {
      setError(err?.message || "Failed to create list");
    }
  };

  const handleDeleteList = async (listId: string) => {
    if (confirm("Delete this list? This cannot be undone.")) {
      try {
        await onDeleteList?.(listId);
      } catch (err: any) {
        setError(err?.message || "Failed to delete list");
      }
    }
  };

  const handleExport = async (format: "opml" | "json") => {
    if (!onExport) return;
    setExporting(true);
    setError(null);
    setSuccess(null);
    setShowExportMenu(false);
    try {
      await onExport(format);
      setSuccess("Exported subscriptions successfully");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err?.message || "Failed to export");
    } finally {
      setExporting(false);
    }
  };

  const handleMove = async (subscriptionId: string, targetListId: string) => {
    if (!onMove) return;
    setError(null);
    try {
      await onMove(subscriptionId, targetListId);
      setMovingSubId(null);
    } catch (err: any) {
      setError(err?.message || "Failed to move subscription");
    }
  };

  if (!isOpen) return null;

  // Fallback if no lists exist (shouldn't happen, but provide safeguard)
  if (!displayedList) {
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md p-6 text-center">
          <h2 className="text-xl font-bold mb-4">Subscriptions</h2>
          <p className="text-muted-foreground mb-4">
            No lists available. Refresh the page.
          </p>
          <Button onClick={onClose} variant="outline" size="sm">
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="border-b border-border">
          <div className="flex items-center justify-between p-6 pb-4">
            <div className="flex items-center gap-3">
              <Rss className="w-6 h-6 text-primary" />
              <div>
                <h2 className="text-xl font-bold">
                  Subscriptions
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    ({subscriptions.length})
                  </span>
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Manage your channels
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-secondary rounded-lg transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* List Selector & Actions */}
          <div className="px-6 pb-4 space-y-3">
            {/* List Selection and Controls */}
            <div className="flex gap-2 items-center flex-wrap">
              {/* List Dropdown */}
              <div className="flex-1 min-w-64 relative">
                <select
                  value={displayedList?.id || ""}
                  onChange={(e) => onSelectList?.(e.target.value)}
                  className="w-full h-9 px-3 py-2 bg-card border border-border rounded-lg text-sm font-medium appearance-none cursor-pointer hover:border-primary/50 transition-colors"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "right 0.75rem center",
                    paddingRight: "2rem",
                  }}
                >
                  {[...lists]
                    .sort((a, b) =>
                      isDefaultListId(a.id) ? -1 : isDefaultListId(b.id) ? 1 : 0
                    )
                    .map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                      </option>
                    ))}
                </select>
              </div>

              {/* Action Buttons */}
              <button
                onClick={() => setShowCreateList(!showCreateList)}
                className="p-2 hover:bg-secondary rounded-lg transition-colors"
                title="New list"
              >
                <FolderPlus className="w-4 h-4" />
              </button>

              <button
                onClick={() =>
                  handleDeleteList(displayedList?.id || currentListId)
                }
                disabled={!displayedList || isDefaultListId(displayedList.id)}
                className="p-2 hover:bg-destructive/10 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition-colors text-destructive"
                title={
                  displayedList && isDefaultListId(displayedList.id)
                    ? "Cannot delete default list"
                    : "Delete current list"
                }
              >
                <Trash2 className="w-4 h-4" />
              </button>

              {/* Import button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="p-2 hover:bg-secondary disabled:opacity-50 rounded-lg transition-colors"
                title="Import OPML or JSON"
              >
                <Upload className="w-4 h-4" />
              </button>

              {/* Export menu */}
              <div className="relative">
                <button
                  onClick={() => setShowExportMenu(!showExportMenu)}
                  disabled={exporting}
                  className="p-2 hover:bg-secondary disabled:opacity-50 rounded-lg transition-colors"
                  title="Export subscriptions"
                >
                  <Download className="w-4 h-4" />
                </button>
                {showExportMenu && (
                  <div className="absolute right-0 top-full mt-1 w-40 bg-card border border-border rounded-lg shadow-lg z-10 overflow-hidden">
                    <button
                      onClick={() => handleExport("opml")}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-secondary transition-colors"
                    >
                      Export OPML
                    </button>
                    <button
                      onClick={() => handleExport("json")}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-secondary transition-colors"
                    >
                      Export JSON
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Create List Form */}
            {showCreateList && (
              <div className="p-3 bg-secondary/50 rounded-lg border border-border space-y-2">
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={newListName}
                    onChange={(e) => setNewListName(e.target.value)}
                    placeholder="New list name..."
                    className="text-sm h-8 flex-1"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateList();
                      else if (e.key === "Escape") setShowCreateList(false);
                    }}
                    autoFocus
                  />
                  <Button
                    onClick={handleCreateList}
                    variant="default"
                    size="sm"
                    className="h-8"
                  >
                    Create
                  </Button>
                  <Button
                    onClick={() => setShowCreateList(false)}
                    variant="outline"
                    size="sm"
                    className="h-8"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Messages */}
          {success && (
            <div className="p-3 rounded-lg bg-emerald-600/15 border border-emerald-600/30 text-emerald-500 text-sm">
              {success}
            </div>
          )}
          {error && (
            <div className="p-3 rounded-lg bg-destructive/15 border border-destructive/30 text-destructive text-sm">
              {error}
            </div>
          )}

          {/* Add New Subscription */}
          <div>
            <label className="block text-sm font-semibold mb-2">
              Add Channel
            </label>
            <div className="flex gap-2">
              <Input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                }}
                placeholder="Channel URL or ID..."
                className="flex-1 text-sm h-9"
              />
              <Button
                onClick={handleAdd}
                disabled={loading}
                variant="default"
                size="sm"
                className="h-9"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Search */}
          <div>
            <label className="block text-sm font-semibold mb-2">Search</label>
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by title or URL..."
              className="text-sm h-9"
            />
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".opml,.xml,.json,text/xml,application/xml,application/json"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Subscriptions List */}
          <div className="space-y-2">
            {subscriptionsWithCache
              .filter(
                (sub) =>
                  sub.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                  sub.url.toLowerCase().includes(searchQuery.toLowerCase())
              )
              .map((sub) => (
                <div
                  key={sub.channelId || sub.id}
                  className="group bg-card border border-border rounded-lg p-3 hover:border-primary/50 hover:shadow-md transition-all duration-200 flex items-center gap-3"
                >
                  {/* Thumbnail */}
                  <a
                    href={sub.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-shrink-0"
                  >
                    <div className="w-10 h-10 rounded-full bg-secondary overflow-hidden hover:scale-110 transition-transform duration-200">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={
                          sub.thumbnail
                            ? `/api/image-proxy?url=${encodeURIComponent(
                                sub.thumbnail
                              )}`
                            : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect fill='%23e5e7eb' width='100' height='100'/%3E%3Ccircle cx='50' cy='35' r='20' fill='%239ca3af'/%3E%3Cpath d='M 30 70 Q 30 60 50 60 Q 70 60 70 70 L 70 100 L 30 100 Z' fill='%239ca3af'/%3E%3C/svg%3E"
                        }
                        alt={sub.title}
                        className="w-10 h-10 rounded-full object-cover"
                        onLoad={(e) => {
                          if (sub.thumbnail && !thumbnailCache[sub.url]) {
                            setThumbnailCache((prev) => ({
                              ...prev,
                              [sub.url]: sub.thumbnail!,
                            }));
                          }
                        }}
                        onError={(e) => {
                          e.currentTarget.classList.add("opacity-50");
                        }}
                      />
                    </div>
                  </a>

                  {/* Content */}
                  <a
                    href={sub.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 min-w-0 hover:text-primary transition-colors"
                  >
                    <p className="font-semibold text-sm truncate group-hover:text-primary">
                      {sub.title}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      Added{" "}
                      {new Date(sub.addedAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </a>

                  {/* Actions */}
                  <div className="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {/* Move dropdown - only show if there are other lists */}
                    {lists.length > 1 && onMove && (
                      <div className="relative">
                        <button
                          onClick={() =>
                            setMovingSubId(
                              movingSubId === sub.channelId
                                ? null
                                : sub.channelId
                            )
                          }
                          className="p-2 rounded-md hover:bg-primary/10 transition-colors"
                          title="Move to another list"
                        >
                          <FolderPlus className="w-4 h-4 text-primary" />
                        </button>
                        {movingSubId === sub.channelId && (
                          <div className="absolute right-0 bottom-full mb-2 w-48 bg-card border border-border rounded-lg shadow-lg z-10 overflow-hidden">
                            <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border bg-secondary/30">
                              Move to list
                            </div>
                            {lists
                              .filter((list) => list.id !== currentListId)
                              .map((list) => (
                                <button
                                  key={list.id}
                                  onClick={() =>
                                    handleMove(sub.channelId, list.id)
                                  }
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-secondary transition-colors"
                                >
                                  {list.name}
                                </button>
                              ))}
                          </div>
                        )}
                      </div>
                    )}

                    <button
                      onClick={() => onRemove?.(sub.channelId)}
                      className="p-2 rounded-md hover:bg-destructive/10 transition-colors"
                      title="Remove subscription"
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </button>
                  </div>
                </div>
              ))}
          </div>

          {subscriptions.length === 0 && (
            <div className="text-center py-12">
              <Rss className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
              <p className="text-muted-foreground font-medium">
                No subscriptions yet
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Add a channel to get started
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-4 flex justify-end">
          <Button onClick={onClose} variant="outline" size="sm">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
