export interface Video {
  id: string;
  title: string;
  channel: string;
  channelId: string;
  thumbnail: string;
  duration?: string;
  /** Video length in seconds; the value everything displays is derived from this. */
  durationSeconds?: number;
  uploadedAt: string;
  isMemberOnly?: boolean;
  views?: number;
  url: string;
}

export interface Subscription {
  id: string;
  channelId: string;
  title: string;
  url: string;
  thumbnail?: string;
  addedAt: string;
}

// Common JSON headers used for POST requests
const headers: HeadersInit = {
  "Content-Type": "application/json",
};

export async function getVideos(forceRefresh = false): Promise<Video[]> {
  const url = `/api/feed${forceRefresh ? "?refresh=true" : ""}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error("Failed to fetch feed");
  }
  const data = await res.json();
  return (data.items || []).map((item: any) => ({
    id: item.id,
    title: item.title,
    channel: item.channelTitle || "Unknown",
    channelId: item.channelId || "",
    thumbnail:
      item.thumbnail ||
      "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=400&h=225&fit=crop",
    duration: item.duration || "—",
    durationSeconds: item.durationSeconds,
    uploadedAt: item.publishedAt || new Date().toISOString(),
    views: item.viewCount || item.views,
    isMemberOnly:
      item.isMemberOnly || item.membersOnly || item.isMembersOnly || false,
    url: item.url,
  }));
}

export async function getSubscriptions(): Promise<Subscription[]> {
  const res = await fetch("/api/subscriptions", { cache: "no-store" });
  if (!res.ok) {
    throw new Error("Failed to fetch subscriptions");
  }
  return res.json();
}

export async function addSubscription(
  input: string,
  listId: string = "default"
): Promise<Subscription> {
  const res = await fetch("/api/subscription-lists/subscriptions", {
    method: "POST",
    headers,
    body: JSON.stringify({ input, listId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to add subscription");
  }
  const list = await res.json();
  // Return the newly added subscription
  return list.subscriptions[list.subscriptions.length - 1];
}

export async function removeSubscription(
  channelId: string,
  listId: string = "default"
): Promise<void> {
  const res = await fetch(`/api/subscription-lists/subscriptions`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId, listId }),
  });
  if (!res.ok) {
    throw new Error("Failed to remove subscription");
  }
}

export async function importSubscriptions(
  data: string,
  format: string = "opml",
  listId: string = "default"
) {
  const contentType = format === "json" ? "application/json" : "text/xml";
  const res = await fetch(
    `/api/subscriptions/import?listId=${encodeURIComponent(listId)}`,
    {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: data,
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to import subscriptions");
  }
  return res.json();
}

export async function exportSubscriptions(
  format: "opml" | "json" | "tags" = "opml",
  listId: string = "all"
): Promise<string> {
  const res = await fetch(
    `/api/subscriptions/export?format=${format}&listId=${encodeURIComponent(
      listId
    )}`,
    {
      cache: "no-store",
    }
  );
  if (!res.ok) {
    throw new Error("Failed to export subscriptions");
  }
  return res.text();
}

export async function updateSubscriptionTags(
  channelId: string,
  tags: string[]
): Promise<void> {
  const res = await fetch("/api/subscriptions/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId, tags }),
  });
  if (!res.ok) {
    throw new Error("Failed to update tags");
  }
}

export async function getSettings() {
  const res = await fetch("/api/settings", {
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to fetch settings");
  }
  return res.json();
}

export async function updateSettings(updates: Record<string, any>) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to update settings");
  }
  return res.json();
}

export async function getUserState() {
  const res = await fetch("/api/user-state", {
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to fetch user state");
  }
  return res.json();
}

export async function updateUserState(state: Record<string, any>) {
  const res = await fetch("/api/user-state", {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(state),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to update user state");
  }
  return res.json();
}

export async function clearWatchHistory() {
  const res = await fetch("/api/danger/clear-watch-history", {
    method: "POST",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to clear watch history");
  }
  return res.json();
}

export async function resetAllSettings() {
  const res = await fetch("/api/danger/reset-settings", {
    method: "POST",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to reset settings");
  }
  return res.json();
}
