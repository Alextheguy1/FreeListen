// YouTube now requires running a bit of JS to decrypt some formats' URLs.
// yt-dlp only supports Deno for that, so this fetches a portable copy into
// bin/ automatically on `npm install` - no system-wide install needed.
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");

const BIN_DIR = path.join(__dirname, "..", "bin");
const DENO_PATH = path.join(BIN_DIR, process.platform === "win32" ? "deno.exe" : "deno");

const ASSET_BY_PLATFORM = {
  win32: "deno-x86_64-pc-windows-msvc.zip",
  darwin: process.arch === "arm64" ? "deno-aarch64-apple-darwin.zip" : "deno-x86_64-apple-darwin.zip",
  linux: process.arch === "arm64" ? "deno-aarch64-unknown-linux-gnu.zip" : "deno-x86_64-unknown-linux-gnu.zip",
};

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(download(res.headers.location, destPath));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  if (fs.existsSync(DENO_PATH)) {
    console.log("Deno already present, skipping download.");
    return;
  }

  const asset = ASSET_BY_PLATFORM[process.platform];
  if (!asset) {
    console.warn(
      `No known Deno build for platform "${process.platform}". ` +
      `Install Deno yourself (https://deno.com) and place the binary at ${DENO_PATH}, ` +
      `or make sure "deno" is available on your PATH.`
    );
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const zipPath = path.join(BIN_DIR, "deno.zip");
  const url = `https://github.com/denoland/deno/releases/latest/download/${asset}`;

  console.log(`Downloading Deno (${asset})...`);
  await download(url, zipPath);

  const AdmZip = tryRequireAdmZip();
  if (AdmZip) {
    new AdmZip(zipPath).extractAllTo(BIN_DIR, true);
  } else {
    // No unzip dependency: shell out to a platform unzip tool instead of
    // adding another package just for this one-time setup step.
    const { execFileSync } = require("child_process");
    if (process.platform === "win32") {
      execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${BIN_DIR}' -Force`,
      ]);
    } else {
      execFileSync("unzip", ["-o", zipPath, "-d", BIN_DIR]);
    }
  }

  fs.rmSync(zipPath, { force: true });
  if (process.platform !== "win32") fs.chmodSync(DENO_PATH, 0o755);
  console.log(`Deno installed at ${DENO_PATH}`);
}

function tryRequireAdmZip() {
  try { return require("adm-zip"); } catch { return null; }
}

main().catch(err => {
  console.warn("Could not set up Deno automatically:", err.message);
  console.warn(`YouTube downloads may fail without it. See README.md for manual setup.`);
});
