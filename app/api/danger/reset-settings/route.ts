import { NextResponse } from "next/server";
import { writeSettings, defaultSettings } from "@/lib/settingsStore";

export async function POST() {
  try {
    await writeSettings(defaultSettings);
    return NextResponse.json({ success: true, settings: defaultSettings });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to reset settings" },
      { status: 400 }
    );
  }
}
