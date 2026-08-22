import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/apiAuth";
import { getAllUsers, countUsers, countAdminUsers } from "@/lib/users";

export async function GET() {
  const currentUser = await requireAdmin();
  if (currentUser instanceof NextResponse) return currentUser;

  const users = getAllUsers();
  const stats = {
    totalUsers: countUsers(),
    adminUsers: countAdminUsers(),
  };

  return NextResponse.json({ users, stats });
}
