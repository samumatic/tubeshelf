"use client";

import React, { useRef, useState } from "react";
import {
  X,
  Plus,
  Upload,
  Download,
  ChevronDown,
  Trash2,
  Shuffle,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface Subscription {
  id: string;
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
  const currentList = lists.find((l) => l.id === currentListId);
  const subscriptions = currentList?.subscriptions || [];

  const [input, setInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    try {
      const text = await file.text();
      // Detect format based on content
      const format = text.trim().startsWith("<") ? "opml" : "json";
      await onImport?.(text, format);
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
    setShowExportMenu(false);
    try {
      await onExport(format);
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

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="border-b border-border">
          <div className="flex items-center justify-between p-6 pb-4">
            <h2 className="text-xl font-bold">
              Subscriptions
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({subscriptions.length})
              </span>
            </h2>
            <Button
              onClick={onClose}
              variant="ghost"
              size="icon"
              className="h-8 w-8"
            >
              <X className="w-5 h-5" />
            </Button>
          </div>

          {/* List Selector & Actions */}
          <div className="px-6 pb-4">
            <div className="flex gap-2 items-start">
              {/* List Dropdown */}
              <div className="flex-1 relative">
                <select
                  value={currentListId}
                  onChange={(e) => onSelectList?.(e.target.value)}
                  className="w-full h-10 px-3 py-2 bg-secondary border border-border rounded-lg text-sm font-medium appearance-none cursor-pointer hover:bg-secondary/80 transition-colors pr-8"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "right 0.75rem center",
                  }}
                >
                  {[...lists]
                    .sort((a, b) =>
                      a.id === "default" ? -1 : b.id === "default" ? 1 : 0
                    )
                    .map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                      </option>
                    ))}
                </select>
              </div>

              {/* Action Buttons */}
              <Button
                onClick={() => setShowCreateList(!showCreateList)}
                variant="outline"
                size="icon"
                className="h-10 w-10 shrink-0"
                title="New list"
              >
                <Plus className="w-4 h-4" />
              </Button>

              <Button
                onClick={() => handleDeleteList(currentListId)}
                variant="outline"
                size="icon"
                className="h-10 w-10 shrink-0 text-destructive hover:bg-destructive/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                title={
                  currentList?.id === "default"
                    ? "Cannot delete default list"
                    : "Delete current list"
                }
                disabled={!currentList || currentList.id === "default"}
              >
                <Trash2 className="w-4 h-4" />
              </Button>

              <div className="relative">
                <Button
                  onClick={() => setShowExportMenu(!showExportMenu)}
                  variant="outline"
                  size="icon"
                  disabled={exporting}
                  title="Export subscriptions"
                  className="h-10 w-10 shrink-0"
                >
                  <Download className="w-4 h-4" />
                </Button>
                {showExportMenu && (
                  <div className="absolute right-0 mt-1 w-40 bg-card border border-border rounded-lg shadow-lg z-10 overflow-hidden">
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

              <Button
                onClick={() => fileInputRef.current?.click()}
                variant="outline"
                size="icon"
                disabled={importing}
                title="Import OPML or JSON"
                className="h-10 w-10 shrink-0"
              >
                <Upload className="w-4 h-4" />
              </Button>
            </div>

            {/* Create List Form */}
            {showCreateList && (
              <div className="mt-3 p-3 bg-secondary/50 rounded-lg border border-border">
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={newListName}
                    onChange={(e) => setNewListName(e.target.value)}
                    placeholder="New list name..."
                    className="text-sm h-9"
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
                    className="h-9"
                  >
                    Create
                  </Button>
                  <Button
                    onClick={() => setShowCreateList(false)}
                    variant="ghost"
                    size="sm"
                    className="h-9"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Add New */}
          <div className="mb-6">
            <label className="block text-sm font-medium mb-2">
              Add Channel
            </label>
            <div className="flex gap-2">
              <Input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Channel URL or ID..."
                className="flex-1 text-sm"
              />
              <Button
                onClick={handleAdd}
                disabled={loading}
                variant="default"
                size="icon"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            {error && <p className="text-xs text-destructive mt-2">{error}</p>}
          </div>

          {/* Import Info */}
          <div className="mb-4 p-3 bg-secondary/50 rounded text-xs text-muted-foreground">
            Import OPML files from other services or JSON files (Invidious
            format) using the upload button above.
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".opml,.xml,.json,text/xml,application/xml,application/json"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Search Subscriptions */}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">Search</label>
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by title or URL..."
              className="text-sm"
            />
          </div>

          {/* Subscriptions List */}
          <div className="space-y-3">
            {subscriptions
              .filter(
                (sub) =>
                  sub.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                  sub.url.toLowerCase().includes(searchQuery.toLowerCase())
              )
              .map((sub) => (
                <div
                  key={sub.id}
                  className="flex items-center gap-2 p-3 rounded border border-border hover:bg-secondary transition-colors"
                >
                  <a
                    href={sub.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 flex-1 min-w-0"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={
                        sub.thumbnail ||
                        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect fill='%23e5e7eb' width='100' height='100'/%3E%3Ccircle cx='50' cy='35' r='20' fill='%239ca3af'/%3E%3Cpath d='M 30 70 Q 30 60 50 60 Q 70 60 70 70 L 70 100 L 30 100 Z' fill='%239ca3af'/%3E%3C/svg%3E"
                      }
                      alt={sub.title}
                      className="w-10 h-10 rounded-full object-cover bg-secondary"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
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
                    </div>
                  </a>

                  {/* Move dropdown - only show if there are other lists */}
                  {lists.length > 1 && onMove && (
                    <div className="relative">
                      <Button
                        onClick={() =>
                          setMovingSubId(movingSubId === sub.id ? null : sub.id)
                        }
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-secondary"
                        title="Move to another list"
                      >
                        <Shuffle className="w-4 h-4" />
                      </Button>
                      {movingSubId === sub.id && (
                        <div className="absolute right-0 bottom-full mb-1 w-48 bg-card border border-border rounded-lg shadow-lg z-10 overflow-hidden">
                          <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border bg-secondary/30">
                            Move to another list
                          </div>
                          {lists
                            .filter((list) => list.id !== currentListId)
                            .map((list) => (
                              <button
                                key={list.id}
                                onClick={() => handleMove(sub.id, list.id)}
                                className="w-full text-left px-3 py-2 text-sm hover:bg-secondary transition-colors flex items-center gap-2"
                              >
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary"></span>
                                {list.name}
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                  )}

                  <Button
                    onClick={() => onRemove?.(sub.id)}
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:bg-destructive/10"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
          </div>

          {subscriptions.length === 0 && (
            <div className="text-center py-8">
              <p className="text-muted-foreground">No subscriptions yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Add a channel to get started
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border p-4 flex justify-end gap-2">
          <Button onClick={onClose} variant="outline" size="sm">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
