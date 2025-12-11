import { NextResponse } from "next/server";
import { readSettings, writeSettings, AppSettings } from "@/lib/settingsStore";

export async function GET() {
  const settings = await readSettings();
  return NextResponse.json(settings);
}

export async function POST(req: Request) {
  try {
    const updates = await req.json();
    await writeSettings(updates);
    const updated = await readSettings();
    return NextResponse.json(updated);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to save settings" },
      { status: 400 }
    );
  }
}
