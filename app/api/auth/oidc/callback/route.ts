import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuth } from "@/lib/betterAuth";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const error = searchParams.get("error");

    // Get base URL from request (respects reverse proxy headers)
    const forwardedHost = req.headers.get("x-forwarded-host");
    const forwardedProto = req.headers.get("x-forwarded-proto");
    const url = new URL(req.url);
    const baseUrl = forwardedHost
      ? `${forwardedProto || url.protocol.replace(":", "")}://${forwardedHost}`
      : `${url.protocol}//${url.host}`;

    if (error) {
      console.error("[OIDC] Authorization error:", error);
      return NextResponse.redirect(`${baseUrl}/?auth_error=${error}`);
    }

    if (!code || !state) {
      return NextResponse.json(
        { error: "Missing code or state" },
        { status: 400 }
      );
    }

    const cookieStore = await cookies();
    const providerId =
      searchParams.get("provider") || cookieStore.get("oidc_provider")?.value;

    if (!providerId) {
      return NextResponse.json(
        { error: "Missing provider ID" },
        { status: 400 }
      );
    }

    const auth = await getAuth(req);
    return await auth.api.callbackOAuth({
      headers: req.headers,
      params: { id: providerId },
      query: {
        code,
        state,
        error: error || undefined,
        error_description: searchParams.get("error_description") || undefined,
        iss: searchParams.get("iss") || undefined,
      },
      asResponse: true,
    });
  } catch (error) {
    console.error("[OIDC] Callback error:", error);
    const forwardedHost = req.headers.get("x-forwarded-host");
    const forwardedProto = req.headers.get("x-forwarded-proto");
    const url = new URL(req.url);
    const baseUrl = forwardedHost
      ? `${forwardedProto || url.protocol.replace(":", "")}://${forwardedHost}`
      : `${url.protocol}//${url.host}`;
    return NextResponse.redirect(`${baseUrl}/?auth_error=callback_failed`);
  }
}
