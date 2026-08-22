import { getDb } from "./db";
import { migrateFromJson } from "./migrate";
import {
  clampNumericSetting,
  defaultSettings,
  numericSettingLimits,
  type AppSettings,
  type NumericSettingKey,
} from "./settingsSchema";

export {
  clampNumericSetting,
  defaultSettings,
  numericSettingLimits,
  RETENTION_OPTIONS,
  formatRetention,
} from "./settingsSchema";
export type { AppSettings, NumericSettingKey } from "./settingsSchema";

// Run migration on first import
let migrationPromise: Promise<void> | null = null;
async function ensureMigration() {
  if (!migrationPromise) {
    migrationPromise = migrateFromJson().catch((err) => {
      console.error("Migration failed:", err);
    });
  }
  await migrationPromise;
}

export async function readSettings(): Promise<AppSettings> {
  await ensureMigration();
  const db = getDb();

  const settings: Partial<AppSettings> = { ...defaultSettings };

  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;

  for (const row of rows) {
    try {
      const value = JSON.parse(row.value);
      if (!(row.key in settings)) continue;

      if (row.key in numericSettingLimits) {
        const clamped = clampNumericSetting(row.key as NumericSettingKey, value);
        if (clamped !== null) {
          (settings as any)[row.key] = clamped;
        }
        continue;
      }

      (settings as any)[row.key] = value;
    } catch {
      // Skip invalid JSON
    }
  }

  return settings as AppSettings;
}

export async function writeSettings(
  settings: Partial<AppSettings>
): Promise<void> {
  await ensureMigration();
  const db = getDb();

  const current = await readSettings();
  const updated = { ...current, ...settings };

  // Only keep properties that are in AppSettings interface
  const keys: (keyof AppSettings)[] = [
    "defaultSortOrder",
    "theme",
    "videoPlayerMode",
    "defaultPlayerResolution",
    "sponsorBlockEnabled",
    "playerDebugEnabled",
    "captionsEnabled",
    "fetchMethod",
    "oidcOnly",
    "publicRegistration",
    "videoRetentionDays",
    "feedConcurrency",
    "feedChannelTimeoutSeconds",
    "feedRequestTimeoutSeconds",
    "feedRefreshMinutes",
    "feedErrorRetryMinutes",
  ];

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
  );

  for (const key of keys) {
    if (key in updated) {
      stmt.run(key, JSON.stringify(updated[key]));
    }
  }
}
