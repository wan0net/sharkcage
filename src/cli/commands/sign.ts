/**
 * sc sign <path>
 *
 * Sign a skill manifest with an Ed25519 keypair stored at
 * ~/.config/sharkcage/signing-key.json. Generates the keypair on first run.
 */

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "sharkcage");
const KEY_FILE = join(CONFIG_DIR, "signing-key.json");

interface SigningKey {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
  createdAt: string;
}

function computeFingerprint(publicKeyPem: string): string {
  const hash = createHash("sha256").update(publicKeyPem).digest("hex");
  return `sha256:${hash.slice(0, 16)}`;
}

function loadOrGenerateKey(): SigningKey {
  if (existsSync(KEY_FILE)) {
    return JSON.parse(readFileSync(KEY_FILE, "utf-8")) as SigningKey;
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const fingerprint = computeFingerprint(publicKey);
  const key: SigningKey = { publicKey, privateKey, fingerprint, createdAt: new Date().toISOString() };

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify(key, null, 2), { mode: 0o600 });
  console.log(`Generated new signing key: ${fingerprint}`);
  return key;
}

function collectSourceFiles(dir: string, base: string, results: string[]): void {
  const skip = new Set(["node_modules", ".git", "dist"]);
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    const rel = join(base, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, rel, results);
    } else {
      results.push(rel);
    }
  }
}

function computeHash(pluginPath: string, manifest: Record<string, unknown>): Buffer {
  // Strip signature fields before hashing
  const { signature: _sig, signer: _signer, ...cleanManifest } = manifest;
  void _sig; void _signer;

  const hash = createHash("sha256");
  hash.update(JSON.stringify(cleanManifest));

  const files: string[] = [];
  collectSourceFiles(pluginPath, "", files);
  files.sort();

  for (const rel of files) {
    if (rel === "plugin.json") continue; // manifest content already hashed above
    hash.update(readFileSync(join(pluginPath, rel)));
  }

  return hash.digest();
}

export default async function signCommand(): Promise<void> {
  const path = process.argv[3];
  if (!path) {
    console.error("Usage: sc sign <plugin-path>");
    process.exit(1);
  }

  const pluginPath = path.startsWith("/") ? path : join(process.cwd(), path);
  const manifestPath = join(pluginPath, "plugin.json");

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    console.error(`Cannot read plugin.json: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const key = loadOrGenerateKey();
  const hash = computeHash(pluginPath, manifest);

  const sigBuffer = sign(null, hash, key.privateKey);
  const signature = sigBuffer.toString("base64");

  manifest.signature = signature;
  manifest.signer = key.fingerprint;

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Signed ${manifest.name} with ${key.fingerprint}`);
}
