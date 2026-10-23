import { NextResponse } from "next/server";
import { APIError } from "better-auth";
import {
  appendSetCookieHeaders,
  getAuth,
  mapBetterAuthUser,
} from "@/lib/betterAuth";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { readSettings } from "@/lib/settingsStore";
import { needsSetup } from "@/lib/setup";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(req: Request) {
  try {
    const clientIp = getClientIp(req);
    const ipLimit = checkRateLimit({
      bucket: "auth-register-ip",
      key: clientIp,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many registration attempts. Please try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(ipLimit.retryAfterSeconds) },
        }
      );
    }

    if (needsSetup()) {
      return NextResponse.json(
        { error: "Initial setup is required before registration" },
        { status: 409 }
      );
    }

    const settings = await readSettings();
    if (settings.oidcOnly) {
      return NextResponse.json(
        { error: "Password registration is disabled; sign in with SSO" },
        { status: 403 }
      );
    }
    if (!settings.publicRegistration) {
      return NextResponse.json(
        { error: "Public registration is disabled" },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => null);
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password =
      typeof body?.password === "string" ? body.password : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    if (!isValidEmail(email)) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    const emailLimit = checkRateLimit({
      bucket: "auth-register-ip-email",
      key: `${clientIp}:${email.toLowerCase()}`,
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });
    if (!emailLimit.allowed) {
      return NextResponse.json(
        { error: "Too many registration attempts. Please try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(emailLimit.retryAfterSeconds) },
        }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    const auth = await getAuth(req);
    const result = await auth.api.signUpEmail({
      body: {
        email: email.toLowerCase(),
        password,
        name: name || email.split("@")[0],
      },
      headers: req.headers,
      returnHeaders: true,
      returnStatus: true,
    });

    const mappedUser = mapBetterAuthUser((result as any).response?.user);
    if (!mappedUser) {
      throw new Error("Missing user in BetterAuth sign-up response");
    }

    const response = NextResponse.json(
      {
        user: {
          id: mappedUser.id,
          email: mappedUser.email,
          name: mappedUser.name,
          isAdmin: mappedUser.isAdmin,
          oidcProvider: mappedUser.oidcProvider,
          authType: mappedUser.authType,
        },
      },
      { status: (result as any).status || 200 }
    );

    appendSetCookieHeaders(response.headers, (result as any).headers);
    return response;
  } catch (error) {
    if (error instanceof APIError) {
      const message = (error as any).message || "";
      if (message.toLowerCase().includes("already")) {
        return NextResponse.json({ error: "Email already in use" }, { status: 409 });
      }
      return NextResponse.json(
        { error: "Registration failed" },
        { status: (error as any).statusCode || 400 }
      );
    }
    console.error("[Auth] Registration failed:", error);
    return NextResponse.json(
      { error: "Registration failed" },
      { status: 500 }
    );
  }
}
