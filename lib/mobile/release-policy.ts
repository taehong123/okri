export type PlatformRelease = { version: string; build: string; fullyAvailableAt: string };
export type Retirement = { version: string; announcedAt: string; endsAt: string };
export type PlatformRegistry = { storeUrl: string | null; releases: PlatformRelease[]; retirements: Retirement[] };
export type ReleaseRegistry = { schemaVersion: 1; ios: PlatformRegistry; android: PlatformRegistry };
export type MobilePolicy = { schemaVersion: 1; apiVersion: 1; platform: "ios" | "android"; latestVersion: string | null; storeUrl: string | null; retiredVersions: string[]; checkedAt: string };
const day = 86400000;
export function compareVersions(a: string, b: string) {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!pattern.test(a) || !pattern.test(b)) throw new Error("Invalid release version");
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  if (![...x, ...y].every(Number.isSafeInteger)) throw new Error("Invalid release version");
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export function validStoreUrl(platform: "ios" | "android", value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    return platform === "android"
      ? url.hostname === "play.google.com" && url.pathname === "/store/apps/details" && url.search === "?id=ai.okri.app"
      : url.hostname === "apps.apple.com" && /^\/(?:[a-z]{2}\/)?app\/(?:[a-z0-9-]+\/)?id[0-9]+$/.test(url.pathname) && !url.search;
  } catch { return false; }
}
const time = (value: string) => {
  const result = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || !Number.isFinite(result) || new Date(result).toISOString().replace(".000Z", "Z") !== value) throw new Error("Invalid release timestamp");
  return result;
};
export function validateRegistry(registry: ReleaseRegistry) {
  if (registry.schemaVersion !== 1) throw new Error("Unsupported registry");
  for (const platform of ["ios", "android"] as const) {
    const value = registry[platform];
    if (!value || !Array.isArray(value.releases) || !Array.isArray(value.retirements)) throw new Error("Invalid platform registry");
    if (value.storeUrl !== null && !validStoreUrl(platform, value.storeUrl)) throw new Error("Invalid store URL");
    if (value.releases.length && !value.storeUrl) throw new Error("Store availability requires a verified listing URL");
    const versions = new Set<string>();
    for (const release of value.releases) {
      compareVersions(release.version, release.version);
      time(release.fullyAvailableAt);
      if (!/^[0-9]+$/.test(release.build) || versions.has(release.version)) throw new Error("Invalid or duplicate release");
      versions.add(release.version);
    }
    const retired = new Set<string>();
    for (const entry of value.retirements) {
      if (!versions.has(entry.version) || retired.has(entry.version)) throw new Error("Invalid or duplicate retirement");
      retired.add(entry.version);
      const announced = time(entry.announcedAt), ends = time(entry.endsAt);
      const successors = value.releases.filter(r => compareVersions(r.version, entry.version) > 0).sort((a, b) => time(a.fullyAvailableAt) - time(b.fullyAvailableAt));
      // Both requirements apply, separately for each store. No short-lived
      // TestFlight/internal/staged rollout is a generally available successor.
      if (successors.length < 2 || time(successors[1].fullyAvailableAt) > ends
        || time(successors[0].fullyAvailableAt) + 180 * day > ends || announced + 30 * day > ends) {
        throw new Error("Retirement violates 180-day, two-successor or 30-day notice policy");
      }
    }
  }
}
export function publicPolicy(registry: ReleaseRegistry, platform: "ios" | "android", now = new Date()): MobilePolicy {
  validateRegistry(registry);
  const current = registry[platform], at = now.getTime();
  const available = current.releases.filter(r => time(r.fullyAvailableAt) <= at).sort((a, b) => compareVersions(b.version, a.version));
  return { schemaVersion: 1, apiVersion: 1, platform, latestVersion: available[0]?.version ?? null,
    storeUrl: available.length ? current.storeUrl : null,
    retiredVersions: current.retirements.filter(r => time(r.endsAt) <= at).map(r => r.version),
    checkedAt: now.toISOString() };
}
// Policy is advisory. Offline, malformed or unpublished policy must not lock
// people out, erase a draft, or send them to an unverified store/external URL.
export function updateOffer(value: unknown, platform: string, installed: string): { url: string; retired: boolean } | null {
  if (!value || typeof value !== "object" || (platform !== "ios" && platform !== "android")) return null;
  const policy = value as MobilePolicy;
  if (policy.schemaVersion !== 1 || policy.apiVersion !== 1 || policy.platform !== platform || !validStoreUrl(platform, policy.storeUrl) || !policy.latestVersion || !Array.isArray(policy.retiredVersions)) return null;
  try {
    return compareVersions(policy.latestVersion, installed) > 0 ? { url: policy.storeUrl, retired: policy.retiredVersions.includes(installed) } : null;
  } catch { return null; }
}
