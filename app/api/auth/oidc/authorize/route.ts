import { NextResponse } from "next/server";
import { shouldUseSecureCookies } from "@/lib/cookieSecurity";
import { APIError } from "better-auth";
import { appendSetCookieHeaders, getAuth } from "@/lib/betterAuth";
import { getOIDCProvider } from "@/lib/oidc";

function getBaseUrl(req: Request): string {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const url = new URL(req.url);
  return forwardedHost
    ? `${forwardedProto || url.protocol.replace(":", "")}://${forwardedHost}`
    : `${url.protocol}//${url.host}`;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const providerId = searchParams.get("provider");

    if (!providerId) {
      return NextResponse.json(
        { error: "Provider ID is required" },
        { status: 400 }
      );
    }

    const provider = getOIDCProvider(providerId);
    if (!provider) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 404 });
    }

    const baseUrl = getBaseUrl(req);
    const auth = await getAuth(req);
    const result = await auth.api.signInSocial({
      body: {
        provider: providerId,
        callbackURL: `${baseUrl}/`,
        newUserCallbackURL: `${baseUrl}/`,
        errorCallbackURL: `${baseUrl}/`,
        disableRedirect: true,
      },
      headers: req.headers,
      returnHeaders: true,
      returnStatus: true,
    });

    const url = (result as any).response?.url;
    if (!url) {
      throw new Error("Missing OIDC redirect URL");
    }

    const response = NextResponse.redirect(url);

    // Preserve compatibility with the existing callback route that resolves provider ID from a cookie.
    response.cookies.set("oidc_provider", providerId, {
      httpOnly: true,
      secure: shouldUseSecureCookies(req),
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });

    appendSetCookieHeaders(response.headers, (result as any).headers);

    return response;
  } catch (error) {
    if (error instanceof APIError) {
      return NextResponse.json(
        { error: (error as any).message || "Authorization failed" },
        { status: (error as any).statusCode || 400 }
      );
    }
    console.error("[OIDC] Authorization error:", error);
    return NextResponse.json(
      { error: "Authorization failed" },
      { status: 500 }
    );
  }
}
