/** Names only in failures: a CI log must never print a signing credential. */
export function requireSigning(platform, env) {
  const names =
    platform === "darwin"
      ? [
          "CSC_LINK",
          "CSC_KEY_PASSWORD",
          "MAC_SIGNING_IDENTITY",
          "APPLE_ID",
          "APPLE_APP_SPECIFIC_PASSWORD",
          "APPLE_TEAM_ID",
        ]
      : platform === "win32"
        ? ["CSC_LINK", "CSC_KEY_PASSWORD", "WINDOWS_PUBLISHER_NAME"]
        : [];
  if (!names.length)
    throw new Error("Signed releases support macOS and Windows only.");
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length)
    throw new Error(
      `Signed release requires: ${missing.join(", ")}. See docs/releases.md.`,
    );
  if (
    platform === "darwin" &&
    !env.MAC_SIGNING_IDENTITY.startsWith("Developer ID Application:")
  ) {
    throw new Error(
      "MAC_SIGNING_IDENTITY must name a Developer ID Application certificate.",
    );
  }
}

export function releaseVersion(base, run, attempt) {
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(base) ||
    !/^[1-9]\d*$/.test(run ?? "") ||
    !/^[1-9]\d*$/.test(attempt ?? "")
  ) {
    throw new Error(
      "Release version requires a semver base and positive GitHub run/attempt numbers.",
    );
  }
  // +metadata has no semver precedence. Reusing the source version would
  // leave every installed copy believing that the next commit is identical.
  return `${base}${base.includes("-") ? "." : "-build."}${run}.${attempt}`;
}
