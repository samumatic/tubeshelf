"use client";

import React, { useState } from "react";
import { X, Plus } from "lucide-react";
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
  isOpen: boolean;
  onClose: () => void;
}

export function SubscriptionManager({
  subscriptions,
  onAdd,
  onRemove,
  isOpen,
  onClose,
}: SubscriptionManagerProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-bold">Manage Subscriptions</h2>
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
            {error && (
              <p className="text-xs text-destructive mt-2">{error}</p>
            )}
          </div>

          {/* Subscriptions List */}
          <div className="space-y-3">
            {subscriptions.map((sub) => (
              <div
                key={sub.id}
                className="flex items-center gap-3 p-3 rounded border border-border hover:bg-secondary transition-colors"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={
                    sub.thumbnail ||
                    "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop"
                  }
                  alt={sub.title}
                  className="w-10 h-10 rounded-full object-cover bg-secondary"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{sub.title}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    Added {new Date(sub.addedAt).toLocaleDateString()}
                  </p>
                </div>
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
