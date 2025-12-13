import { NextResponse } from "next/server";
import {
  readLists,
  createList,
  updateList,
  deleteList,
} from "@/lib/subscriptionListStore";

export async function GET() {
  const data = await readLists();
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const { action, name, listId, updates } = body || {};

  try {
    if (action === "create") {
      if (!name) {
        console.error("[API] Create list failed: Name required");
        return NextResponse.json(
          { error: "List name required" },
          { status: 400 }
        );
      }
      const newList = await createList(name);
      return NextResponse.json(newList);
    } else if (action === "update") {
      if (!listId) {
        console.error("[API] Update list failed: List ID required");
        return NextResponse.json(
          { error: "List ID required" },
          { status: 400 }
        );
      }
      await updateList(listId, updates);
      const data = await readLists();
      return NextResponse.json(data);
    } else if (action === "delete") {
      if (!listId) {
        console.error("[API] Delete list failed: List ID required");
        return NextResponse.json(
          { error: "List ID required" },
          { status: 400 }
        );
      }
      await deleteList(listId);
      const data = await readLists();
      return NextResponse.json(data);
    } else {
      console.error(
        "[API] Subscription list operation failed: Unknown action",
        { action }
      );
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err: any) {
    console.error("[API] Subscription list operation error", {
      action,
      listId,
      error: err?.message || String(err),
      stack: err?.stack,
    });
    return NextResponse.json(
      { error: err?.message || "Operation failed" },
      { status: 400 }
    );
  }
}
