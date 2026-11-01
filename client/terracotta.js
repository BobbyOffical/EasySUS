'use strict';
/**
 * Terracotta（陶瓦联机）集成 —— 下载 + 启动 + 房间管理（HTTP API）
 * 文档: https://burningtnt.github.io/Terracotta/http-api/
 * 三端支持: windows-x86_64 / linux-x86_64 / macos-arm64|x86_64 等
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { getConfig } = require('./config');
const { downloadFile, fetchJSON } = require('./download');
const lanbroadcast = require('./lanbroadcast');

const GH_REPO = 'burningtnt/Terracotta';
// 国内镜像优先（Gitee），失败回落 GitHub
const MIRRORS = [
  { id: 'gitee', name: 'Gitee 国内镜像', base: `https://gitee.com/${GH_REPO}/releases/download` },
  { id: 'github', name: 'GitHub 官方', base: `https://github.com/${GH_REPO}/releases/download` },
  { id: 'cnb', name: 'CNB 镜像', base: `https://cnb.cool/HMCL-Terracotta/Terracotta/-/releases/download` },
];

let PROC = null;
let HTTP_PORT = null;       // Terracotta 本地 HTTP API 端口
let POLL = null;
let STATE = { state: 'not-started', room: null, profiles: [], index: 0, log: [], meta: null };
const MAX_LOG = 200;

function pushLog(l) {
  STATE.log.push({ t: Date.now(), line: l });
  if (STATE.log.length > MAX_LOG) STATE.log.shift();
}

/** 当前平台对应的资产文件名 */
function platformAsset(tag) {
  const v = tag.replace(/^v/, '');
  const plat = process.platform;
  const arch = process.arch; // x64 | arm64
  if (plat === 'win32') return `terracotta-${v}-windows-${arch === 'arm64' ? 'arm64' : 'x86_64'}-pkg.tar.gz`;
  if (plat === 'darwin') return `terracotta-${v}-macos-${arch === 'arm64' ? 'arm64' : 'x86_64'}-pkg.tar.gz`;
  return `terracotta-${v}-linux-${arch === 'arm64' ? 'arm64' : 'x86_64'}-pkg.tar.gz`;
}

async function latestTag() {
  const cfg = getConfig();
  if (cfg.taowa.terracottaVersion) return cfg.taowa.terracottaVersion;
  try {
    const r = await fetchJSON(`https://api.github.com/repos/${GH_REPO}/releases/latest`);
    if (r.tag_name) return r.tag_name;
  } catch (_) {}
  return 'v0.4.2'; // 兜底已知版本
}

function installDir() {
  const cfg = getConfig();
  return path.join(cfg.dataDir || path.dirname(cfg.serverDir), 'terracotta');
}

function findExecutable() {
  const dir = installDir();
  if (!fs.existsSync(dir)) return null;
  const isWin = process.platform === 'win32';
  // 解压出的文件名带版本号，如 terracotta-0.4.2-windows-x86_64.exe
  const re = isWin ? /^terracotta.*\.exe$/i : /^terracotta[^.]*$/;
  function walk(d, depth) {
    if (depth > 2) return null;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return null; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() && re.test(e.name)) return full;
      if (e.isDirectory()) { const r = walk(full, depth + 1); if (r) return r; }
    }
    return null;
  }
  return walk(dir, 0);
}

/**
 * 下载并安装 Terracotta。onProgress(done,total)
 * mirror: gitee | github | cnb | auto（依次尝试）
 */
async function install(mirror, onProgress) {
  const cfg = getConfig();
  const tag = await latestTag();
  const asset = platformAsset(tag);
  const dir = installDir();
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, asset);

  const order = mirror && mirror !== 'auto'
    ? MIRRORS.filter(m => m.id === mirror)
    : (cfg.downloadSource === 'official' || cfg.downloadSource === 'mirror'
        ? [MIRRORS[1], MIRRORS[0], MIRRORS[2]]   // GitHub 优先
        : [MIRRORS[0], MIRRORS[2], MIRRORS[1]]); // 国内镜像优先

  let lastErr = null;
  for (const m of order) {
    const url = `${m.base}/${tag}/${asset}`;
    pushLog(`尝试从 ${m.name} 下载: ${url}`);
    try {
      await downloadFile(url, archive, onProgress);
      pushLog(`下载成功（${m.name}），开始解压...`);
      break;
    } catch (e) { lastErr = e; pushLog(`${m.name} 下载失败: ${e.message}`); }
  }
  if (!fs.existsSync(archive)) throw lastErr || new Error('所有下载源均失败');

  // 解压 tar.gz（Win10+/Linux/macOS 都自带 tar）
  const { run } = require('./java');
  const r = await run('tar', ['-xzf', archive, '-C', dir], 120000);
  if (!r.ok) throw new Error('解压失败: ' + (r.stderr || r.stdout));
  try { fs.unlinkSync(archive); } catch (_) {}

  const exe = findExecutable();
  if (!exe) throw new Error('解压后未找到 terracotta 可执行文件');
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  pushLog(`安装完成: ${exe}`);
  return { exe, tag };
}

// ---------------- HTTP API ----------------
function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    if (!HTTP_PORT) return reject(new Error('Terracotta 未运行'));
    const req = require('http').get(`http://127.0.0.1:${HTTP_PORT}${urlPath}`, { timeout: 6000 }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve({ raw: d, status: res.statusCode }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('api timeout')));
  });
}

async function waitPortFile(portFile, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const j = JSON.parse(fs.readFileSync(portFile, 'utf8'));
      if (j.port) return j.port;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

/** 启动 Terracotta（--hmcl 集成模式，自动获取 HTTP API 端口） */
async function start() {
  if (HTTP_PORT) {
    // 已有实例在运行（Windows 引导进程会移交工作进程后退出，以 HTTP API 为准）
    try { await apiGet('/meta'); return { ok: true, already: true, ...getStatus() }; } catch (_) { HTTP_PORT = null; }
  }
  const exe = findExecutable();
  if (!exe) return { ok: false, error: 'NOT_INSTALLED', message: '陶瓦联机尚未安装，请先在联机页下载安装。' };
  const cfg = getConfig();
  const portFile = path.join(os.tmpdir(), `easysus-terracotta-port-${process.pid}.json`);
  pushLog(`启动 Terracotta: ${exe} --hmcl ${portFile}`);
  const proc = spawn(exe, ['--hmcl', portFile], { windowsHide: true });
  PROC = proc;
  proc.stdout.on('data', d => pushLog('[stdout] ' + d.toString().trim()));
  proc.stderr.on('data', d => pushLog('[stderr] ' + d.toString().trim()));
  proc.on('exit', code => {
    // Windows --hmcl 模式下引导进程 fork 出真正的工作进程后退出（code 0）属正常现象；
    // 只有 HTTP API 也不可达时才视为真的退出。
    if (code !== 0 || !HTTP_PORT) {
      pushLog(`Terracotta 退出 (${code})`);
      PROC = null; HTTP_PORT = null; stopPoll(); STATE.state = 'not-started';
    } else {
      pushLog('引导进程已移交工作进程（正常）');
      PROC = null;
    }
  });
  proc.on('error', e => { pushLog('启动失败: ' + e.message); PROC = null; });

  const port = await waitPortFile(portFile);
  try { fs.unlinkSync(portFile); } catch (_) {}
  if (!port) {
    // 兜底：找 lock 文件
    const lockDir = process.platform === 'darwin' ? path.join(os.homedir(), 'terracotta') : path.join(os.tmpdir(), 'terracotta');
    try {
      const buf = fs.readFileSync(path.join(lockDir, 'terracotta.lock'));
      HTTP_PORT = buf.readUInt16BE(0);
    } catch (_) {
      return { ok: false, error: 'PORT_DISCOVERY_FAILED', message: 'Terracotta 已启动但未能发现 HTTP API 端口，请查看日志。' };
    }
  } else HTTP_PORT = port;

  pushLog(`HTTP API 端口: ${HTTP_PORT}`);
  try { STATE.meta = await apiGet('/meta'); pushLog(`版本 ${STATE.meta.version} (EasyTier ${STATE.meta.easytier_version})`); } catch (_) {}
  startPoll();
  return { ok: true, ...getStatus() };
}

/**
 * 以房主身份开房（扫描本机 MC 端口）。room 可选：用指定房间码重开
 * mcPort: 专用服务端端口 —— 陶瓦靠监听局域网广播发现服务器，
 *         而 server.jar 自身不发广播，所以这里由 EasySUS 代为广播。
 */
async function hostRoom(playerName, room, mcPort) {
  if (!HTTP_PORT) return { ok: false, error: 'NOT_RUNNING' };
  // 先开广播，再请求开房，避免陶瓦扫描器在广播生效前空转
  let bc = null;
  if (mcPort) {
    bc = lanbroadcast.start(mcPort);
    pushLog(`已开启局域网广播（端口 ${mcPort}），让陶瓦能发现专用服务端`);
    await new Promise(r => setTimeout(r, 600));
  }
  const params = new URLSearchParams();
  if (playerName) params.set('player', playerName);
  if (room) params.set('room', room);
  const cfg = getConfig();
  for (const node of (cfg.taowa.publicNodes || [])) params.append('public_nodes', node);
  await apiGet('/state/scanning?' + params.toString());
  pushLog(`已请求开房 player=${playerName || '(匿名)'} room=${room || '(自动)'}`);
  return { ok: true, broadcast: bc };
}

/** 加入房间（guest 模式，供玩家参考；腐竹一般用 hostRoom） */
async function joinRoom(room, playerName) {
  if (!HTTP_PORT) return { ok: false, error: 'NOT_RUNNING' };
  const params = new URLSearchParams();
  params.set('room', room);
  if (playerName) params.set('player', playerName);
  const r = await apiGet('/state/guesting?' + params.toString());
  return { ok: true, r };
}

function startPoll() {
  stopPoll();
  let fails = 0;
  POLL = setInterval(async () => {
    try {
      const s = await apiGet('/state');
      fails = 0;
      STATE.running = true;
      if (s && typeof s.index === 'number' && s.index >= STATE.index) {
        STATE.index = s.index;
        STATE.state = s.state;
        if (s.room) STATE.room = s.room;
        if (s.profiles) STATE.profiles = s.profiles;
        if (s.state === 'exception') pushLog(`⚠️ Terracotta 异常 type=${s.type}`);
        // 房间已就绪，扫描器已退出，广播可以收了（避免在局域网里持续暴露一个虚拟世界）
        if ((s.state === 'host-ok') && lanbroadcast.getStatus().running) {
          lanbroadcast.stop();
          pushLog('房间已就绪，已停止局域网广播');
        }
      }
    } catch (_) {
      if (++fails >= 5) { STATE.running = false; STATE.state = 'not-started'; HTTP_PORT = null; stopPoll(); pushLog('Terracotta 已退出（HTTP API 不可达）'); }
    }
  }, 1500);
  POLL.unref();
}
function stopPoll() { if (POLL) { clearInterval(POLL); POLL = null; } }

async function stop() {
  stopPoll();
  lanbroadcast.stop();
  if (HTTP_PORT) {
    try { await apiGet('/panic?peaceful=true'); } catch (_) {}
  }
  setTimeout(() => { if (PROC) { try { PROC.kill(); } catch (_) {} } }, 3000).unref();
  HTTP_PORT = null; PROC = null;
  STATE.running = false;
  STATE.state = 'not-started'; STATE.room = null; STATE.profiles = [];
  return { ok: true };
}

function getStatus() {
  return {
    installed: !!findExecutable(),
    installDir: installDir(),
    httpPort: HTTP_PORT,
    ...STATE,
    running: !!HTTP_PORT,
    broadcast: lanbroadcast.getStatus(),
    log: STATE.log.slice(-40),
    mirrors: MIRRORS.map(m => ({ id: m.id, name: m.name })),
  };
}

module.exports = { install, start, stop, hostRoom, joinRoom, getStatus, latestTag, platformAsset, findExecutable };
