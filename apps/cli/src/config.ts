import fs from "node:fs";
import path from "node:path";

export interface LocalCtxConfig {
  schema_version: number;
  project_id: string;
  project_name?: string;
  api_base_url: string;
  default_branch: string;
}

export function getCtxDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".ctx");
}

export function getCtxConfigPath(cwd: string = process.cwd()): string {
  return path.join(getCtxDir(cwd), "config.json");
}

export function loadLocalConfig(cwd: string = process.cwd()): LocalCtxConfig | null {
  const configPath = getCtxConfigPath(cwd);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveLocalConfig(config: LocalCtxConfig, cwd: string = process.cwd()): void {
  const dir = getCtxDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getCtxConfigPath(cwd), JSON.stringify(config, null, 2), "utf-8");
}
