import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

export interface AppSettings {
  defaultSortOrder: "newest" | "oldest";
  theme: "light" | "dark" | "system";
}

export const defaultSettings: AppSettings = {
  defaultSortOrder: "newest",
  theme: "system",
};

const dataDir = "data";
const settingsFile = join(dataDir, "settings.json");

export async function readSettings(): Promise<AppSettings> {
  try {
    const data = await readFile(settingsFile, "utf-8");
    return { ...defaultSettings, ...JSON.parse(data) };
  } catch {
    return defaultSettings;
  }
}

export async function writeSettings(
  settings: Partial<AppSettings>
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const current = await readSettings();
  const updated = { ...current, ...settings };
  await writeFile(settingsFile, JSON.stringify(updated, null, 2), "utf-8");
}
