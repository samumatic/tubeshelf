import packageJson from "@/package.json";

/**
 * Release images are built without a channel and report the plain
 * package.json version; dev images report e.g. "1.4.0-dev.7088021".
 */
export function formatVersion(
  baseVersion: string,
  channel?: string,
  commit?: string
): string {
  if (!channel) return baseVersion;
  const shortCommit = commit?.slice(0, 7);
  return shortCommit
    ? `${baseVersion}-${channel}.${shortCommit}`
    : `${baseVersion}-${channel}`;
}

export function getAppVersion(): string {
  return formatVersion(
    packageJson.version,
    process.env.TUBESHELF_BUILD_CHANNEL || undefined,
    process.env.TUBESHELF_BUILD_COMMIT || undefined
  );
}
