import { isIPv4 } from "node:net";
import type { ScopeEntry, ScopeEntryInput } from "./types.js";

export interface ScopeQuery {
  readonly kind: ScopeEntryInput["kind"];
  readonly value: string;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function ipToInt(ip: string): number | undefined {
  if (!isIPv4(ip)) {
    return undefined;
  }
  const parts = ip.split(".").map((part) => Number(part));
  const [a, b, c, d] = parts;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return undefined;
  }
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function cidrContains(cidr: string, ip: string): boolean {
  const [network, prefixRaw] = cidr.split("/");
  if (!network || prefixRaw === undefined) {
    return false;
  }
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const networkInt = ipToInt(network);
  const ipInt = ipToInt(ip);
  if (networkInt === undefined || ipInt === undefined) {
    return false;
  }
  if (prefix === 0) {
    return true;
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (networkInt & mask) === (ipInt & mask);
}

function domainMatches(rule: string, candidate: string): boolean {
  const allowed = normalizeHost(rule);
  const value = normalizeHost(candidate);
  return value === allowed || value.endsWith(`.${allowed}`);
}

function entryMatches(entry: ScopeEntry, query: ScopeQuery): boolean {
  const rule = entry.value.trim();
  const value = query.value.trim();

  if (entry.kind === "cidr") {
    if (query.kind === "ip" || query.kind === "host") {
      return cidrContains(rule, value);
    }
    return false;
  }

  if (entry.kind === "ip") {
    return (query.kind === "ip" || query.kind === "host") && rule === value;
  }

  if (entry.kind === "domain") {
    if (query.kind === "domain" || query.kind === "host") {
      return domainMatches(rule, value);
    }
    return false;
  }

  return normalizeHost(rule) === normalizeHost(value);
}

export function isAuthorizedTarget(
  scope: readonly ScopeEntry[],
  query: ScopeQuery,
): boolean {
  const denied = scope.filter((entry) => entry.direction === "deny");
  if (denied.some((entry) => entryMatches(entry, query))) {
    return false;
  }
  const allowed = scope.filter((entry) => entry.direction === "allow");
  return allowed.some((entry) => entryMatches(entry, query));
}
