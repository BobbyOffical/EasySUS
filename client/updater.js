'use strict';
/**
 * 自动更新
 *
 * 流程：
 *   1. check()    比对远端 VERSION 与本地 VERSION
 *   2. download() 下载 GitHub 仓库 zip（直连 → 内置中转 → ghproxy 镜像 依次尝试），
 *                 解压到 data/update-staging/
 *   3. apply()    启动分离的 apply-update.js：等主进程退出 → 换文件 → 重启
 *
 * 只更新代码文件（client/ coordinator/ tools/ *.js *.bat 等），
 * 绝不触碰 data/、admin-token.local、VERSION 以外的用户资产。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { getConfig, builtinCoordinator } = require('./config');
const { readZip } = require('./unzip');
const { downloadFile } = require('./download');

const ROOT = path.join(__dirname, '..');          // 项目根
const VERSION_FILE = path.join(ROOT, 'VERSION');
const REPO = process.env.EASYSUS_REPO || 'BobbyOffical/EasySUS';
const BRANCH = process.env.EASYSUS_BRANCH || 'main';

function localVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch (_) { return '0.0.0'; }
}

function get(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'EasySUS-updater/1.0' }, timeout }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), timeout));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('error', reject);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/** 多通道 GET（文本），依次尝试：直连 → 内置中转 → ghproxy */
async function getMulti(githubUrl) {
  const attempts = [githubUrl];
  const coord = builtinCoordinator();
  if (coord) attempts.push(coord.replace(/\/$/, '') + '/api/relay?url=' + encodeURIComponent(githubUrl));
  attempts.push('https://mirror.ghproxy.com/' + githubUrl);
  attempts.push('https://gh-proxy.com/' + githubUrl);
  let lastErr = null;
  for (const u of attempts) {
    try { return await get(u); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all channels failed');
}

/** 多通道下载二进制（zip），带进度 */
async function downloadMulti(url, dest, onProgress) {
  const attempts = [url];
  const coord = builtinCoordinator();
  if (coord) attempts.push(coord.replace(/\/$/, '') + '/api/relay?url=' + encodeURIComponent(url));
  attempts.push('https://mirror.ghproxy.com/' + url);
  attempts.push('https://gh-proxy.com/' + url);
  let lastErr = null;
  for (const u of attempts) {
    try { await downloadFile(u, dest, onProgress); return u; }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all channels failed');
}

/** 检查更新 → { ok, current, latest, hasUpdate, channel } */
async function check() {
  const current = localVersion();
  let latest = null, channel = '';
  try {
    latest = (await getMulti(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/VERSION`)).trim();
    channel = 'github';
  } catch (_) {
    // 兜底：协调中心上的版本公告（管理员可手动发布）
    const coord = builtinCoordinator();
    if (coord) {
      try {
        const j = JSON.parse(await getMulti(coord.replace(/\/$/, '') + '/api/version'));
        if (j && j.version) { latest = j.version; channel = 'coord'; }
      } catch (_) {}
    }
  }
  if (!latest) return { ok: false, error: '无法获取版本信息（网络受限？）', current };
  return { ok: true, current, latest, hasUpdate: cmp(latest, current) > 0, channel };
}

function cmp(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const STAGING = path.join(ROOT, 'client', 'data', 'update-staging');
const APPLY_LOG = path.join(ROOT, 'client', 'data', 'update-apply.log');

/** 下载并解压新版本到 staging → { ok, version, dir } */
async function download(onProgress) {
  const info = await check();
  if (!info.ok) return { ok: false, error: info.error };
  if (!info.hasUpdate) return { ok: false, error: `已是最新版本 ${info.current}` };
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  const zipPath = path.join(STAGING, 'update.zip');
  const url = `https://codeload.github.com/${REPO}/zip/refs/heads/${BRANCH}`;
  let usedChannel = 'direct';
  try {
    usedChannel = await downloadMulti(url, zipPath, (done, total) => onProgress && onProgress('download', done, total));
  } catch (e) {
    fs.rmSync(STAGING, { recursive: true, force: true });
    return { ok: false, error: '下载失败：' + e.message };
  }
  try {
    readZip(zipPath, STAGING, (name, i, n) => onProgress && onProgress('extract', i, n));
  } catch (e) {
    fs.rmSync(STAGING, { recursive: true, force: true });
    return { ok: false, error: '解压失败：' + e.message };
  }
  fs.unlinkSync(zipPath);
  // GitHub zip 顶层是 <repo>-<branch>/，剥掉一层
  const subs = fs.readdirSync(STAGING).filter(s => s !== 'update.zip');
  if (subs.length === 1 && subs[0].toLowerCase().startsWith(REPO.split('/')[0].toLowerCase())) {
    const inner = path.join(STAGING, subs[0]);
    const tmp = STAGING + '-flat';
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.renameSync(inner, tmp);
    fs.rmSync(STAGING, { recursive: true, force: true });
    fs.renameSync(tmp, STAGING);
  }
  // 校验 staging 里有 VERSION 且与声明一致
  let vStaging = '';
  try { vStaging = fs.readFileSync(path.join(STAGING, 'VERSION'), 'utf8').trim(); } catch (_) {}
  if (!vStaging) { fs.rmSync(STAGING, { recursive: true, force: true }); return { ok: false, error: '更新包缺少 VERSION，已放弃' }; }
  return { ok: true, version: vStaging, dir: STAGING, channel: usedChannel.includes('coord') ? 'relay' : usedChannel.includes('gh') ? 'ghproxy' : 'direct' };
}

/** 受保护路径（更新时绝不覆盖/删除） */
const PROTECTED = [
  'client/data',            // 用户全部数据
  'admin-token.local',
  '.git',
];
function isProtected(rel) {
  const r = rel.split(path.sep).join('/').toLowerCase();
  return PROTECTED.some(p => r === p || r.startsWith(p + '/'));
}

/**
 * 应用更新：spawn 分离进程执行 apply-update.js，然后主进程退出
 */
function apply() {
  if (!fs.existsSync(path.join(STAGING, 'VERSION'))) return { ok: false, error: '没有已下载好的更新，请先点下载' };
  const script = path.join(ROOT, 'tools', 'apply-update.js');
  const port = getConfig().webPort || 19388;
  const child = spawn(process.execPath, [script, ROOT, STAGING, String(port)], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return { ok: true };
}

module.exports = { check, download, apply, localVersion, STAGING, APPLY_LOG, PROTECTED };