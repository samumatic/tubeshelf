import { NextResponse } from "next/server";
import packageJson from "@/package.json";
import { getAppVersion } from "@/lib/version";

// The build channel/commit come from the image's environment, so this must
// not be prerendered at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    version: getAppVersion(),
    name: packageJson.name,
  });
}
