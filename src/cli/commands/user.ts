/**
 * sc user — manage the dedicated OpenClaw user
 *
 * Commands:
 *   copy-in <path> [--mode <perms>] [--dest <path>]  Copy files into the user's home
 *   shell                                              Open a shell as the user
 *   home                                               Print the user's home directory
 *   info                                               Show user details
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { getGatewayConfigPath, getConfigDir, loadManifest } from "../lib/paths.ts";

function getRunAsUser(): string | null {
  try {
    const config = JSON.parse(readFileSync(getGatewayConfigPath(), "utf-8"));
    return config.runAsUser ?? null;
  } catch {
    return null;
  }
}

function getUserHome(username: string): string {
  try {
    return execFileSync("getent", ["passwd", username], { encoding: "utf-8" })
      .trim().split(":")[5] ?? `/home/${username}`;
  } catch {
    return `/home/${username}`;
  }
}

export default async function user(action: string, args: string[], options: { mode?: string; dest?: string }) {
  const username = getRunAsUser();

  if (!username) {
    console.error("No dedicated user configured. Run 'sc init' and enable the dedicated user option.");
    process.exit(1);
  }

  switch (action) {
    case "copy-in":
      return copyIn(username, args, options);
    case "shell":
      return shell(username);
    case "home":
      return console.log(getUserHome(username));
    case "info":
      return info(username);
    default:
      console.error(`Unknown action: ${action}`);
      console.error("Usage: sc user <copy-in|shell|home|info>");
      process.exit(1);
  }
}

function copyIn(username: string, args: string[], options: { mode?: string; dest?: string }) {
  if (args.length === 0) {
    console.error("Usage: sc user copy-in <path> [--mode 600] [--dest <path>]");
    process.exit(1);
  }

  const sourcePath = resolve(args[0]);
  if (!existsSync(sourcePath)) {
    console.error(`Source not found: ${sourcePath}`);
    process.exit(1);
  }

  const userHome = getUserHome(username);
  const destPath = options.dest
    ? `${userHome}/${options.dest}`
    : `${userHome}/${basename(sourcePath)}`;

  const isDir = statSync(sourcePath).isDirectory();

  try {
    // Create parent directory
    const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
    execFileSync("sudo", ["-u", username, "mkdir", "-p", destDir], { stdio: "pipe" });

    // Copy
    if (isDir) {
      execFileSync("sudo", ["cp", "-r", sourcePath, destPath], { stdio: "pipe" });
    } else {
      execFileSync("sudo", ["cp", sourcePath, destPath], { stdio: "pipe" });
    }

    // Set ownership
    execFileSync("sudo", ["chown", "-R", `${username}:${username}`, destPath], { stdio: "pipe" });

    // Set permissions if specified
    if (options.mode) {
      if (isDir) {
        execFileSync("sudo", ["chmod", "-R", options.mode, destPath], { stdio: "pipe" });
      } else {
        execFileSync("sudo", ["chmod", options.mode, destPath], { stdio: "pipe" });
      }
      console.log(`Copied ${sourcePath} → ${destPath} (owner: ${username}, mode: ${options.mode})`);
    } else {
      console.log(`Copied ${sourcePath} → ${destPath} (owner: ${username}, perms preserved)`);
    }
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

function shell(username: string) {
  try {
    execFileSync("sudo", ["-u", username, "-i", "/bin/bash"], { stdio: "inherit" });
  } catch {
    // User exited the shell — not an error
  }
}

function info(username: string) {
  const userHome = getUserHome(username);
  console.log(`User:    ${username}`);
  console.log(`Home:    ${userHome}`);

  try {
    const id = execFileSync("id", [username], { encoding: "utf-8" }).trim();
    console.log(`ID:      ${id}`);
  } catch {
    console.log(`ID:      (user not found)`);
  }

  // Check if sudoers rule exists
  const sudoersPath = `/etc/sudoers.d/sharkcage-${username}`;
  console.log(`Sudoers: ${existsSync(sudoersPath) ? sudoersPath : "not configured"}`);

  // Check sharkcage install
  const manifest = loadManifest();
  if (manifest) {
    console.log(`Install:   ${manifest.installDir} (v${manifest.version})`);
  } else {
    console.log(`Install:   not found (no install manifest)`);
  }
}
