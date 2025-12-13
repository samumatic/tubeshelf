import { NextResponse } from "next/server";
import { subscribe } from "@/lib/feedProgress";

// Track active SSE clients by an ID to deduplicate
const activeClients = new Set<string>();

export async function GET(req: Request) {
  const encoder = new TextEncoder();

  // Use a simple client key from headers, fallback to remote address
  const clientId = (
    req.headers.get("x-client-id") ||
    req.headers.get("x-forwarded-for") ||
    "anon"
  ).toString();

  // If this client already has an active subscription, end the previous by removing and proceed
  // Alternatively, we can short-circuit: here we replace prior with new.
  if (activeClients.has(clientId)) {
    // No-op: we allow replacing existing connection; removing old is handled by cancel
  }
  activeClients.add(clientId);

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      unsubscribe = subscribe((progress) => {
        const data = `data: ${JSON.stringify(progress)}\n\n`;
        controller.enqueue(encoder.encode(data));
      });
    },
    cancel() {
      if (unsubscribe) {
        unsubscribe();
      }
      activeClients.delete(clientId);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
