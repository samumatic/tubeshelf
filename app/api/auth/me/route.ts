import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";
import { getAuthSecretStatus } from "@/lib/betterAuth";

export async function GET(request: Request) {
  const user = await getCurrentUser(request);
  const authSecretStatus = getAuthSecretStatus();
  const warnings = {
    generatedAuthSecretFallback: authSecretStatus.isGeneratedFallback,
    insecureDefaultAuthSecret: authSecretStatus.isKnownPlaceholder,
  };

  if (!user) {
    return NextResponse.json({ error: "Unauthorized", warnings }, { status: 401 });
  }

  return NextResponse.json({
    warnings,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.isAdmin,
      oidcProvider: user.oidcProvider,
      authType: user.authType,
    },
  });
}
