import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/apiAuth";
import {
  getUserById,
  updateUserAdminStatus,
  deleteUser as deleteManagedUser,
  countAdminUsers,
} from "@/lib/users";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, { params }: Params) {
  const currentUser = await requireAdmin();
  if (currentUser instanceof NextResponse) return currentUser;

  const { id } = await params;
  const target = getUserById(id);

  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  if (typeof body?.isAdmin !== "boolean") {
    return NextResponse.json(
      { error: "isAdmin boolean is required" },
      { status: 400 }
    );
  }

  if (!body.isAdmin && target.isDefaultAdmin) {
    return NextResponse.json(
      { error: "Cannot demote default admin" },
      { status: 400 }
    );
  }

  if (!body.isAdmin && target.isAdmin && countAdminUsers() <= 1) {
    return NextResponse.json(
      { error: "Cannot remove the last admin" },
      { status: 400 }
    );
  }

  const ok = updateUserAdminStatus(id, body.isAdmin);
  if (!ok) {
    return NextResponse.json(
      { error: "Failed to update user" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(_req: Request, { params }: Params) {
  const currentUser = await requireAdmin();
  if (currentUser instanceof NextResponse) return currentUser;

  const { id } = await params;
  const target = getUserById(id);

  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (id === currentUser.id) {
    return NextResponse.json(
      { error: "You cannot delete your own account here" },
      { status: 400 }
    );
  }

  if (target.isDefaultAdmin) {
    return NextResponse.json(
      { error: "Cannot delete default admin" },
      { status: 400 }
    );
  }

  if (target.isAdmin && countAdminUsers() <= 1) {
    return NextResponse.json(
      { error: "Cannot delete the last admin" },
      { status: 400 }
    );
  }

  const deleted = deleteManagedUser(id);
  if (!deleted) {
    return NextResponse.json(
      { error: "Failed to delete user" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
