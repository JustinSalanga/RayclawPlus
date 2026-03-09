import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const runtimeProjectDir = path.join(rootDir, "browser-runtime");
const runtimePackagePath = path.join(runtimeProjectDir, "package.json");
const bundleRoot = path.join(rootDir, "src-tauri", "resources", "agent-browser");
const bundleAppDir = path.join(bundleRoot, "app");
const bundleNodeDir = path.join(bundleRoot, "node");
const bundleBrowsersDir = path.join(bundleRoot, "ms-playwright");
const bundleManifestPath = path.join(bundleRoot, "manifest.json");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sameManifest(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const runtimePackage = readJson(runtimePackagePath);
const nodeBinaryPath = process.execPath;
const nodeBinaryName = path.basename(nodeBinaryPath);
const desiredManifest = {
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  nodeBinaryName,
  dependencies: runtimePackage.dependencies,
};

const expectedEntryPath = path.join(
  bundleAppDir,
  "node_modules",
  "agent-browser",
  "bin",
  "agent-browser.js",
);
const expectedNodePath = path.join(bundleNodeDir, nodeBinaryName);

if (
  existsSync(bundleManifestPath) &&
  existsSync(expectedNodePath) &&
  existsSync(expectedEntryPath) &&
  existsSync(bundleBrowsersDir)
) {
  const existingManifest = readJson(bundleManifestPath);
  if (sameManifest(existingManifest, desiredManifest)) {
    console.log("agent-browser runtime already prepared");
    process.exit(0);
  }
}

mkdirSync(runtimeProjectDir, { recursive: true });
mkdirSync(bundleRoot, { recursive: true });

const npmCliPath = path.join(path.dirname(nodeBinaryPath), "node_modules", "npm", "bin", "npm-cli.js");

run(nodeBinaryPath, [npmCliPath, "install", "--omit=dev", "--no-package-lock"], {
  cwd: runtimeProjectDir,
  env: { ...process.env },
});

const agentBrowserCli = path.join(
  runtimeProjectDir,
  "node_modules",
  "agent-browser",
  "bin",
  "agent-browser.js",
);

run(nodeBinaryPath, [agentBrowserCli, "install"], {
  cwd: runtimeProjectDir,
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: bundleBrowsersDir,
  },
});

rmSync(bundleAppDir, { recursive: true, force: true });
rmSync(bundleNodeDir, { recursive: true, force: true });

mkdirSync(bundleAppDir, { recursive: true });
mkdirSync(bundleNodeDir, { recursive: true });

cpSync(path.join(runtimeProjectDir, "node_modules"), path.join(bundleAppDir, "node_modules"), {
  recursive: true,
  force: true,
});
cpSync(runtimePackagePath, path.join(bundleAppDir, "package.json"), {
  force: true,
});
cpSync(nodeBinaryPath, expectedNodePath, { force: true });

writeFileSync(bundleManifestPath, JSON.stringify(desiredManifest, null, 2));

console.log(`Bundled agent-browser runtime prepared at ${bundleRoot}`);
