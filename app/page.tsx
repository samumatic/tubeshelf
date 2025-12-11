"use client";

import { useState, useEffect } from "react";
import { Play, Menu, Search, Settings, Bookmark, Sliders } from "lucide-react";
import { VideoCard } from "@/components/VideoCard";
import { SubscriptionManager } from "@/components/SubscriptionManager";
import { SettingsPanel } from "@/components/SettingsPanel";
import { WatchLater } from "@/components/WatchLater";
import { ThemeToggle } from "@/components/ThemeProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  getVideos,
  getSubscriptions,
  addSubscription,
  removeSubscription,
  importSubscriptions,
  exportSubscriptions,
  getSettings,
  updateSettings,
  deleteAllSubscriptions,
  clearWatchHistory,
  resetAllSettings,
  Video,
  Subscription,
} from "@/lib/mockData";
import type { AppSettings } from "@/lib/settingsStore";

type Page = "home" | "watch-later";
type FeedTab = "videos" | "reels";

interface WatchLaterItem {
  id: string;
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  addedAt: Date;
}

export default function Home() {
  const [currentPage, setCurrentPage] = useState<Page>("home");
  const [feedTab, setFeedTab] = useState<FeedTab>("videos");
  const [videos, setVideos] = useState<Video[]>([]);
  const [shorts, setShorts] = useState<Video[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [watchLater, setWatchLater] = useState<WatchLaterItem[]>([]);
  const [watchedVideos, setWatchedVideos] = useState<Set<string>>(new Set());
  const [showSubscriptions, setShowSubscriptions] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filteredVideos, setFilteredVideos] = useState<Video[]>([]);
  const [filteredShorts, setFilteredShorts] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hideWatched, setHideWatched] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const refreshData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [subs, vids] = await Promise.all([getSubscriptions(), getVideos()]);
      setSubscriptions(subs);
      setVideos(vids.filter((v) => !v.isShort));
      setShorts(vids.filter((v) => v.isShort));
      setFilteredVideos(vids.filter((v) => !v.isShort));
      setFilteredShorts(vids.filter((v) => v.isShort));
    } catch (err: any) {
      setError(err?.message || "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  // Load user state from server
  const loadUserState = async () => {
    try {
      const res = await fetch("/api/user-state");
      if (res.ok) {
        const data = await res.json();
        setWatchedVideos(new Set(data.watchedVideos || []));
        setHideWatched(data.hideWatched || false);
      }
    } catch (e) {
      console.error("Failed to load user state:", e);
    }
  };

  // Save user state to server
  const saveUserState = async () => {
    try {
      await fetch("/api/user-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          watchedVideos: Array.from(watchedVideos),
          hideWatched,
        }),
      });
    } catch (e) {
      console.error("Failed to save user state:", e);
    }
  };

  // Initialize data
  useEffect(() => {
    const init = async () => {
      try {
        const appSettings = await getSettings();
        setSettings(appSettings);
      } catch (e) {
        console.error("Failed to load settings:", e);
      }
    };

    refreshData();
    loadUserState();
    init();

    // Load hideWatched preference from localStorage
    const savedHideWatched = localStorage.getItem("hideWatched");
    if (savedHideWatched !== null) {
      setHideWatched(JSON.parse(savedHideWatched));
    }

    // Load watch later from localStorage (keep this client-side)
    const saved = localStorage.getItem("watchLater");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setWatchLater(
          parsed.map((item: any) => ({
            ...item,
            addedAt: new Date(item.addedAt),
          }))
        );
      } catch (e) {
        console.error("Failed to load watch later:", e);
      }
    }
  }, []);

  // Save watch later to localStorage
  useEffect(() => {
    localStorage.setItem("watchLater", JSON.stringify(watchLater));
  }, [watchLater]);

  // Save user state when it changes
  useEffect(() => {
    if (watchedVideos.size > 0 || hideWatched) {
      saveUserState();
    }
  }, [watchedVideos, hideWatched]);

  // Save hideWatched preference to localStorage
  useEffect(() => {
    localStorage.setItem("hideWatched", JSON.stringify(hideWatched));
  }, [hideWatched]);

  // Handle search and filter
  useEffect(() => {
    const term = searchQuery.trim().toLowerCase();
    let vids = videos;
    let shts = shorts;

    // Filter by search term
    if (term) {
      vids = vids.filter(
        (v) =>
          v.title.toLowerCase().includes(term) ||
          v.channel.toLowerCase().includes(term)
      );
      shts = shts.filter(
        (v) =>
          v.title.toLowerCase().includes(term) ||
          v.channel.toLowerCase().includes(term)
      );
    }

    // Filter out watched videos if hideWatched is true
    if (hideWatched) {
      vids = vids.filter((v) => !watchedVideos.has(v.id));
      shts = shts.filter((v) => !watchedVideos.has(v.id));
    }

    setFilteredVideos(vids);
    setFilteredShorts(shts);
  }, [searchQuery, videos, shorts, hideWatched, watchedVideos]);

  const handleAddSubscription = async (url: string) => {
    try {
      await addSubscription(url);
      await refreshData();
    } catch (err) {
      console.error(err);
      throw err;
    }
  };

  const handleImportSubscriptions = async (opmlText: string) => {
    await importSubscriptions(opmlText);
    await refreshData();
  };

  const handleExportSubscriptions = async () => {
    const xml = await exportSubscriptions();
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tubeshelf-subscriptions.opml";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleSaveSettings = async (updates: Partial<typeof settings>) => {
    try {
      await updateSettings(updates);
      const freshSettings = await getSettings();
      setSettings(freshSettings);
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  };

  const handleDeleteAllSubscriptions = async () => {
    await deleteAllSubscriptions();
    await refreshData();
  };

  const handleClearWatchHistory = async () => {
    await clearWatchHistory();
    setWatchedVideos(new Set());
  };

  const handleResetAllSettings = async () => {
    try {
      await resetAllSettings();
      const freshSettings = await getSettings();
      setSettings(freshSettings);
    } catch (err) {
      console.error("Failed to reset settings:", err);
    }
  };

  const handleRemoveSubscription = async (id: string) => {
    try {
      await removeSubscription(id);
      await refreshData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleWatchVideo = (videoId: string) => {
    const newWatched = new Set(watchedVideos);
    newWatched.add(videoId);
    setWatchedVideos(newWatched);
  };

  const handleToggleWatched = (videoId: string) => {
    const newWatched = new Set(watchedVideos);
    if (newWatched.has(videoId)) {
      newWatched.delete(videoId);
    } else {
      newWatched.add(videoId);
    }
    setWatchedVideos(newWatched);
  };

  const handleAddToWatchLater = (video: Video) => {
    const item: WatchLaterItem = {
      id: `wl-${video.id}`,
      videoId: video.id,
      title: video.title,
      channel: video.channel,
      thumbnail: video.thumbnail,
      addedAt: new Date(),
    };
    setWatchLater([item, ...watchLater.filter((w) => w.videoId !== video.id)]);
  };

  const handleRemoveFromWatchLater = (id: string) => {
    setWatchLater(watchLater.filter((w) => w.id !== id));
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Navigation */}
      <nav className="sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <Button
                onClick={() => setShowMobileMenu(!showMobileMenu)}
                variant="ghost"
                size="icon"
                className="lg:hidden"
              >
                <Menu className="w-5 h-5" />
              </Button>
              <div
                className="flex items-center gap-2 cursor-pointer"
                onClick={() => {
                  setCurrentPage("home");
                  setSearchQuery("");
                }}
              >
                <div className="bg-primary rounded p-1">
                  <Play
                    className="w-5 h-5 text-primary-foreground"
                    fill="currentColor"
                  />
                </div>
                <h1 className="text-xl font-bold hidden sm:block">TubeShelf</h1>
              </div>
            </div>

            {/* Search */}
            <div className="hidden md:flex flex-1 max-w-md mx-8">
              <div className="relative w-full">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search videos..."
                  className="w-full text-sm pl-10"
                />
              </div>
            </div>

            {/* Right Actions */}
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <Button
                onClick={() => setShowSettings(true)}
                variant="ghost"
                size="icon"
                title="Settings"
              >
                <Sliders className="w-5 h-5" />
              </Button>
              <Button
                onClick={() => setShowSubscriptions(true)}
                variant="secondary"
                size="sm"
                className="hidden sm:flex"
              >
                <Settings className="w-4 h-4 mr-2" />
                Subscriptions
              </Button>
              <Button
                onClick={() => setCurrentPage("watch-later")}
                variant="ghost"
                size="icon"
                className="relative"
              >
                <Bookmark className="w-5 h-5" />
                {watchLater.length > 0 && (
                  <span className="absolute top-1 right-1 bg-primary text-primary-foreground text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {watchLater.length}
                  </span>
                )}
              </Button>
            </div>
          </div>

          {/* Mobile Search */}
          <div className="md:hidden pb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search videos..."
                className="w-full text-sm pl-10"
              />
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {currentPage === "home" ? (
          <>
            {/* Page Header */}
            <div className="mb-8">
              <h2 className="text-2xl sm:text-3xl font-bold mb-2">Your Feed</h2>
              <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
                <span>{subscriptions.length} subscriptions</span>
                <span>•</span>
                <span>{filteredVideos.length} videos</span>
                <span>•</span>
                <span>{filteredShorts.length} reels</span>
              </div>
              {error && (
                <p className="text-sm text-destructive mt-2">{error}</p>
              )}
            </div>

            {/* Mobile Subscription Button */}
            <div className="sm:hidden mb-6">
              <Button
                onClick={() => setShowSubscriptions(true)}
                variant="default"
                className="w-full"
              >
                <Settings className="w-4 h-4 mr-2" />
                Manage Subscriptions
              </Button>
            </div>

            {loading ? (
              <div className="text-center py-12">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                <p className="mt-4 text-muted-foreground">Loading feed...</p>
              </div>
            ) : (
              <>
                {/* Tabs and Controls */}
                <div className="flex items-center justify-between mb-6 border-b border-border">
                  <div className="flex gap-4">
                    <button
                      onClick={() => setFeedTab("videos")}
                      className={`px-4 py-2 font-medium transition-colors ${
                        feedTab === "videos"
                          ? "border-b-2 border-primary text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Videos ({filteredVideos.length})
                    </button>
                    <button
                      onClick={() => setFeedTab("reels")}
                      className={`px-4 py-2 font-medium transition-colors ${
                        feedTab === "reels"
                          ? "border-b-2 border-primary text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Reels ({filteredShorts.length})
                    </button>
                  </div>
                  <div className="flex items-center gap-2 pb-2">
                    <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                      <Switch
                        checked={hideWatched}
                        onCheckedChange={setHideWatched}
                      />
                      Hide watched
                    </label>
                  </div>
                </div>

                {/* Videos Tab */}
                {feedTab === "videos" && (
                  <>
                    {filteredVideos.length === 0 ? (
                      <div className="text-center py-12">
                        <Play className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                        <h3 className="text-lg font-semibold mb-2">
                          No videos found
                        </h3>
                        <p className="text-muted-foreground">
                          {searchQuery
                            ? "Try adjusting your search"
                            : "Subscribe to channels to get started"}
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {filteredVideos.map((video) => (
                          <VideoCard
                            key={video.id}
                            id={video.id}
                            title={video.title}
                            channel={video.channel}
                            thumbnail={video.thumbnail}
                            duration={video.duration}
                            uploadedAt={video.uploadedAt}
                            views={video.views}
                            watched={watchedVideos.has(video.id)}
                            videoUrl={video.url}
                            onWatch={() => handleWatchVideo(video.id)}
                            onWatchLater={() => handleAddToWatchLater(video)}
                            onMarkWatched={() => handleToggleWatched(video.id)}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Reels Tab */}
                {feedTab === "reels" && (
                  <>
                    {filteredShorts.length === 0 ? (
                      <div className="text-center py-12">
                        <Play className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                        <h3 className="text-lg font-semibold mb-2">
                          No reels found
                        </h3>
                        <p className="text-muted-foreground">
                          {searchQuery
                            ? "Try adjusting your search"
                            : "Subscribe to channels to get started"}
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                        {filteredShorts.map((video) => (
                          <VideoCard
                            key={video.id}
                            id={video.id}
                            title={video.title}
                            channel={video.channel}
                            thumbnail={video.thumbnail}
                            duration={video.duration}
                            uploadedAt={video.uploadedAt}
                            views={video.views}
                            watched={watchedVideos.has(video.id)}
                            videoUrl={video.url}
                            onWatch={() => handleWatchVideo(video.id)}
                            onWatchLater={() => handleAddToWatchLater(video)}
                            onMarkWatched={() => handleToggleWatched(video.id)}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {/* Watch Later Page */}
            <div className="mb-8">
              <h2 className="text-2xl sm:text-3xl font-bold mb-2">
                Watch Later
              </h2>
              <p className="text-sm text-muted-foreground">
                {watchLater.length} video{watchLater.length !== 1 ? "s" : ""}{" "}
                saved
              </p>
            </div>

            <div className="max-w-2xl">
              <WatchLater
                items={watchLater}
                onRemove={handleRemoveFromWatchLater}
                onPlay={handleWatchVideo}
              />
            </div>
          </>
        )}
      </main>

      {/* Subscription Manager Modal */}
      <SubscriptionManager
        subscriptions={subscriptions}
        onAdd={handleAddSubscription}
        onRemove={handleRemoveSubscription}
        onImport={handleImportSubscriptions}
        onExport={handleExportSubscriptions}
        isOpen={showSubscriptions}
        onClose={() => setShowSubscriptions(false)}
      />

      {/* Modals */}
      <SubscriptionManager
        subscriptions={subscriptions}
        onAdd={handleAddSubscription}
        onRemove={handleRemoveSubscription}
        onImport={handleImportSubscriptions}
        onExport={handleExportSubscriptions}
        isOpen={showSubscriptions}
        onClose={() => setShowSubscriptions(false)}
      />

      {settings && (
        <SettingsPanel
          settings={settings}
          onSave={handleSaveSettings}
          onDeleteSubscriptions={handleDeleteAllSubscriptions}
          onClearWatchHistory={handleClearWatchHistory}
          onResetSettings={handleResetAllSettings}
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Footer */}
      <footer className="border-t border-border mt-16 bg-card/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-sm text-muted-foreground">
          <p>TubeShelf © 2025 • Licensed under AGPL-3</p>
          <p className="mt-2 text-xs">
            A clean, chronological YouTube feed. No algorithm. No tracking.
          </p>
        </div>
      </footer>
    </div>
  );
}
