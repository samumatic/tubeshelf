import { promises as fs } from "fs";
import path from "path";

export interface UserState {
  watchedVideos: string[];
  hideWatched: boolean;
}

const dataDir = path.join(process.cwd(), "data");
const watchedFile = path.join(dataDir, "watchedVideos.json");
const configFile = path.join(dataDir, "userConfig.json");

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
    const defaultConfig = { hideWatched: false };
    await fs.writeFile(
      configFile,
      JSON.stringify(defaultConfig, null, 2),
      "utf8"
    );
  }
}

export async function readUserState(): Promise<UserState> {
  await Promise.all([ensureWatchedFile(), ensureConfigFile()]);

  const [watchedRaw, configRaw] = await Promise.all([
    fs.readFile(watchedFile, "utf8"),
    fs.readFile(configFile, "utf8"),
  ]);

  let watchedVideos: string[] = [];
  let hideWatched = false;

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
  } catch {
    hideWatched = false;
  }

  return { watchedVideos, hideWatched };
}

export async function writeUserState(state: UserState) {
  await Promise.all([ensureWatchedFile(), ensureConfigFile()]);

  const watchedWrite = fs.writeFile(
    watchedFile,
    JSON.stringify(state.watchedVideos ?? [], null, 2),
    "utf8"
  );

  const configWrite = fs.writeFile(
    configFile,
    JSON.stringify({ hideWatched: !!state.hideWatched }, null, 2),
    "utf8"
  );

  await Promise.all([watchedWrite, configWrite]);
}
