// Global progress tracking for feed fetching
interface FeedProgress {
  total: number;
  completed: number;
  currentChannel?: string;
  currentChannelTitle?: string;
  subscribers: ((data: FeedProgress) => void)[];
  sessionId?: string;
}

const progress: FeedProgress = {
  total: 0,
  completed: 0,
  subscribers: [],
};

export function initProgress(total: number) {
  // Don't clear subscribers, just reset the progress values
  progress.total = total;
  progress.completed = 0;
  progress.currentChannel = undefined;
  progress.currentChannelTitle = undefined;
  // Start a new session for this progress run
  progress.sessionId = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  notifySubscribers();
}

export function updateProgress(
  channelId: string,
  channelTitle?: string,
  sessionId?: string
) {
  // Ignore updates from previous sessions
  if (sessionId && progress.sessionId && sessionId !== progress.sessionId) {
    return;
  }
  // Ignore updates if progress is not initialized
  if (progress.total <= 0) return;
  // If already completed, keep it capped and ignore further increments
  if (progress.completed >= progress.total) {
    progress.completed = progress.total;
    return;
  }
  progress.completed += 1;
  if (progress.completed > progress.total) {
    progress.completed = progress.total;
  }
  progress.currentChannel = channelId;
  progress.currentChannelTitle = channelTitle;
  notifySubscribers();
}

export function getProgress(): FeedProgress {
  return { ...progress };
}

export function subscribe(callback: (data: FeedProgress) => void) {
  progress.subscribers.push(callback);
  // Immediately send current progress
  callback({ ...progress });

  return () => {
    progress.subscribers = progress.subscribers.filter((cb) => cb !== callback);
  };
}

function notifySubscribers() {
  progress.subscribers.forEach((callback) => {
    callback({ ...progress });
  });
}
