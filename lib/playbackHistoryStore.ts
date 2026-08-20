import { getDb } from "./db";

export interface PlaybackSession {
  videoId: string;
  videoTitle: string;
  channelId?: string | null;
  channelName: string;
  thumbnail?: string | null;
  timestamp: string;
  duration: number;
  progress: number;
  completed: boolean;
}

export async function readPlaybackHistory(
  userId: string
): Promise<PlaybackSession[]> {
  const db = getDb();

  return db
    .prepare(
      `SELECT
        video_id as videoId,
        video_title as videoTitle,
        channel_id as channelId,
        channel_name as channelName,
        thumbnail,
        timestamp,
        duration,
        progress,
        completed
      FROM playback_history
      WHERE user_id = ?
      ORDER BY timestamp DESC`
    )
    .all(userId)
    .map((row: any) => ({
      ...row,
      completed: !!row.completed,
    }));
}

export interface VideoProgress {
  videoId: string;
  progress: number;
  duration: number;
}

/**
 * Just the numbers the feed needs to draw a progress bar.
 *
 * Watched videos are excluded because their cards render the watched overlay
 * instead of a bar, so shipping them would grow the response for nothing.
 */
export async function readVideoProgress(
  userId: string
): Promise<VideoProgress[]> {
  const db = getDb();

  return db
    .prepare(
      `SELECT
        video_id as videoId,
        progress,
        duration
      FROM playback_history p
      WHERE p.user_id = ?
        AND p.progress > 0
        AND p.duration > 0
        AND NOT EXISTS (
          SELECT 1 FROM watched_videos w
          WHERE w.user_id = p.user_id AND w.video_id = p.video_id
        )`
    )
    .all(userId) as VideoProgress[];
}

export async function getPlaybackSession(
  videoId: string,
  userId: string
): Promise<PlaybackSession | null> {
  const db = getDb();

  const row = db
    .prepare(
      `SELECT
        video_id as videoId,
        video_title as videoTitle,
        channel_id as channelId,
        channel_name as channelName,
        thumbnail,
        timestamp,
        duration,
        progress,
        completed
      FROM playback_history
      WHERE video_id = ? AND user_id = ?`
    )
    .get(videoId, userId) as PlaybackSession | undefined;

  if (!row) {
    return null;
  }

  return {
    ...row,
    completed: !!(row as any).completed,
  };
}

export async function savePlaybackSession(
  session: PlaybackSession,
  userId: string
): Promise<void> {
  const db = getDb();

  db.prepare(
    `INSERT INTO playback_history
      (video_id, user_id, video_title, channel_id, channel_name, thumbnail, timestamp, duration, progress, completed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_id, user_id) DO UPDATE SET
      video_title = excluded.video_title,
      channel_id = excluded.channel_id,
      channel_name = excluded.channel_name,
      thumbnail = excluded.thumbnail,
      timestamp = excluded.timestamp,
      duration = excluded.duration,
      progress = excluded.progress,
      completed = excluded.completed`
  ).run(
    session.videoId,
    userId,
    session.videoTitle,
    session.channelId || null,
    session.channelName,
    session.thumbnail || null,
    session.timestamp,
    session.duration,
    session.progress,
    session.completed ? 1 : 0
  );
}

/**
 * Send a video back to the start without losing its history entry.
 *
 * Used when a video is marked unwatched by hand: the bar disappears and the
 * next open plays from the beginning, but the row stays so the watch history
 * list keeps the entry until it is removed there explicitly.
 */
export async function resetPlaybackProgress(
  videoId: string,
  userId: string
): Promise<void> {
  const db = getDb();
  db.prepare(
    `UPDATE playback_history
     SET progress = 0, completed = 0
     WHERE video_id = ? AND user_id = ?`
  ).run(videoId, userId);
}

export async function deletePlaybackSession(
  videoId: string,
  userId: string
): Promise<void> {
  const db = getDb();
  db.prepare("DELETE FROM playback_history WHERE video_id = ? AND user_id = ?").run(
    videoId,
    userId
  );
}

export async function clearPlaybackHistory(userId: string): Promise<void> {
  const db = getDb();
  db.prepare("DELETE FROM playback_history WHERE user_id = ?").run(userId);
}
