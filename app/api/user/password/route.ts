import { NextResponse } from "next/server";
import { APIError } from "better-auth";
import { getCurrentUser } from "@/lib/currentUser";
import { appendSetCookieHeaders, getAuth } from "@/lib/betterAuth";
import { checkRateLimit } from "@/lib/rateLimit";

export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userLimit = checkRateLimit({
    bucket: "user-password-change",
    key: user.id,
    limit: 10,
    windowMs: 10 * 60 * 1000,
  });
  if (!userLimit.allowed) {
    return NextResponse.json(
      { error: "Too many password change attempts. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(userLimit.retryAfterSeconds) },
      }
    );
  }

  if (user.authType === "oidc") {
    return NextResponse.json(
      { error: "OIDC-managed users cannot change local password" },
      { status: 403 }
    );
  }

  const body = await req.json().catch(() => null);
  const currentPassword =
    typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword =
    typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { error: "Current and new passwords are required" },
      { status: 400 }
    );
  }

  if (newPassword.length < 8) {
    return NextResponse.json(
      { error: "New password must be at least 8 characters" },
      { status: 400 }
    );
  }

  try {
    const auth = await getAuth(req);
    const result = await auth.api.changePassword({
      body: {
        currentPassword,
        newPassword,
        // Preserve current UX more closely than revoking all sessions.
        revokeOtherSessions: true,
      },
      headers: req.headers,
      returnHeaders: true,
      returnStatus: true,
    });

    const response = NextResponse.json(
      { success: true },
      { status: (result as any).status || 200 }
    );
    appendSetCookieHeaders(response.headers, (result as any).headers);
    return response;
  } catch (error) {
    if (error instanceof APIError) {
      const message = String((error as any).message || "");
      if (message.toLowerCase().includes("invalid password")) {
        return NextResponse.json(
          { error: "Current password is incorrect" },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { error: "Failed to update password" },
        { status: (error as any).statusCode || 400 }
      );
    }
    throw error;
  }
}
