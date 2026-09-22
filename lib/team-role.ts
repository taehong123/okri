export const TEAM_ROLES = ["owner", "admin", "member", "viewer"] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Membership roles come from persisted and imported workspace data, so treat
 * them as untrusted at every read boundary. Unknown values must fail closed.
 */
export function normalizeTeamRole(value: unknown, fallback: TeamRole = "viewer"): TeamRole {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return TEAM_ROLES.includes(normalized as TeamRole) ? normalized as TeamRole : fallback;
}
