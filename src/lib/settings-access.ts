import { roleAtLeast } from "@/lib/auth/authz";
import type { WorkspaceRole } from "@/lib/types/database";

export type SettingsSection = "domains" | "mailboxes" | "team" | "templates" | "integrations" | "usage";

type SectionDef = { key: SettingsSection; label: string; description: string; minRole: WorkspaceRole };

/**
 * Who can open each settings section. Server pages and actions enforce this
 * independently of the navigation (hiding a link is never the check).
 *   - Templates and Usage are readable by every member (RLS allows it);
 *     editing templates needs admin.
 *   - Everything else is owner/admin only.
 * NOTE: none of these grant access to message content — that needs a mailbox grant.
 */
export const SETTINGS_SECTIONS: SectionDef[] = [
  { key: "domains", label: "Domains", description: "Sending and receiving domains, DNS records", minRole: "admin" },
  { key: "mailboxes", label: "Mailboxes", description: "Addresses and who can read or send from them", minRole: "admin" },
  { key: "team", label: "Team", description: "Members, roles and invitations", minRole: "admin" },
  { key: "templates", label: "Templates", description: "Reusable subjects and bodies", minRole: "member" },
  { key: "integrations", label: "Integrations", description: "API keys for transactional sending", minRole: "admin" },
  { key: "usage", label: "Usage", description: "Monthly sending against your limit", minRole: "member" },
];

export function canAccessSection(role: WorkspaceRole | null | undefined, section: SettingsSection): boolean {
  const def = SETTINGS_SECTIONS.find((s) => s.key === section);
  return def ? roleAtLeast(role, def.minRole) : false;
}

export function accessibleSections(role: WorkspaceRole | null | undefined): SectionDef[] {
  return SETTINGS_SECTIONS.filter((s) => roleAtLeast(role, s.minRole));
}
