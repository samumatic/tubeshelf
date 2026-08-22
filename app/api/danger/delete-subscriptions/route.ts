import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { clearAllSubscriptions } from "@/lib/subscriptionListStore";

export async function POST() {
  try {
    const user = await requireUser();
    if (user instanceof NextResponse) return user;

    await clearAllSubscriptions(user.id);
    return NextResponse.json({
      success: true,
      message: "All subscriptions deleted",
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to delete subscriptions" },
      { status: 400 }
    );
  }
}
