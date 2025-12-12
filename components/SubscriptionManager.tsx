"use client";

import React, { useRef, useState } from "react";
import { X, Plus, Upload, Download, ChevronDown } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface Subscription {
  id: string;
  title: string;
  thumbnail?: string;
  url: string;
  addedAt: string;
}

interface SubscriptionManagerProps {
  subscriptions: Subscription[];
  onAdd?: (url: string) => void;
  onRemove?: (id: string) => void;
  onImport?: (data: string, format?: string) => Promise<void> | void;
  onExport?: (format: "opml" | "json") => Promise<void> | void;
  isOpen: boolean;
  onClose: () => void;
}

export function SubscriptionManager({
  subscriptions,
  onAdd,
  onRemove,
  onImport,
  onExport,
  isOpen,
  onClose,
}: SubscriptionManagerProps) {
  const [input, setInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-bold">Manage Subscriptions</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Button
                onClick={() => setShowExportMenu(!showExportMenu)}
                variant="outline"
                size="sm"
                disabled={exporting}
                title="Export subscriptions"
                className="gap-1"
              >
                <Download className="w-4 h-4" />
                <ChevronDown className="w-3 h-3" />
              </Button>
              {showExportMenu && (
                <div className="absolute right-0 mt-1 w-40 bg-card border border-border rounded-md shadow-lg z-10">
                  <button
                    onClick={() => handleExport("opml")}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-secondary transition-colors rounded-t-md"
                  >
                    Export OPML
                  </button>
                  <button
                    onClick={() => handleExport("json")}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-secondary transition-colors rounded-b-md"
                  >
                    Export JSON
                  </button>
                </div>
              )}
            </div>
            <Button
              onClick={() => fileInputRef.current?.click()}
              variant="secondary"
              size="icon"
              disabled={importing}
              title="Import OPML or TubeShelf export"
            >
              <Upload className="w-4 h-4" />
            </Button>
            <Button
              onClick={onClose}
              variant="ghost"
              size="icon"
              className="h-8 w-8"
            >
              <X className="w-5 h-5" />
            </Button>
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
                  className="flex items-center gap-3 p-3 rounded border border-border hover:bg-secondary transition-colors"
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
