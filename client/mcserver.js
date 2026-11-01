'use strict';
/**
 * Minecraft 服务端进程管理 —— 启动/停止/控制台/状态解析（Win/Linux/Mac）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getConfig } = require('./config');
const { resolveJava, requiredJavaFor } = require('./java');

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
 * 启动服务端
 * opts: { instanceId, memoryMb, javaPath?, extraArgs? }
 */
async function start(opts) {
  if (STATE.running) return { ok: false, error: 'ALREADY_RUNNING' };
  const cfg = getConfig();
  const instances = listInstances();
  const inst = instances.find(i => i.id === opts.instanceId);
  if (!inst) return { ok: false, error: `未找到实例 ${opts.instanceId}，请先下载服务端` };
  if (!inst.mainJar) return { ok: false, error: '实例目录中没有 jar 文件' };

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
  Object.assign(STATE, {
    running: true, starting: true, serverType: inst.type, version: inst.version,
    dir: inst.dir, javaPath: java.path, startedAt: Date.now(), lastError: null, port,
    players: { online: 0, max: 0, list: [] },
  });

  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', d => d.split(/\r?\n/).filter(Boolean).forEach(pushLog));
  proc.stderr.on('data', d => d.split(/\r?\n/).filter(Boolean).forEach(l => pushLog('[stderr] ' + l)));
  proc.on('exit', code => {
    pushLog(`[EasySUS] 服务端已退出 (code ${code})`);
    STATE.running = false; STATE.starting = false; PROC = null;
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
