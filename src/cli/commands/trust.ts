/**
 * sc trust <fingerprint> [label]
 *
 * Add a signer to the trust store at ~/.config/sharkcage/trusted-signers.json.
 * If the fingerprint matches the user's own signing key, the public key is
 * pulled automatically. Otherwise, the user is prompted to paste the PEM.
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "sharkcage");
const KEY_FILE = join(CONFIG_DIR, "signing-key.json");
const TRUST_STORE = join(CONFIG_DIR, "trusted-signers.json");

interface TrustedSigner { label: string; publicKey: string; trustedAt: string; }
interface TrustStore { signers: Record<string, TrustedSigner>; }
interface SigningKey { publicKey: string; privateKey: string; fingerprint: string; createdAt: string; }

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function readPemFromStdin(prompt_: string): Promise<string> {
  return new Promise((resolve) => {
    console.log(prompt_);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines: string[] = [];
    rl.on("line", (line) => {
      lines.push(line);
      if (line.includes("-----END")) { rl.close(); resolve(lines.join("\n")); }
    });
  });
}

function loadTrustStore(): TrustStore {
  if (existsSync(TRUST_STORE)) {
    try { return JSON.parse(readFileSync(TRUST_STORE, "utf-8")); } catch { /* ignore */ }
  }
  return { signers: {} };
}

function verifyFingerprint(publicKeyPem: string, fingerprint: string): boolean {
  const hash = createHash("sha256").update(publicKeyPem).digest("hex");
  return `sha256:${hash.slice(0, 16)}` === fingerprint;
}

export default async function trustCommand(): Promise<void> {
  const fingerprint = process.argv[3];
  if (!fingerprint) {
    console.error("Usage: sc trust <fingerprint> [label]");
    process.exit(1);
  }

  let label = process.argv[4] ?? "";
  if (!label) {
    label = await prompt(`Label for ${fingerprint}: `);
    if (!label) { console.error("Label is required."); process.exit(1); }
  }

  // Check if this is the user's own key
  let publicKey = "";
  if (existsSync(KEY_FILE)) {
    const own = JSON.parse(readFileSync(KEY_FILE, "utf-8")) as SigningKey;
    if (own.fingerprint === fingerprint) {
      publicKey = own.publicKey;
      console.log("Using your own public key.");
    }
  }

  if (!publicKey) {
    publicKey = await readPemFromStdin("Paste the public key PEM (ending with -----END PUBLIC KEY-----):");
  }

  if (!verifyFingerprint(publicKey, fingerprint)) {
    console.error("Public key does not match fingerprint — aborting.");
    process.exit(1);
  }

  const store = loadTrustStore();
  store.signers[fingerprint] = { label, publicKey, trustedAt: new Date().toISOString() };

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TRUST_STORE, JSON.stringify(store, null, 2) + "\n");
  console.log(`Trusted ${fingerprint} (${label})`);
}
