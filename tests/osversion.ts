/**
 * macOS operating system version utilities.
 *
 * Provides cached access to the current OS version and helpers for comparing
 * it against a target version. All reads after the first go through the cache
 * so `NSProcessInfo` is only called once per process lifetime.
 */

import { NSProcessInfo } from "../src/Foundation";

// --- Types ---

export interface OSVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

// --- Cache ---

let cached: OSVersion | undefined;

// --- Core ---

/** Return the current macOS version, reading from cache after the first call. */
export function getOSVersion(): OSVersion {
  if (cached !== undefined) return cached;
  const raw = NSProcessInfo.processInfo().operatingSystemVersion();
  cached = { major: raw.field0, minor: raw.field1, patch: raw.field2 };
  return cached;
}

/** Invalidate the cached version (useful in tests). */
export function clearOSVersionCache(): void {
  cached = undefined;
}

// --- Comparison ---

/**
 * Compare two OS versions.
 *
 * Returns a negative number if `a < b`, 0 if equal, positive if `a > b`.
 */
export function compareVersions(a: OSVersion, b: OSVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Returns true if the current OS version is at least `target`. */
export function isAtLeast(target: OSVersion): boolean {
  return compareVersions(getOSVersion(), target) >= 0;
}

/** Returns true if the current OS version is strictly before `target`. */
export function isBefore(target: OSVersion): boolean {
  return compareVersions(getOSVersion(), target) < 0;
}

/** Returns true if the current OS version exactly matches `target`. */
export function isExactly(target: OSVersion): boolean {
  return compareVersions(getOSVersion(), target) === 0;
}

// --- Convenience constructors ---

/** Build a version object from major/minor/patch components. */
export function version(
  major: number,
  minor: number = 0,
  patch: number = 0
): OSVersion {
  return { major, minor, patch };
}

/** Format a version as a human-readable string, e.g. `"15.3.1"`. */
export function formatVersion(v: OSVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

// --- Named macOS release versions ---

export const macOS = {
  Tahoe: version(26),
  Sequoia: version(15),
  Sonoma: version(14),
  Ventura: version(13),
  Monterey: version(12),
  BigSur: version(11),
  Catalina: version(10, 15),
  Mojave: version(10, 14),
  HighSierra: version(10, 13),
  Sierra: version(10, 12),
} as const;

// --- Demo ---

if (import.meta.main) {
  const v = getOSVersion();
  console.log(`macOS version: ${formatVersion(v)}`);
  console.log(`Is Sequoia or later: ${isAtLeast(macOS.Sequoia)}`);
  console.log(`Is before Sonoma:    ${isBefore(macOS.Sonoma)}`);
  console.log(`Is exactly Sonoma:   ${isExactly(macOS.Sonoma)}`);

  // Second call uses cache — NSProcessInfo is not invoked again.
  const v2 = getOSVersion();
  console.log(`Cached result matches: ${v === v2}`);
}
