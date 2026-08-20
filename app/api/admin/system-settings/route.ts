import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";
import {
  clampNumericSetting,
  numericSettingLimits,
  readSettings,
  writeSettings,
  type AppSettings,
  type NumericSettingKey,
} from "@/lib/settingsStore";
import { getOIDCProviders } from "@/lib/oidc";

const NUMERIC_KEYS = Object.keys(numericSettingLimits) as NumericSettingKey[];

function serialize(settings: AppSettings) {
  const numeric = Object.fromEntries(
    NUMERIC_KEYS.map((key) => [key, settings[key]])
  );

  return {
    oidcOnly: !!settings.oidcOnly,
    publicRegistration: !!settings.publicRegistration,
    ...numeric,
    limits: numericSettingLimits,
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !user.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const settings = await readSettings();
  return NextResponse.json(serialize(settings));
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const updates: Partial<AppSettings> = {};

  if (typeof body?.oidcOnly === "boolean") {
    if (body.oidcOnly && getOIDCProviders().length === 0) {
      return NextResponse.json(
        { error: "Cannot enable OIDC-only mode without an enabled OIDC provider" },
        { status: 400 }
      );
    }
    updates.oidcOnly = body.oidcOnly;
  }

  if (typeof body?.publicRegistration === "boolean") {
    updates.publicRegistration = body.publicRegistration;
  }

  for (const key of NUMERIC_KEYS) {
    if (body?.[key] === undefined) continue;

    const value = clampNumericSetting(key, body[key]);
    if (value === null) {
      return NextResponse.json(
        { error: `${key} must be a number` },
        { status: 400 }
      );
    }
    updates[key] = value;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No valid settings provided" },
      { status: 400 }
    );
  }

  await writeSettings(updates);
  const settings = await readSettings();

  return NextResponse.json(serialize(settings));
}
