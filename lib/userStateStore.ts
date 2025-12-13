import { promises as fs } from "fs";
import path from "path";

export interface UserState {
  watchedVideos: string[];
  hideWatched: boolean;
  filterListId?: string;
  watchLater?: Array<{
    id: string;
    videoId: string;
    title: string;
    channel: string;
    thumbnail: string;
    addedAt: string;
  }>;
}

const dataDir = path.join(process.cwd(), "data");
const watchedFile = path.join(dataDir, "watchedVideos.json");
const configFile = path.join(dataDir, "userConfig.json");
const watchLaterFile = path.join(dataDir, "watchLater.json");

async function ensureDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function ensureWatchedFile() {
  try {
    await fs.access(watchedFile);
  } catch {
    await ensureDir();
    await fs.writeFile(watchedFile, "[]", "utf8");
  }
}

async function ensureConfigFile() {
  try {
    await fs.access(configFile);
  } catch {
    await ensureDir();
    const defaultConfig = { hideWatched: false, filterListId: "all" };
    await fs.writeFile(
      configFile,
      JSON.stringify(defaultConfig, null, 2),
      "utf8"
    );
  }
}

async function ensureWatchLaterFile() {
  try {
    await fs.access(watchLaterFile);
  } catch {
    await ensureDir();
    await fs.writeFile(watchLaterFile, "[]", "utf8");
  }
}

export async function readUserState(): Promise<UserState> {
  await Promise.all([
    ensureWatchedFile(),
    ensureConfigFile(),
    ensureWatchLaterFile(),
  ]);

  const [watchedRaw, configRaw, watchLaterRaw] = await Promise.all([
    fs.readFile(watchedFile, "utf8"),
    fs.readFile(configFile, "utf8"),
    fs.readFile(watchLaterFile, "utf8"),
  ]);

  let watchedVideos: string[] = [];
  let hideWatched = false;
  let filterListId = "all";
  let watchLater: UserState["watchLater"] = [];

  try {
    const parsedWatched = JSON.parse(watchedRaw);
    watchedVideos = Array.isArray(parsedWatched) ? parsedWatched : [];
  } catch {
    watchedVideos = [];
  }

  try {
    const parsedConfig = JSON.parse(configRaw);
    hideWatched =
      typeof parsedConfig.hideWatched === "boolean"
        ? parsedConfig.hideWatched
        : false;
    filterListId =
      typeof parsedConfig.filterListId === "string"
        ? parsedConfig.filterListId
        : "all";
  } catch {
    hideWatched = false;
    filterListId = "all";
  }

  try {
    const parsedWatchLater = JSON.parse(watchLaterRaw);
    watchLater = Array.isArray(parsedWatchLater) ? parsedWatchLater : [];
  } catch {
    watchLater = [];
  }

  return { watchedVideos, hideWatched, filterListId, watchLater };
}

export async function writeUserState(state: UserState) {
  await Promise.all([
    ensureWatchedFile(),
    ensureConfigFile(),
    ensureWatchLaterFile(),
  ]);

  const watchedWrite = fs.writeFile(
    watchedFile,
    JSON.stringify(state.watchedVideos ?? [], null, 2),
    "utf8"
  );

  const configWrite = fs.writeFile(
    configFile,
    JSON.stringify(
      {
        hideWatched: !!state.hideWatched,
        filterListId: state.filterListId ?? "all",
      },
      null,
      2
    ),
    "utf8"
  );

  const watchLaterWrite = fs.writeFile(
    watchLaterFile,
    JSON.stringify(state.watchLater ?? [], null, 2),
    "utf8"
  );

  await Promise.all([watchedWrite, configWrite, watchLaterWrite]);
}
