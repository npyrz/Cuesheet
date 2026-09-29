import { requireSigning } from "./release-policy.mjs";

requireSigning(process.platform, process.env);

export default {
  extends: "./electron-builder.yml",
  forceCodeSigning: true,
  artifactName: "Cuesheet-${version}-${os}-${arch}.${ext}",
  detectUpdateChannel: false,
  generateUpdatesFilesForAllChannels: false,
  publish: {
    provider: "github",
    owner: "npyrz",
    repo: "Cuesheet",
    channel: "latest",
    releaseType: "release",
  },
  mac: {
    identity: process.env.MAC_SIGNING_IDENTITY,
    hardenedRuntime: true,
    notarize: true,
    entitlements: "assets/entitlements.mac.plist",
    entitlementsInherit: "assets/entitlements.mac.plist",
  },
  win: {
    verifyUpdateCodeSignature: true,
    signtoolOptions: { publisherName: process.env.WINDOWS_PUBLISHER_NAME },
  },
};
