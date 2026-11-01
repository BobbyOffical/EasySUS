'use strict';
/**
 * Minecraft 服务端进程管理 —— 启动/停止/控制台/状态解析（Win/Linux/Mac）
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');
const { getConfig } = require('./config');
const { resolveJava, requiredJavaFor } = require('./java');
const { DATA_DIR } = require('./config');

const PIDFILE = path.join(DATA_DIR, 'mc-server.json');

// ---- 孤儿进程治理：EasySUS 被强杀/关窗口时，MC java 会存活并占住端口与文件锁 ----
function readPidfile() {
  try { return JSON.parse(fs.readFileSync(PIDFILE, 'utf8')); } catch (_) { return null; }
}
function writePidfile(info) {
  try { fs.writeFileSync(PIDFILE, JSON.stringify(info)); } catch (_) {}
}
function clearPidfile() { try { fs.unlinkSync(PIDFILE); } catch (_) {} }

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function killTree(pid) {
  // 不解析 taskkill 输出（GBK 乱码风险），以「进程是否真的消失」为准
  let status = 1;
  try {
    if (process.platform === 'win32') {
      try { execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, timeout: 8000, stdio: 'ignore' }); status = 0; }
      catch (e) { status = (e && typeof e.status === 'number') ? e.status : 1; }
    } else {
      try { process.kill(pid, 'SIGKILL'); status = 0; } catch (_) { status = 1; }
    }
  } catch (_) { status = 1; }
  // 轮询确认死亡（最多 3 秒，异步不卡事件循环）
  for (let i = 0; i < 6; i++) {
    if (!isAlive(pid)) return { ok: true };
    await new Promise(r => setTimeout(r, 400));
  }
  return { ok: false, denied: status !== 0 };
}

/** 等待端口释放（最多 ms 毫秒） */
async function waitPortFree(port, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await checkPortFree(port)).free) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/** 找占用 TCP 端口的进程 PID（跨平台，best-effort） */
function pidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { windowsHide: true, timeout: 6000 }).toString();
      const re = new RegExp(`TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
      const m = out.match(re);
      return m ? Number(m[1]) : null;
    }
    const out = execSync(`ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null`, { timeout: 6000, shell: true }).toString();
    const m = out.match(new RegExp(`[:.]${port}\\s.*pid=(\\d+)`));
    return m ? Number(m[1]) : null;
  } catch (_) { return null; }
}

/** 试绑定端口判断是否空闲 */
function checkPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve({ free: false, pid: pidOnPort(port) }));
    srv.once('listening', () => srv.close(() => resolve({ free: true })));
    srv.listen(port, '0.0.0.0');
  });
}

let PROC = null;         // 子进程
let STATE = {
  running: false,
  starting: false,
  serverType: null,
  version: null,
  dir: null,
  javaPath: null,
  startedAt: null,
  port: null,
  console: [],           // 环形日志
  players: { online: 0, max: 0, list: [] },
  motd: '',
  tps: null,
  lastError: null,
};
const MAX_LOG = 500;

function pushLog(line) {
  STATE.console.push({ t: Date.now(), line });
  if (STATE.console.length > MAX_LOG) STATE.console.shift();
  parseLine(line);
}

/** 从服务端输出解析状态信息 */
function parseLine(line) {
  // 启动完成
  if (/Done \(([\d.,]+)s\)! For help, type "help"/.test(line)) {
    STATE.starting = false;
  }
  // 玩家列表 / 人数（Paper、Vanilla 的 list 输出）
  let m = line.match(/There are (\d+)\/(\d+) players online/);
  if (m) {
    STATE.players.online = Number(m[1]);
    STATE.players.max = Number(m[2]);
  }
  m = line.match(/There are (\d+) of a max (\d+) players online: (.*)/);
  if (m) {
    STATE.players.online = Number(m[1]);
    STATE.players.max = Number(m[2]);
    STATE.players.list = m[3].split(',').map(s => s.trim()).filter(Boolean);
  }
  // TPS (Paper)
  m = line.match(/TPS from last ([\dmsh, ]+): ([\d.*\/]+)/);
  if (m) {
    const parts = m[2].split(',').map(s => parseFloat(s));
    if (parts.length) STATE.tps = parts[0];
  }
}

/** 列出已下载的服务端实例 */
function listInstances() {
  const cfg = getConfig();
  const out = [];
  if (!fs.existsSync(cfg.serverDir)) return out;
  for (const d of fs.readdirSync(cfg.serverDir)) {
    const dir = path.join(cfg.serverDir, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    const jars = fs.readdirSync(dir).filter(f => f.endsWith('.jar'));
    const [type, version] = d.split('-');
    out.push({
      id: d, type, version, dir,
      mainJar: jars[0] ? path.join(dir, jars[0]) : null,
      jars,
      eulaAccepted: fs.existsSync(path.join(dir, 'eula.txt')) && /eula\s*=\s*true/i.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8')),
      hasProps: fs.existsSync(path.join(dir, 'server.properties')),
    });
  }
  return out;
}

function readServerProps(dir) {
  const p = path.join(dir, 'server.properties');
  const props = {};
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.startsWith('#')) props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return props;
}

function writeServerProps(dir, patch) {
  const p = path.join(dir, 'server.properties');
  const props = readServerProps(dir);
  Object.assign(props, patch);
  const body = Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(p, body);
}

/**
 * 孤儿进程回收：EasySUS 被强杀/重启后，上次拉起的 MC java 会存活，
 * 占住 server-port 与 logs/latest.log 文件锁，导致新进程"启动几秒后自己退出"。
 * 处理：pidfile 命中 → 终止；端口被占且无 pidfile → 返回明确错误让用户确认。
 */
async function reclaimOrphan(instDir, port, force) {
  const rec = readPidfile();
  const orphanPid = (rec && rec.pid && isAlive(rec.pid)) ? rec.pid : null;
  if (rec && rec.pid && !isAlive(rec.pid)) clearPidfile();

  // 情况 A：pidfile 指向的进程还活着，但我们并没有在管理它（STATE.running=false）→ 孤儿
  if (orphanPid && !PROC) {
    if (force) {
      pushLog(`[EasySUS] 终止上次遗留的 MC 进程 PID ${orphanPid}（实例 ${rec.instanceId || rec.dir}）...`);
      const k = await killTree(orphanPid);
      if (!k.ok) {
        clearPidfile();   // 记录已失效，别反复撞
        return { ok: false, error: 'KILL_DENIED', pid: orphanPid,
          message: k.denied
            ? `遗留进程 PID ${orphanPid} 权限更高（可能由管理员实例启动），无法终止。请【以管理员身份重新打开 EasySUS】再点「清理并接管」，或手动结束该 java 进程。`
            : `终止遗留进程 PID ${orphanPid} 失败，请手动在任务管理器中结束它。` };
      }
      if (!(await waitPortFree(port))) {
        return { ok: false, error: 'PORT_STILL_BUSY', port,
          message: `已终止 PID ${orphanPid}，但端口 ${port} 仍未释放（可能还有其它程序占用）。请稍等几秒重试，或改用其他端口。` };
      }
      clearPidfile();
      pushLog('[EasySUS] 遗留进程已清理，端口已释放');
      return { ok: true };
    }
    return { ok: false, error: 'ORPHAN_MC', pid: orphanPid, dir: rec.dir, instanceId: rec.instanceId,
      message: `检测到上次启动的服务器（PID ${orphanPid}，实例 ${rec.instanceId || ''}）仍在运行——通常是 EasySUS 被强杀/关窗口留下的。它占着端口 ${port}，新服务器会启动失败。请点「🧹 清理并接管」终止它后重试。` };
  }

  // 情况 B：没有已知孤儿，但端口被占（旧版遗留 / 手动启动的服务器 / 其它程序）
  const free = await checkPortFree(port);
  if (!free.free) {
    const pid = free.pid;
    if (force && pid) {
      pushLog(`[EasySUS] 端口 ${port} 被 PID ${pid} 占用，强制终止...`);
      const k = await killTree(pid);
      if (!k.ok) {
        return { ok: false, error: 'KILL_DENIED', pid,
          message: k.denied
            ? `占用端口的进程 PID ${pid} 权限更高，无法终止。请【以管理员身份重新打开 EasySUS】再试，或手动结束它。`
            : `终止 PID ${pid} 失败，请手动在任务管理器中结束它。` };
      }
      if (!(await waitPortFree(port))) {
        return { ok: false, error: 'PORT_STILL_BUSY', port, pid,
          message: `已终止 PID ${pid}，但端口 ${port} 仍未释放。请等几秒重试，或改用其他端口。` };
      }
      pushLog('[EasySUS] 端口已释放');
      return { ok: true };
    }
    return { ok: false, error: 'PORT_BUSY', pid, port,
      message: `端口 ${port} 已被进程 ${pid || '未知'} 占用${pid ? '。若那是遗留的 MC 服务器，点「🧹 清理并接管」终止它。' : '。请改用其他端口或手动处理。'}` };
  }
  return { ok: true };
}

/**
 * 启动服务端
 * opts: { instanceId, memoryMb, javaPath?, extraArgs?, forceKillOrphan? }
 */
async function start(opts) {
  if (STATE.running) return { ok: false, error: 'ALREADY_RUNNING' };
  const cfg = getConfig();
  const instances = listInstances();
  const inst = instances.find(i => i.id === opts.instanceId);
  if (!inst) return { ok: false, error: `未找到实例 ${opts.instanceId}，请先下载服务端` };
  if (!inst.mainJar) return { ok: false, error: '实例目录中没有 jar 文件' };

  // ── 启动前：清理上次 EasySUS 被强杀留下的孤儿 MC 进程 ──
  const cleanup = await reclaimOrphan(inst.dir, cfg.directPort || 25565, opts.forceKillOrphan === true);
  if (!cleanup.ok) return cleanup;

  // EULA
  if (!inst.eulaAccepted) {
    fs.writeFileSync(path.join(inst.dir, 'eula.txt'),
      '#By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA (https://aka.ms/MinecraftEULA).\neula=true\n');
  }

  // server.properties: 端口
  const port = cfg.directPort || 25565;
  if (!inst.hasProps) {
    // 先让服务端生成，再改
    fs.writeFileSync(path.join(inst.dir, 'server.properties'), `server-port=${port}\n`);
  } else {
    writeServerProps(inst.dir, { 'server-port': String(port) });
  }

  // Java
  const need = requiredJavaFor(inst.version);
  const java = opts.javaPath || (await resolveJava(need));
  if (!java) {
    return { ok: false, error: 'NO_JAVA', message: `未检测到 Java。该服务端（MC ${inst.version}）需要 Java ${need}+。请在网页端「环境」页一键安装，或自行安装 Java。` };
  }

  const memoryMb = Number(opts.memoryMb) || 2048;
  const args = [
    `-Xms${Math.min(1024, memoryMb)}M`,
    `-Xmx${memoryMb}M`,
    '-XX:+UseG1GC',
    ...(opts.extraArgs ? String(opts.extraArgs).split(/\s+/).filter(Boolean) : []),
    '-jar', path.basename(inst.mainJar),
    'nogui',
  ];

  pushLog(`[EasySUS] 启动 ${inst.id} | Java ${java.version || '?'} (${java.path}) | ${memoryMb}MB`);
  const proc = spawn(java.path, args, { cwd: inst.dir, windowsHide: true });
  PROC = proc;
  writePidfile({ pid: proc.pid, dir: inst.dir, instanceId: inst.id, port, startedAt: Date.now() });
  Object.assign(STATE, {
    running: true, starting: true, serverType: inst.type, version: inst.version,
    dir: inst.dir, javaPath: java.path, startedAt: Date.now(), lastError: null, port,
    players: { online: 0, max: 0, list: [] },
  });

  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', d => d.split(/\r?\n/).filter(Boolean).forEach(pushLog));
  proc.stderr.on('data', d => d.split(/\r?\n/).filter(Boolean).forEach(l => pushLog('[stderr] ' + l)));
  const launchedAt = Date.now();
  proc.on('exit', code => {
    pushLog(`[EasySUS] 服务端已退出 (code ${code})`);
    STATE.running = false; STATE.starting = false; PROC = null;
    clearPidfile();
    // 启动失败快速退出（<20s）时给出可操作提示
    if (Date.now() - launchedAt < 20000) {
      pushLog('[EasySUS] ⚠ 服务器启动后立即退出。常见原因：端口被占用（改「联机设置」端口）、世界文件损坏、内存不足。');
    }
  });
  proc.on('error', e => {
    pushLog(`[EasySUS] 启动失败: ${e.message}`);
    STATE.running = false; STATE.lastError = e.message; PROC = null;
  });

  return { ok: true, instance: inst.id, java: java.path, port };
}

function sendCommand(cmd) {
  if (!PROC || !PROC.stdin.writable) return { ok: false, error: '服务端未运行' };
  PROC.stdin.write(cmd + '\n');
  pushLog(`> ${cmd}`);
  return { ok: true };
}

async function stop() {
  if (!PROC) return { ok: false, error: '服务端未运行' };
  pushLog('[EasySUS] 正在安全关闭服务端...');
  try { PROC.stdin.write('stop\n'); } catch (_) {}
  // 30 秒后仍未退出则强杀
  setTimeout(() => {
    if (PROC) { try { PROC.kill(); } catch (_) {} }
  }, 30000).unref();
  return { ok: true };
}

function kill() {
  if (!PROC) return { ok: false, error: '服务端未运行' };
  try { PROC.kill(); } catch (_) {}
  return { ok: true };
}

function getStatus() {
  const cfg = getConfig();
  return {
    ...STATE,
    pid: PROC ? PROC.pid : null,
    uptimeMs: STATE.running && STATE.startedAt ? Date.now() - STATE.startedAt : 0,
    console: STATE.console.slice(-80),
    netMode: cfg.netMode,
    port: STATE.port || cfg.directPort,
  };
}

/** 定期向服务端发 list，刷新人数（仅在运行时） */
setInterval(() => {
  if (PROC && PROC.stdin.writable && !STATE.starting) {
    try { PROC.stdin.write('list\n'); } catch (_) {}
  }
}, 15000).unref();

module.exports = { start, stop, kill, sendCommand, getStatus, listInstances, readServerProps, writeServerProps };
