import { createPrivateKey, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";

const API_BASE = "https://api.appstoreconnect.apple.com/v1";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function createToken({ issuerId, keyId, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 15 * 60, aud: "appstoreconnect-v1" }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey(privateKey),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function apiRequest(token, path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = payload?.errors
      ?.map((error) => `${error.status ?? response.status} ${error.title ?? ""}: ${error.detail ?? ""}`)
      .join("; ");
    throw new Error(`Apple API ${options.method ?? "GET"} ${path} failed: ${detail || response.status}`);
  }
  return payload;
}

function normalizeSerial(value) {
  return value.replaceAll(":", "").replace(/^0+/, "").toUpperCase();
}

async function ensurePushCapability(token, bundleId) {
  const response = await apiRequest(token, `/bundleIds/${bundleId}/bundleIdCapabilities`);
  const exists = response.data.some(
    (capability) => capability.attributes.capabilityType === "PUSH_NOTIFICATIONS",
  );
  if (exists) return;

  await apiRequest(token, "/bundleIdCapabilities", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "bundleIdCapabilities",
        attributes: { capabilityType: "PUSH_NOTIFICATIONS" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundleId } },
        },
      },
    }),
  });
}

async function findCertificate(token, serialNumber) {
  const response = await apiRequest(token, "/certificates?limit=200");
  const wanted = normalizeSerial(serialNumber);
  return response.data.find(
    (certificate) => normalizeSerial(certificate.attributes.serialNumber ?? "") === wanted,
  );
}

async function getOrCreateProfile(token, { name, bundleId, certificateId }) {
  const params = new URLSearchParams({ "filter[name]": name, limit: "10" });
  const existing = await apiRequest(token, `/profiles?${params}`);
  const active = existing.data.find(
    (profile) =>
      profile.attributes.profileType === "IOS_APP_STORE" &&
      profile.attributes.profileState === "ACTIVE" &&
      profile.attributes.profileContent,
  );
  if (active) return active;

  const created = await apiRequest(token, "/profiles", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "profiles",
        attributes: { name, profileType: "IOS_APP_STORE" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundleId } },
          certificates: { data: [{ type: "certificates", id: certificateId }] },
        },
      },
    }),
  });
  return created.data;
}

async function main() {
  const issuerId = requireEnv("ASC_ISSUER_ID");
  const keyId = requireEnv("ASC_KEY_ID");
  const privateKeyPath = requireEnv("ASC_KEY_PATH");
  const bundleIdentifier = requireEnv("APPLE_BUNDLE_IDENTIFIER");
  const profileName = requireEnv("APPLE_PROFILE_NAME");
  const certificateSerial = requireEnv("IOS_CERTIFICATE_SERIAL");
  const outputPath = requireEnv("IOS_PROFILE_PATH");
  const privateKey = await import("node:fs/promises").then(({ readFile }) =>
    readFile(privateKeyPath, "utf8"),
  );
  const token = createToken({ issuerId, keyId, privateKey });

  const bundleParams = new URLSearchParams({
    "filter[identifier]": bundleIdentifier,
    limit: "1",
  });
  const bundles = await apiRequest(token, `/bundleIds?${bundleParams}`);
  const bundle = bundles.data[0];
  if (!bundle) throw new Error(`Apple bundle ID not found: ${bundleIdentifier}`);

  await ensurePushCapability(token, bundle.id);
  const certificate = await findCertificate(token, certificateSerial);
  if (!certificate) {
    throw new Error("The configured Apple distribution certificate is not active in this team.");
  }

  const profile = await getOrCreateProfile(token, {
    name: profileName,
    bundleId: bundle.id,
    certificateId: certificate.id,
  });
  await writeFile(outputPath, Buffer.from(profile.attributes.profileContent, "base64"), {
    mode: 0o600,
  });
  console.log(`Prepared Apple provisioning profile ${profile.attributes.uuid}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
