import { NextResponse } from "next/server";

export async function POST() {
  try {
    return NextResponse.json({
      success: true,
      message: "All watch history cleared",
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to clear watch history" },
      { status: 400 }
    );
  }
}
