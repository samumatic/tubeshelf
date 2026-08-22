import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { getUserByEmail, updateUser } from "@/lib/users";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  return NextResponse.json({
    id: user.id,
    name: user.name,
    email: user.email,
    authType: user.authType,
    oidcProvider: user.oidcProvider,
  });
}

export async function PUT(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  if (user.authType === "oidc") {
    return NextResponse.json(
      { error: "OIDC-managed users cannot edit local profile" },
      { status: 403 }
    );
  }

  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : user.name;
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : user.email;

  if (!email || !isValidEmail(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const existing = getUserByEmail(email);
  if (existing && existing.id !== user.id) {
    return NextResponse.json(
      { error: "Email already in use" },
      { status: 409 }
    );
  }

  try {
    updateUser(user.id, { name, email });
    return NextResponse.json({ success: true, name, email });
  } catch (error) {
    console.error("[User] Failed to update profile:", error);
    return NextResponse.json(
      { error: "Failed to update profile" },
      { status: 500 }
    );
  }
}
