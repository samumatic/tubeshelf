import { NextResponse } from "next/server";
import { readSettings } from "@/lib/settingsStore";
import { getAuthSecretStatus } from "@/lib/betterAuth";

export async function GET() {
  try {
    const settings = await readSettings();
    const authSecretStatus = getAuthSecretStatus();
    return NextResponse.json({
      oidcOnly: !!settings.oidcOnly,
      publicRegistration: !!settings.publicRegistration,
      warnings: {
        generatedAuthSecretFallback: authSecretStatus.isGeneratedFallback,
        insecureDefaultAuthSecret: authSecretStatus.isKnownPlaceholder,
      },
    });
  } catch (error) {
    console.error("[Auth Settings] Failed to read settings:", error);
    const authSecretStatus = getAuthSecretStatus();
    return NextResponse.json({
      oidcOnly: false,
      publicRegistration: false,
      warnings: {
        generatedAuthSecretFallback: authSecretStatus.isGeneratedFallback,
        insecureDefaultAuthSecret: authSecretStatus.isKnownPlaceholder,
      },
    });
  }
}
