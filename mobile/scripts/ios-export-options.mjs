export function iosExportOptions(teamId, profileUuid) {
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) throw new Error("Invalid Apple team ID");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(profileUuid ?? "")) {
    throw new Error("A valid OKRI App Store provisioning profile UUID is required");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>signingStyle</key><string>manual</string>
<key>signingCertificate</key><string>Apple Distribution</string>
<key>teamID</key><string>${teamId}</string>
<key>provisioningProfiles</key><dict><key>ai.okri.app</key><string>${profileUuid}</string></dict>
<key>manageAppVersionAndBuildNumber</key><false/>
<key>uploadSymbols</key><true/>
</dict></plist>\n`;
}
