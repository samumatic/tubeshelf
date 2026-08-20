import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/currentUser";
import { shouldUseSecureCookies } from "@/lib/cookieSecurity";
import { deleteUser } from "@/lib/users";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (user.isDefaultAdmin) {
    return NextResponse.json(
      { error: "Default admin account cannot be deleted" },
      { status: 400 }
    );
  }

  const deleted = deleteUser(user.id);
  if (!deleted) {
    return NextResponse.json(
      { error: "Failed to delete account" },
      { status: 500 }
    );
  }

  const cookieStore = await cookies();
  const secure = shouldUseSecureCookies(req);
  cookieStore.set(secure ? "__Secure-session" : "session", "", {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  return NextResponse.json({ success: true });
}
