
const  fs = require( "fs");
const  path = require( "path");
const  axios = require( "axios");
const  { spawn, execSync } from "child_process";

const FILE_PATH = path.resolve("tmp");
if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const UUID = process.env.UUID || "792c9cd6-9ece-4ebc-ff02-86eaf8bf7e73";
const ARGO_PORT = 3000;
const ARGO_LOG = path.join(FILE_PATH, "argo.log");
const SINGBOX_CONF = path.join(FILE_PATH, "config.json");

const SINGBOX_URL =
  "https://github.com/SagerNet/sing-box/releases/download/v1.12.9/sing-box-1.12.9-linux-amd64.tar.gz";
const CLOUDFLARED_URL =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

async function downloadTo(url, outPath) {
  if (fs.existsSync(outPath)) return;
  const writer = fs.createWriteStream(outPath);
  const res = await axios({ url, method: "GET", responseType: "stream" });
  res.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
  fs.chmodSync(outPath, 0o755);
}

function extractSingBox(tarPath, dest) {
  execSync(`tar -xzf "${tarPath}" -C "${dest}"`);
  const extractedDir = fs.readdirSync(dest).find((d) => d.startsWith("sing-box"));
  const binPath = path.join(dest, extractedDir, "sing-box");
  const finalBin = path.join(dest, "sing-box");
  fs.copyFileSync(binPath, finalBin);
  fs.chmodSync(finalBin, 0o755);
  return finalBin;
}

function writeSingBoxConfig() {
  const cfg = {
    log: { level: "error" },
    inbounds: [
      {
        type: "vless",
        listen: "::",
        listen_port: ARGO_PORT,
        users: [{ uuid: UUID }],
        transport: { type: "ws", path: `/${UUID}`, max_early_data: 2048 }
      }
    ],
    outbounds: [{ type: "direct" }]
  };
  fs.writeFileSync(SINGBOX_CONF, JSON.stringify(cfg, null, 2));
}

function startSingBox(binPath) {
  spawn(binPath, ["run", "-c", SINGBOX_CONF], {
    detached: true,
    stdio: "ignore"
  }).unref();
}

function startCloudflared(binPath) {
  const out = fs.openSync(ARGO_LOG, "a");
  spawn(binPath, ["tunnel", "--url", `http://localhost:${ARGO_PORT}`], {
    detached: true,
    stdio: ["ignore", out, out]
  }).unref();
}

function pollArgoDomain(retries = 20, intervalMs = 2000) {
  return new Promise((resolve) => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (fs.existsSync(ARGO_LOG)) {
        const txt = fs.readFileSync(ARGO_LOG, "utf8");
        const m = txt.match(/https?:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
        if (m) {
          clearInterval(timer);
          return resolve(m[1]);
        }
      }
      if (attempts >= retries) {
        clearInterval(timer);
        return resolve(null);
      }
    }, intervalMs);
  });
}

export default async function runArgo() {
  const singboxTar = path.join(FILE_PATH, "sing-box.tar.gz");
  const cfBin = path.join(FILE_PATH, "cloudflared");

  await downloadTo(CLOUDFLARED_URL, cfBin);
  await downloadTo(SINGBOX_URL, singboxTar);

  const singboxBin = extractSingBox(singboxTar, FILE_PATH);

  writeSingBoxConfig();
  startSingBox(singboxBin);
  startCloudflared(cfBin);

  const domain = await pollArgoDomain();
  return domain
    ? {
        domain,
        link: `vless://${UUID}@${domain}:443?encryption=none&security=tls&type=ws&host=${domain}&path=%2F${UUID}#Argo-VLESS`
      }
    : null;
}
