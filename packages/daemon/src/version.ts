/**
 * The daemon's advertised version.
 *
 * A constant rather than a `require("../package.json")`: Step 21 bundles the
 * main process and the daemon into a single CJS file inside an asar archive,
 * where reading a sibling `package.json` at runtime is a packaging problem
 * rather than a one-liner. A literal survives bundling untouched.
 */
export const DAEMON_VERSION = "0.1.0-alpha";
