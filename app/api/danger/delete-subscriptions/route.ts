import { NextResponse } from "next/server";
import { writeSubscriptions } from "@/lib/subscriptionStore";

export async function POST() {
  try {
    await writeSubscriptions([]);
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
