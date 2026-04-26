/**
 * index.js (Linux amd64 专用轻量版)
 * - 官方 sing-box + cloudflared 下载
 * - VLESS + WS + Argo Tunnel
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn, execSync } = require('child_process');

const FILE_PATH = path.resolve(__dirname, 'tmp');
if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

// 配置
const UUID = process.env.UUID || '792c9cd6-9ece-4ebc-ff02-86eaf8bf7e73';
const ARGO_PORT = 3000;
const ARGO_LOG = path.join(FILE_PATH, 'argo.log');
const SINGBOX_CONF = path.join(FILE_PATH, 'config.json');

// 官方下载链接（Linux amd64）
const SINGBOX_URL = 'https://github.com/SagerNet/sing-box/releases/download/v1.12.9/sing-box-1.12.9-linux-amd64.tar.gz';
const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

// 下载文件
async function downloadTo(url, outPath) {
    if (fs.existsSync(outPath)) return console.log('已存在:', outPath);
    console.log('下载:', url);
    const writer = fs.createWriteStream(outPath);
    const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
    res.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    fs.chmodSync(outPath, 0o755);
    console.log('保存到', outPath);
}

// 解压 sing-box tar.gz 并移动到 tmp/sing-box
function extractSingBox(tarPath, dest) {
    execSync(`tar -xzf "${tarPath}" -C "${dest}"`);
    console.log('解压完成', tarPath);

    // 移动 sing-box 到 tmp/sing-box
    const extractedDir = fs.readdirSync(dest).find(d => d.startsWith('sing-box'));
    const oldBin = path.join(dest, extractedDir, 'sing-box');
    const newBin = path.join(dest, 'sing-box');
    fs.renameSync(oldBin, newBin);
    fs.chmodSync(newBin, 0o755);
    console.log('sing-box 移动到', newBin);
    return newBin;
}

// 写 sing-box 配置
function writeSingBoxConfig() {
    const cfg = {
        log: { level: 'error' },
        inbounds: [{
            type: 'vless',
            listen: '::',
            listen_port: ARGO_PORT,
            users: [{ uuid: UUID }],
            transport: { type: 'ws', path: `/${UUID}`, max_early_data: 2048 }
        }],
        outbounds: [{ type: 'direct' }]
    };
    fs.writeFileSync(SINGBOX_CONF, JSON.stringify(cfg, null, 2));
    console.log('已生成配置:', SINGBOX_CONF);
}

// 启动 sing-box
function startSingBox(binPath) {
    console.log('启动 sing-box...');
    const cp = spawn(binPath, ['run', '-c', SINGBOX_CONF], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    cp.unref();
}

// 启动 cloudflared
function startCloudflared(binPath) {
    console.log('启动 cloudflared...');
    const out = fs.openSync(ARGO_LOG, 'a');
    const cp = spawn(binPath, ['tunnel', '--url', `http://localhost:${ARGO_PORT}`, '--loglevel', 'info'], { detached: true, stdio: ['ignore', out, out] });
    cp.unref();
}

// 轮询 argo.log 获取 trycloudflare 域名
function pollArgoDomain(retries = 20, intervalMs = 2000) {
    return new Promise((resolve) => {
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            if (fs.existsSync(ARGO_LOG)) {
                const txt = fs.readFileSync(ARGO_LOG, 'utf8');
                const m = txt.match(/https?:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
                if (m) { clearInterval(timer); return resolve(m[1]); }
            }
            if (attempts >= retries) { clearInterval(timer); return resolve(null); }
        }, intervalMs);
    });
}
// 解压 sing-box tar.gz 并返回二进制路径
function extractSingBox(tarPath, dest) {
    execSync(`tar -xzf "${tarPath}" -C "${dest}"`);
    console.log('解压完成', tarPath);

    // 提取目录名
    const extractedDir = fs.readdirSync(dest).find(d => d.startsWith('sing-box'));
    const binPath = path.join(dest, extractedDir, 'sing-box');

    if (!fs.existsSync(binPath)) throw new Error('解压后未找到 sing-box 二进制');

    const finalBin = path.join(dest, 'sing-box'); // 最终路径
    fs.copyFileSync(binPath, finalBin); // 拷贝到 tmp/sing-box
    fs.chmodSync(finalBin, 0o755);
    console.log('sing-box 放置在', finalBin);

    return finalBin;
}

// 主流程
(async () => {
    try {
        const singboxTar = path.join(FILE_PATH, 'sing-box.tar.gz');
        const cfBin = path.join(FILE_PATH, 'cloudflared');

        await downloadTo(CLOUDFLARED_URL, cfBin);
        await downloadTo(SINGBOX_URL, singboxTar);

        const singboxBin = extractSingBox(singboxTar, FILE_PATH);

        writeSingBoxConfig();
        startSingBox(singboxBin);
        startCloudflared(cfBin);

        console.log('🚀 等待 Argo 输出域名...');
        const domain = await pollArgoDomain(20, 2000);
        if (domain) {
            const link = `vless://${UUID}@${domain}:443?encryption=none&security=tls&type=ws&host=${domain}&path=%2F${UUID}#Argo-VLESS`;
            console.log('✅ 找到域名:', domain);
            console.log('✅ VLESS 链接:\n', link);
        } else {
            console.log('⚠️ 未找到 trycloudflare 域名，请检查', ARGO_LOG);
        }

    } catch (err) {
        console.error('错误:', err);
    }
})();
