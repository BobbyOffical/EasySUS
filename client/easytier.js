'use strict';
/**
 * EasyTier 集成 —— 组网远程访问 MC 服务器（最多 8 人，由协调中心限额）
 * EasyTier 是开源虚拟局域网工具（Terracotta 也基于它开发）。
 * 腐竹运行 easytier-core 创建私有网络，把 MC 端口暴露给组网成员；
 * 最多 8 个成员（不含腐竹）可远程访问服务器地址。
 *
 * 下载: https://github.com/EasyTier/EasyTier/releases
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getConfig, saveConfig } = require('./config');
const { downloadFile, fetchJSON } = require('./download');
const { run } = require('./java');

const GH_REPO = 'EasyTier/EasyTier';
let PROC = null;
let STATE = { running: false, log: [], netName: null, netSecret: null, virtualIp: null };
const MAX_LOG = 200;
function pushLog(l) {
  STATE.log.push({ t: Date.now(), line: l });
  if (STATE.log.length > MAX_LOG) STATE.log.shift();
}

// ---------------- 平台资产 ----------------
function platformAsset(tag) {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === 'win32') return `easytier-windows-${arch === 'arm64' ? 'arm64' : 'x86_64'}-${tag}.zip`;
  if (plat === 'darwin') return `easytier-macos-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${tag}.zip`;
  return `easytier-linux-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${tag}.zip`;
}

async function latestTag() {
  const cfg = getConfig();
  if (cfg.easytier && cfg.easytier.version) return cfg.easytier.version;
  try {
    const r = await fetchJSON(`https://api.github.com/repos/${GH_REPO}/releases/latest`);
    if (r.tag_name) return r.tag_name;
  } catch (_) {}
  return 'v2.6.4'; // 兜底已知版本
}

function installDir() {
  const cfg = getConfig();
  return path.join(cfg.dataDir || path.dirname(cfg.serverDir), 'easytier');
}

function findExecutable() {
  const dir = installDir();
  if (!fs.existsSync(dir)) return null;
  const exeName = process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core';
  function walk(d, depth) {
    if (depth > 3) return null;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return null; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() && e.name === exeName) return full;
      if (e.isDirectory()) { const r = walk(full, depth + 1); if (r) return r; }
    }
    return null;
  }
  return walk(dir, 0);
}

/**
 * 下载并安装 EasyTier。onProgress(done,total)
 * mirror: github | gitee | auto
 */
async function install(mirror, onProgress) {
  const cfg = getConfig();
  const tag = await latestTag();
  const asset = platformAsset(tag);
  const dir = installDir();
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, asset);

  const mirrors = [
    { id: 'github', base: `https://github.com/${GH_REPO}/releases/download/${tag}/${asset}` },
    { id: 'gitee', base: `https://gitee.com/EasyTier/EasyTier/releases/download/${tag}/${asset}` },
  ];
  const order = (mirror && mirror !== 'auto') ? mirrors.filter(m => m.id === mirror)
    : (cfg.downloadSource === 'official' ? mirrors : [mirrors[1], mirrors[0]]);

  let lastErr = null;
  for (const m of order) {
    pushLog(`尝试从 ${m.id} 下载: ${m.base}`);
    try { await downloadFile(m.base, archive, onProgress); pushLog('下载成功，解压中...'); break; }
    catch (e) { lastErr = e; pushLog(`${m.id} 失败: ${e.message}`); }
  }
  if (!fs.existsSync(archive)) throw lastErr || new Error('所有下载源均失败');

  // zip 解压（Win10+/Linux/macOS 的 tar 都能解 zip；不行则用 unzip）
  let r = await run('tar', ['-xf', archive, '-C', dir], 120000);
  if (!r.ok) r = await run('unzip', ['-o', archive, '-d', dir], 120000);
  if (!r.ok) throw new Error('解压失败: ' + (r.stderr || r.stdout));
  try { fs.unlinkSync(archive); } catch (_) {}

  const exe = findExecutable();
  if (!exe) throw new Error('解压后未找到 easytier-core 可执行文件');
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  pushLog(`安装完成: ${exe}`);
  return { exe, tag };
}

// ---------------- 网络配置 ----------------
function ensureNetwork() {
  const cfg = getConfig();
  let et = cfg.easytier || {};
  if (!et.netName) {
    et = Object.assign({}, et, {
      netName: 'easysus-' + crypto.randomBytes(4).toString('hex'),
      netSecret: crypto.randomBytes(16).toString('hex'),
      virtualIp: et.virtualIp || '10.144.144.1',
      port: et.port || 25565,
    });
    saveConfig({ easytier: et });
  }
  return et;
}

/**
 * 启动 easytier-core，创建私有网络。
 * 玩家在自己的电脑上用相同 netName/netSecret 加入，即可访问 virtualIp:port。
 * 最多 8 个远程访问者 —— 客户端启动前必须先向协调中心申请 easytier 额度。
 * Windows 下创建虚拟网卡需要管理员权限；失败时自动回退 --use-smoltcp（用户态协议栈，免管理员）。
 */
async function start(opts = {}) {
  if (PROC) return { ok: true, already: true, ...getStatus() };
  const exe = opts.exe || findExecutable();
  if (!exe) return { ok: false, error: 'NOT_INSTALLED', message: 'EasyTier 尚未安装，请先下载安装。' };
  const cfg = getConfig();
  const et = ensureNetwork();
  const mcPort = opts.mcPort || cfg.directPort || 25565;

  STATE.lastError = null;
  // 第一次尝试常规模式，失败则回退 smoltcp
  let r = await spawnOnce(exe, et, mcPort, false);
  if (!r.ok && r.error === 'NEED_ADMIN' && process.platform === 'win32') {
    pushLog('回退到 --use-smoltcp 用户态模式（免管理员权限）...');
    r = await spawnOnce(exe, et, mcPort, true);
    if (r.ok) pushLog('✅ smoltcp 模式启动成功（无需管理员权限）');
  }
  return r;
}

function spawnOnce(exe, et, mcPort, smoltcp) {
  return new Promise(resolve => {
    const args = [
      '--network-name', et.netName,
      '--network-secret', et.netSecret,
      '-i', et.virtualIp,
      '--multi-thread',
      '--accept-dns', 'false',
    ];
    if (smoltcp) args.push('--use-smoltcp');

    pushLog(`启动 EasyTier${smoltcp ? ' (smoltcp)' : ''}: ${exe} ${args.join(' ')}`.replace(et.netSecret, '***'));
    const proc = spawn(exe, args, { windowsHide: true });
    PROC = proc;
    Object.assign(STATE, { running: true, netName: et.netName, netSecret: et.netSecret, virtualIp: et.virtualIp, mcPort, smoltcp });
    let needAdmin = false;
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).filter(Boolean).forEach(l => pushLog(l)));
    proc.stderr.on('data', d => d.toString().split(/\r?\n/).filter(Boolean).forEach(l => {
      pushLog('[stderr] ' + l);
      if (/Failed to create adapter|tun error/i.test(l)) needAdmin = true;
    }));
    proc.on('exit', code => {
      pushLog(`EasyTier 退出 (${code})`);
      PROC = null; STATE.running = false;
      if (code !== 0) {
        STATE.lastError = needAdmin ? 'NEED_ADMIN' : 'EXITED';
      }
    });
    proc.on('error', e => { pushLog('启动失败: ' + e.message); PROC = null; STATE.running = false; STATE.lastError = 'SPAWN_ERROR'; });

    // 3 秒内未退出即视为成功（EasyTier 常驻运行）
    setTimeout(() => {
      if (PROC && STATE.running) {
        resolve({ ok: true, ...getStatus() });
      } else {
        const err = STATE.lastError || 'EXITED';
        resolve({
          ok: false, error: err,
          message: err === 'NEED_ADMIN'
            ? 'EasyTier 创建虚拟网卡需要管理员权限，且用户态回退也失败。请以管理员身份运行 EasySUS。'
            : 'EasyTier 启动后立即退出，请查看日志。',
          ...getStatus(),
        });
      }
    }, 3000);
  });
}

function stop() {
  if (PROC) { try { PROC.kill(); } catch (_) {} PROC = null; }
  STATE.running = false;
  pushLog('EasyTier 已停止');
  return { ok: true };
}

/** 远程设备加入信息（用于在其它设备上远程打开 EasySUS 控制面板） */
function joinInfo() {
  const et = ensureNetwork();
  const cfg = getConfig();
  const panelPort = cfg.webPort || 19388;
  return {
    netName: et.netName,
    netSecret: et.netSecret,
    virtualIp: et.virtualIp,
    panelUrl: `http://${et.virtualIp}:${panelPort}`,
    guide: `在你的其它设备（手机/笔记本）上下载 EasyTier（easytier-core），运行:\n` +
      `  easytier-core --network-name ${et.netName} --network-secret ${et.netSecret} -i 10.144.144.x\n` +
      `（x 为 2~254 中未被占用的数字，每台设备不同）\n` +
      `然后浏览器打开控制面板: http://${et.virtualIp}:${panelPort}\n` +
      `⚠️ 远程访问设备最多 8 台，由 EasySUS 协调中心统一限额。`,
  };
}

function getStatus() {
  return {
    installed: !!findExecutable(),
    installDir: installDir(),
    ...STATE,
    log: STATE.log.slice(-40),
    joinInfo: joinInfo(),
  };
}

module.exports = { install, start, stop, getStatus, joinInfo, latestTag, platformAsset, findExecutable, ensureNetwork };
