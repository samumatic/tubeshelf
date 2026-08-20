"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export default function ClientOnly({
  children,
}: {
  children: React.ReactNode;
}) {
  // Renders nothing on the server and during hydration, then the children.
  const mounted = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  if (!mounted) return null;
  return <>{children}</>;
}
