export type PeerVerificationLink = {
  kind: "domain" | "github";
  label: string;
  href: string;
};

function buildHttpsUrl(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(normalized) || normalized.includes("..")) {
    return null;
  }
  try {
    const url = new URL(`https://${normalized}`);
    if (url.hostname !== normalized) return null;
    return `https://${normalized}`;
  } catch {
    return null;
  }
}

export function isGithubName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(value);
}

export function isGithubRepository(value: string): boolean {
  return /^[a-z0-9._-]{1,100}$/i.test(value) && value !== "." && value !== "..";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Convert buyer-computed verification results into display-safe links.
 * Only successful verification results are surfaced; malformed cached data is
 * ignored so UI/CLI rendering cannot crash on old or hand-edited state files.
 */
export function collectPeerVerificationLinks(peer: { verificationResults?: unknown }): PeerVerificationLink[] {
  const results = asRecord(peer.verificationResults);
  if (!results) return [];
  const out: PeerVerificationLink[] = [];
  const seen = new Set<string>();

  const add = (link: PeerVerificationLink) => {
    const key = `${link.kind}\u0000${link.href}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(link);
  };

  const domains = Array.isArray(results.domains) ? results.domains : [];
  for (const raw of domains) {
    const rec = asRecord(raw);
    if (rec?.verified !== true || typeof rec.domain !== "string") continue;
    const href = buildHttpsUrl(rec.domain);
    if (!href) continue;
    add({ kind: "domain", label: rec.domain.trim().toLowerCase(), href });
  }

  const github = Array.isArray(results.github) ? results.github : [];
  for (const raw of github) {
    const rec = asRecord(raw);
    if (rec?.verified !== true || typeof rec.username !== "string") continue;
    const username = rec.username.trim().toLowerCase();
    if (!isGithubName(username)) continue;
    const repository = typeof rec.repository === "string" ? rec.repository.trim() : "";
    const hasRepository = repository.length > 0 && isGithubRepository(repository);
    const path = hasRepository ? `${username}/${repository}` : username;
    add({ kind: "github", label: `@${path}`, href: `https://github.com/${path}` });
  }

  return out;
}
