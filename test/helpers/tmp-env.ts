import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestEnv {
  root: string;
  restore(): void;
}

export function createTestEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "sharkcage-test-"));
  const installDir = join(root, "install");
  const configDir = join(installDir, "etc");
  const dataDir = join(installDir, "var");
  const workspaceNodeModules = join(process.cwd(), "node_modules");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  symlinkSync(workspaceNodeModules, join(installDir, "node_modules"), "dir");

  const previous = {
    SHARKCAGE_DIR: process.env.SHARKCAGE_DIR,
    SHARKCAGE_CONFIG_DIR: process.env.SHARKCAGE_CONFIG_DIR,
    SHARKCAGE_DATA_DIR: process.env.SHARKCAGE_DATA_DIR,
    SHARKCAGE_PLUGIN_DIR: process.env.SHARKCAGE_PLUGIN_DIR,
    SHARKCAGE_SOCKET: process.env.SHARKCAGE_SOCKET,
    SHARKCAGE_ALLOW_INSECURE: process.env.SHARKCAGE_ALLOW_INSECURE,
  };

  process.env.SHARKCAGE_DIR = installDir;
  delete process.env.SHARKCAGE_CONFIG_DIR;
  delete process.env.SHARKCAGE_DATA_DIR;
  delete process.env.SHARKCAGE_PLUGIN_DIR;
  delete process.env.SHARKCAGE_SOCKET;
  delete process.env.SHARKCAGE_ALLOW_INSECURE;

  return {
    root,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
