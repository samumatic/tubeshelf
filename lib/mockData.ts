export interface Video {
  id: string;
  title: string;
  channel: string;
  channelId: string;
  thumbnail: string;
  duration?: string;
  uploadedAt: string;
  isShort?: boolean;
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

const headers: HeadersInit = {
  "Content-Type": "application/json",
};

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString();
}

export async function getVideos(): Promise<Video[]> {
  const res = await fetch("/api/feed", { cache: "no-store" });
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
    uploadedAt: formatDate(item.publishedAt),
    views: item.viewCount || item.views,
    isShort: item.isShort || false,
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

export async function addSubscription(input: string): Promise<Subscription> {
  const res = await fetch("/api/subscriptions", {
    method: "POST",
    headers,
    body: JSON.stringify({ input }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to add subscription");
  }
  return res.json();
}

export async function removeSubscription(channelId: string): Promise<void> {
  const res = await fetch(
    `/api/subscriptions?id=${encodeURIComponent(channelId)}`,
    {
      method: "DELETE",
    }
  );
  if (!res.ok) {
    throw new Error("Failed to remove subscription");
  }
}

export async function importSubscriptions(opmlText: string) {
  const res = await fetch("/api/subscriptions/import", {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: opmlText,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to import subscriptions");
  }
  return res.json();
}

export async function exportSubscriptions(): Promise<string> {
  const res = await fetch("/api/subscriptions/export", { cache: "no-store" });
  if (!res.ok) {
    throw new Error("Failed to export subscriptions");
  }
  return res.text();
}

export async function getSettings() {
  const res = await fetch("/api/settings", { cache: "no-store" });
  if (!res.ok) {
    throw new Error("Failed to fetch settings");
  }
  return res.json();
}

export async function updateSettings(updates: Record<string, any>) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers,
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to update settings");
  }
  return res.json();
}

export async function deleteAllSubscriptions() {
  const res = await fetch("/api/danger/delete-subscriptions", {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to delete subscriptions");
  }
  return res.json();
}

export async function clearWatchHistory() {
  const res = await fetch("/api/danger/clear-watch-history", {
    method: "POST",
    headers,
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
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to reset settings");
  }
  return res.json();
}
