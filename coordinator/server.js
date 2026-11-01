#!/usr/bin/env node
/**
 * EasySUS Coordinator v2 —— 联机配额协调中心
 * 部署在公网服务器上（默认只监听本机，经反向代理对外），零依赖，Node.js >= 16。
 *
 * 规则：
 *  - 陶瓦联机(Terracotta)：同时使用的普通用户 ≤ 6（taowaUserLimit）。
 *  - EasyTier 远程访问：同时使用 ≤ 8（easytierUserLimit）。
 *  - 客户端开启联机前发送「请求人数 + 1」申请会话，超额被拒（429）。
 *  - 贡献者（认领捐赠令牌）豁免所有限制、不占额度。
 *  - 会话靠心跳维持，超时自动释放。
 *  - 令牌池自动生成：始终保持 autoTokenPool.size 个未认领令牌，
 *    管理员用 admin-cli.js 取出发给提交 issue 的用户。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = __dirname;

// ---------------- 配置 ----------------
function loadConfig() {
  const defaults = {
    port: Number(process.env.EASYSUS_COORD_PORT) || 19400,
    host: process.env.EASYSUS_COORD_HOST || '127.0.0.1',
    adminToken: process.env.EASYSUS_COORD_ADMIN_TOKEN || '',
    adminTokenFile: path.join(ROOT, 'admin-token'),
    taowaUserLimit: Number(process.env.EASYSUS_COORD_TAOWA_LIMIT) || 6,
    easytierUserLimit: Number(process.env.EASYSUS_COORD_ET_LIMIT) || 8,
    heartbeatTimeoutMs: 90 * 1000,
    dataFile: process.env.EASYSUS_COORD_DATA || path.join(ROOT, 'data.json'),
    autoTokenPool: { enabled: true, size: Number(process.env.EASYSUS_COORD_POOL) || 5 },
    // 受限下载中转：客户端直连不到某些域名（如被针对性阻断的 purpurmc.org）时改用本服务中转
    relay: {
      enabled: process.env.EASYSUS_COORD_RELAY !== '0',
      hosts: [
        'api.purpurmc.org', 'download.purpurmc.org',
        'api.papermc.io', 'fill.papermc.io', 'fill-data.papermc.io',
        'meta.fabricmc.net', 'maven.fabricmc.net',
        'maven.minecraftforge.net', 'files.minecraftforge.net',
        'piston-meta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com',
        'bmclapi2.bangbang93.com', 'bmclapi1.sakura.sld.tw',
        'cdn.modrinth.com', 'api.modrinth.com', 'github.com', 'objects.githubusercontent.com',
        'codeload.github.com', 'raw.githubusercontent.com', 'api.github.com',
        'mirror.ghproxy.com', 'gh-proxy.com',
      ],
      maxBytes: 400 * 1024 * 1024,   // 单文件上限 400MB
      perHour: Number(process.env.EASYSUS_COORD_RELAY_RATE) || 40,  // 每 IP 每小时请求数
    },
    // 公网入口网关：让玩家直接连 publicHost:publicPort 进服，无需房间号/装软件
    gateway: {
      enabled: process.env.EASYSUS_COORD_GATEWAY !== '0',
      binary: process.env.EASYSUS_COORD_ET_BIN || '/usr/local/bin/easytier-core',
      publicHost: process.env.EASYSUS_COORD_PUBLIC_HOST || '',   // 公网地址，部署时写在 config.json 或环境变量
      portRange: (process.env.EASYSUS_COORD_GW_PORTS || '30000-30200').split('-').map(Number),
      heartbeatTimeoutMs: 120 * 1000,
    },
  };
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (_) {}
  const cfg = Object.assign({}, defaults, fileCfg);
  cfg.autoTokenPool = Object.assign({}, defaults.autoTokenPool, fileCfg.autoTokenPool || {});
  cfg.relay = Object.assign({}, defaults.relay, fileCfg.relay || {});
  cfg.gateway = Object.assign({}, defaults.gateway, fileCfg.gateway || {});

  // admin token：环境变量 > 令牌文件 > 随机生成并写入文件
  if (!cfg.adminToken) {
    try { cfg.adminToken = fs.readFileSync(cfg.adminTokenFile, 'utf8').trim(); } catch (_) {}
  }
  if (!cfg.adminToken) {
    cfg.adminToken = crypto.randomBytes(24).toString('hex');
    try {
      fs.writeFileSync(cfg.adminTokenFile, cfg.adminToken + '\n', { mode: 0o600 });
      console.log('[coordinator] 已生成管理员令牌并写入', cfg.adminTokenFile);
    } catch (e) {
      console.log('[coordinator] 管理员令牌（无法写文件，请抄录）:', cfg.adminToken);
    }
  }
  return cfg;
}

const CFG = loadConfig();

// ---------------- 公网入口网关（Gateway）----------------
/**
 * 目标：玩家不需要房间号、不需要装任何软件，直接连
 *     <publicIp>:<publicPort>（或域名）即可进入腐竹的 MC 服务器。
 *
 * 原理：本机（coordinator 所在服务器）运行一个常驻 EasyTier 节点，
 *   对每个开启公网入口的腐竹：
 *   1. 用其 netName/netSecret 启动一个临时 easytier-core 子进程（加入其私有网）；
 *   2. 通过 --port-forward 把公网端口的流量转发到腐竹的虚拟 IP:MC端口；
 *   3. 分配一个公网端口并记录映射；心跳超时自动回收。
 *
 * 前提：
 *   - 服务器装有 easytier-core（路径见 CFG.gateway.binary）；
 *   - 腾讯云安全组放行对应 TCP/UDP 端口段。
 */
const GW = {
  entries: {},   // gwId -> { userId, nickname, netName, netSecret, mcVirtualIp, mcPort, publicPort, proc, startedAt, lastHeartbeat, log: [], status }
  nextPort: 0,
};

function gwNextPort() {
  const range = CFG.gateway.portRange || [30000, 30200];
  const used = new Set(Object.values(GW.entries).map(e => e.publicPort));
  for (let i = 0; i < (range[1] - range[0] + 1); i++) {
    GW.nextPort = (GW.nextPort + 1) % (range[1] - range[0] + 1);
    const p = range[0] + GW.nextPort;
    if (!used.has(p)) return p;
  }
  return null;
}

function gwStart(opts) {
  if (!CFG.gateway.enabled) throw new Error('网关未启用');
  const bin = CFG.gateway.binary;
  if (!bin || !fs.existsSync(bin)) throw new Error('服务器未安装 easytier-core（' + bin + '）');

  const gwId = 'gw_' + crypto.randomBytes(8).toString('hex');
  const publicPort = gwNextPort();
  if (!publicPort) throw new Error('公网端口已分配完');
  // 加入用户私有网需要一个本网内不冲突的虚拟 IP
  const nodeIp = '10.144.200.' + (50 + Object.keys(GW.entries).length % 150);
  // 每个实例的监听端口必须唯一（默认 11010 会冲突导致启动失败）
  const lBase = 11100 + (publicPort - (CFG.gateway.portRange[0] || 30000)) * 2;

  const args = [
    '--network-name', opts.netName,
    '--network-secret', opts.netSecret,
    '-i', nodeIp,
    '--accept-dns', 'false',
    '--multi-thread',
    '--listeners', `tcp://0.0.0.0:${lBase}`, `udp://0.0.0.0:${lBase}`,
    '--port-forward', `tcp://0.0.0.0:${publicPort}/${opts.mcVirtualIp}:${opts.mcPort}`,
    '--port-forward', `udp://0.0.0.0:${publicPort}/${opts.mcVirtualIp}:${opts.mcPort}`,
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = {
    gwId, userId: opts.userId, nickname: opts.nickname || '',
    netName: opts.netName, mcVirtualIp: opts.mcVirtualIp, mcPort: opts.mcPort,
    publicPort, nodeIp, proc, startedAt: now(), lastHeartbeat: now(),
    status: 'starting', log: [],
  };
  const pushLog = l => { entry.log.push(l); if (entry.log.length > 60) entry.log.shift(); };
  proc.stdout.on('data', d => d.toString().split(/\r?\n/).filter(Boolean).forEach(pushLog));
  proc.stderr.on('data', d => d.toString().split(/\r?\n/).filter(Boolean).forEach(l => pushLog('[stderr] ' + l)));
  proc.on('exit', code => { pushLog(`[gateway] 退出 (${code})`); entry.status = 'exited'; entry.proc = null; });
  proc.on('error', e => { pushLog('[gateway] 启动失败: ' + e.message); entry.status = 'error'; entry.proc = null; });

  GW.entries[gwId] = entry;
  // 3 秒后若仍存活视为就绪
  setTimeout(() => { if (entry.status === 'starting' && entry.proc) entry.status = 'ready'; }, 3000);
  console.log(`[gateway] ${gwId} user=${opts.userId} public=:${publicPort} -> ${opts.mcVirtualIp}:${opts.mcPort}`);
  return entry;
}

function gwStop(gwId) {
  const e = GW.entries[gwId];
  if (!e) return false;
  if (e.proc) { try { e.proc.kill(); } catch (_) {} }
  delete GW.entries[gwId];
  console.log(`[gateway] ${gwId} 已停止回收`);
  return true;
}

function gwSweep() {
  for (const [id, e] of Object.entries(GW.entries)) {
    if (now() - e.lastHeartbeat > CFG.gateway.heartbeatTimeoutMs) {
      console.log(`[gateway] ${id} 心跳超时，回收公网端口 :${e.publicPort}`);
      gwStop(id);
    }
  }
}
setInterval(gwSweep, 15 * 1000).unref();

function gwInfo(e) {
  return {
    gwId: e.gwId, userId: e.userId, status: e.status,
    publicPort: e.publicPort,
    publicAddress: `${CFG.gateway.publicHost}:${e.publicPort}`,
    mcTarget: `${e.mcVirtualIp}:${e.mcPort}`,
    startedAt: e.startedAt, logTail: e.log.slice(-15),
  };
}

// ---------------- 持久化 ----------------
let DB = { sessions: {}, users: {}, contributions: [] };
function loadDB() {
  try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(CFG.dataFile, 'utf8'))); } catch (_) {}
}
let saveTimer = null;
function saveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(CFG.dataFile, JSON.stringify(DB, null, 2)); } catch (e) { console.error('save failed', e.message); }
  }, 200);
}
loadDB();

// ---------------- 逻辑 ----------------
const now = () => Date.now();
const MODES = { taowa: () => CFG.taowaUserLimit, easytier: () => CFG.easytierUserLimit };

function sweep() {
  let changed = false;
  for (const [id, s] of Object.entries(DB.sessions)) {
    if (now() - s.lastHeartbeat > CFG.heartbeatTimeoutMs) {
      delete DB.sessions[id];
      changed = true;
      console.log(`[coordinator] 会话超时释放: ${id} mode=${s.mode} user=${s.userId}`);
    }
  }
  if (changed) saveDB();
}
setInterval(sweep, 15 * 1000).unref();

function isContributor(userId) {
  const u = DB.users[userId];
  return !!(u && u.contributed);
}

function modeSnapshot(mode) {
  const limit = MODES[mode] ? MODES[mode]() : 6;
  const active = Object.values(DB.sessions).filter(s => (s.mode || 'taowa') === mode && !s.contributed);
  const contrib = Object.values(DB.sessions).filter(s => (s.mode || 'taowa') === mode && s.contributed);
  return {
    limit,
    activeUsers: active.length,
    remaining: Math.max(0, limit - active.length),
    contributorSessions: contrib.length,
  };
}

function quotaSnapshot() {
  return {
    limit: modeSnapshot('taowa').limit, // 兼容旧客户端
    activeTaowaUsers: modeSnapshot('taowa').activeUsers,
    remaining: modeSnapshot('taowa').remaining,
    taowa: modeSnapshot('taowa'),
    easytier: modeSnapshot('easytier'),
    totalContributors: Object.values(DB.users).filter(u => u.contributed).length,
    unclaimedContributions: DB.contributions.filter(c => !c.claimedBy).length,
  };
}

// ---------------- 令牌池自动生成 ----------------
function replenishPool() {
  if (!CFG.autoTokenPool.enabled) return;
  const unclaimed = DB.contributions.filter(c => !c.claimedBy && !c.reservedAt);
  let made = 0;
  while (unclaimed.length + made < CFG.autoTokenPool.size) {
    DB.contributions.push({
      id: crypto.randomBytes(6).toString('hex'),
      token: crypto.randomBytes(5).toString('hex').toUpperCase(),
      note: 'auto-pool', claimedBy: null, reservedAt: null,
      createdAt: now(), claimedAt: null,
    });
    made++;
  }
  if (made) { saveDB(); console.log(`[coordinator] 令牌池自动补充 ${made} 个，当前可用 ${unclaimed.length + made}`); }
}
replenishPool();
setInterval(replenishPool, 10 * 60 * 1000).unref();

// ---------------- HTTP ----------------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const isAdmin = req => req.headers['x-admin-token'] === CFG.adminToken;

// ---------------- 受限下载中转 ----------------
const RELAY_HITS = new Map();   // ip -> { n, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of RELAY_HITS) if (now > v.resetAt) RELAY_HITS.delete(ip);
}, 10 * 60 * 1000).unref();

function relayAllowed(ip) {
  const now = Date.now();
  let v = RELAY_HITS.get(ip);
  if (!v || now > v.resetAt) { v = { n: 0, resetAt: now + 3600 * 1000 }; RELAY_HITS.set(ip, v); }
  v.n++;
  return v.n <= CFG.relay.perHour;
}

function handleRelay(req, res, target) {
  const raw = target || (() => {
    const u = new URL(req.url, 'http://localhost');
    return u.searchParams.get('url') || '';
  })();
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return sendJSON(res, 400, { ok: false, error: 'bad url' }); }
  if (!/^https?:$/.test(parsed.protocol)) return sendJSON(res, 400, { ok: false, error: 'bad protocol' });

  const allow = CFG.relay.hosts.map(h => h.toLowerCase());
  const host = parsed.hostname.toLowerCase();
  if (!allow.includes(host)) {
    console.warn('[coordinator][relay] 拒绝非白名单主机:', host);
    return sendJSON(res, 403, { ok: false, error: 'host not allowed', host });
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!relayAllowed(ip)) {
    console.warn('[coordinator][relay] 触发限流:', ip);
    return sendJSON(res, 429, { ok: false, error: 'rate limited', message: '中转请求过于频繁，请稍后再试' });
  }

  console.log(`[coordinator][relay] ${ip} -> ${parsed.href.slice(0, 120)}`);
  const client = parsed.protocol === 'https:' ? https : http;
  const upstream = client.get(parsed.href, {
    headers: { 'User-Agent': 'EasySUS/1.0 (+https://github.com/easysus/easysus)', 'Accept': '*/*' },
    timeout: 30000,
  }, up => {
    if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location) {
      up.resume();
      const next = new URL(up.headers.location, parsed.href);
      // 重定向目标同样必须在白名单内
      if (!allow.includes(next.hostname.toLowerCase())) {
        return sendJSON(res, 403, { ok: false, error: 'redirect host not allowed', host: next.hostname });
      }
      return handleRelay(req, res, next.href);
    }
    if (up.statusCode !== 200) {
      up.resume();
      return sendJSON(res, up.statusCode, { ok: false, error: 'upstream HTTP ' + up.statusCode });
    }
    const len = Number(up.headers['content-length'] || 0);
    if (len && len > CFG.relay.maxBytes) {
      up.destroy();
      return sendJSON(res, 413, { ok: false, error: 'file too large', size: len });
    }
    res.writeHead(200, {
      'Content-Type': up.headers['content-type'] || 'application/octet-stream',
      'Content-Length': up.headers['content-length'] || undefined,
      'Cache-Control': 'no-store',
      'X-EasySUS-Relay': '1',
    });
    let sent = 0;
    up.on('data', c => {
      sent += c.length;
      if (sent > CFG.relay.maxBytes) { up.destroy(); res.destroy(); }
    });
    up.pipe(res);
    up.on('error', () => res.destroy());
  });
  upstream.on('error', e => { if (!res.headersSent) sendJSON(res, 502, { ok: false, error: 'upstream error: ' + e.message }); else res.destroy(); });
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // 支持 nginx 反代前缀（如 /coord/），路径自动去掉前缀
  let p = url.pathname;
  const PREFIX = '/coord';
  if (p.startsWith(PREFIX + '/')) p = p.slice(PREFIX.length);
  else if (p === PREFIX) p = '/';
  if (req.method === 'OPTIONS') return sendJSON(res, 204, {});

  try {
    // ---- 公共状态 ----
    if (req.method === 'GET' && p === '/api/status') {
      sweep();
      return sendJSON(res, 200, { ok: true, ...quotaSnapshot(), serverTime: now() });
    }

    // ---- 申请额度：body { userId, nickname, mode, requestedSlots } ----
    if (req.method === 'POST' && p === '/api/session/request') {
      const b = await readBody(req);
      const userId = String(b.userId || '').trim();
      const nickname = String(b.nickname || '').trim().slice(0, 32);
      const mode = b.mode === 'easytier' ? 'easytier' : 'taowa';
      const requestedSlots = Number(b.requestedSlots);
      if (!userId) return sendJSON(res, 400, { ok: false, error: 'missing userId' });
      if (!Number.isFinite(requestedSlots) || requestedSlots < 2 || requestedSlots > 10000) {
        return sendJSON(res, 400, { ok: false, error: 'requestedSlots 必须是 请求人数+1，且 ≥ 2' });
      }
      sweep();
      const contributed = isContributor(userId);
      const limit = MODES[mode]();
      const modeName = mode === 'taowa' ? '陶瓦联机' : 'EasyTier';

      // 同用户同模式已有会话 → 续期
      let existing = null;
      for (const [id, s] of Object.entries(DB.sessions)) {
        if (s.userId === userId && (s.mode || 'taowa') === mode) { existing = { id, s }; break; }
      }
      if (existing) {
        existing.s.lastHeartbeat = now();
        existing.s.requestedSlots = requestedSlots;
        saveDB();
        return sendJSON(res, 200, { ok: true, sessionId: existing.id, contributed, renewed: true, mode, ...quotaSnapshot(), message: `${modeName}会话已续期` });
      }

      if (!contributed) {
        const snap = modeSnapshot(mode);
        if (snap.activeUsers >= limit) {
          return sendJSON(res, 429, {
            ok: false, error: 'QUOTA_FULL', mode, ...quotaSnapshot(),
            message: `当前${modeName}用户已满（${snap.activeUsers}/${limit}）。稍后再试，或贡献你的服务器成为贡献者，永久免限制！`,
            contributeHint: true,
          });
        }
      }

      const sessionId = crypto.randomBytes(12).toString('hex');
      DB.sessions[sessionId] = { userId, nickname, mode, requestedSlots, contributed, startedAt: now(), lastHeartbeat: now() };
      saveDB();
      const snap = modeSnapshot(mode);
      console.log(`[coordinator] 授予会话 ${sessionId} mode=${mode} user=${userId} slots=${requestedSlots} contributed=${contributed}`);
      return sendJSON(res, 200, {
        ok: true, sessionId, contributed, mode, ...quotaSnapshot(),
        message: contributed
          ? `欢迎贡献者！${modeName}不受人数限制。`
          : `已获得${modeName}额度（当前 ${snap.activeUsers}/${limit}）。记得每 30 秒发心跳。`,
      });
    }

    // ---- 心跳 / 释放 ----
    if (req.method === 'POST' && p === '/api/session/heartbeat') {
      const b = await readBody(req);
      const s = DB.sessions[String(b.sessionId || '')];
      if (!s) return sendJSON(res, 404, { ok: false, error: 'SESSION_NOT_FOUND' });
      if (b.userId && s.userId !== String(b.userId)) return sendJSON(res, 403, { ok: false, error: 'userId mismatch' });
      s.lastHeartbeat = now();
      saveDB();
      return sendJSON(res, 200, { ok: true, ...quotaSnapshot() });
    }
    if (req.method === 'POST' && p === '/api/session/release') {
      const b = await readBody(req);
      const sid = String(b.sessionId || '');
      const s = DB.sessions[sid];
      if (!s) return sendJSON(res, 200, { ok: true, already: true });
      if (b.userId && s.userId !== String(b.userId)) return sendJSON(res, 403, { ok: false, error: 'userId mismatch' });
      delete DB.sessions[sid];
      saveDB();
      console.log(`[coordinator] 释放会话 ${sid} user=${s.userId}`);
      return sendJSON(res, 200, { ok: true, ...quotaSnapshot() });
    }

    // ---- 认领贡献令牌 ----
    if (req.method === 'POST' && p === '/api/contributions/claim') {
      const b = await readBody(req);
      const userId = String(b.userId || '').trim();
      const token = String(b.token || '').trim().toUpperCase();
      if (!userId || !token) return sendJSON(res, 400, { ok: false, error: 'missing userId/token' });
      const c = DB.contributions.find(x => x.token.toUpperCase() === token && !x.claimedBy);
      if (!c) return sendJSON(res, 403, { ok: false, error: 'TOKEN_INVALID', message: '捐赠令牌无效或已被认领。请先在 GitHub 提交 issue 申请令牌。' });
      c.claimedBy = userId;
      c.claimedAt = now();
      DB.users[userId] = { contributed: true, contributionId: c.id, registeredAt: now() };
      for (const s of Object.values(DB.sessions)) if (s.userId === userId) s.contributed = true;
      saveDB();
      replenishPool();
      console.log(`[coordinator] 用户 ${userId} 认领贡献 ${c.id}`);
      return sendJSON(res, 200, { ok: true, contributed: true, message: '认领成功！感谢你的贡献，你已永久免除所有联机人数限制。', ...quotaSnapshot() });
    }

    // ---- 管理员：从池中取一个令牌（发给 issue 提交者）----
    if (req.method === 'POST' && p === '/api/admin/contributions/take') {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok: false, error: 'bad admin token' });
      const b = await readBody(req);
      let c = DB.contributions.find(x => !x.claimedBy && !x.reservedAt);
      if (!c) { // 池空了，现场生成
        c = { id: crypto.randomBytes(6).toString('hex'), token: crypto.randomBytes(5).toString('hex').toUpperCase(), note: '', claimedBy: null, reservedAt: null, createdAt: now(), claimedAt: null };
        DB.contributions.push(c);
      }
      c.reservedAt = now();
      c.note = String(b.note || c.note || '').slice(0, 200);
      saveDB();
      return sendJSON(res, 200, { ok: true, token: c.token, contribution: c });
    }

    // ---- 管理员：手动发放令牌 ----
    if (req.method === 'POST' && p === '/api/admin/contributions/grant') {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok: false, error: 'bad admin token' });
      const b = await readBody(req);
      const token = (String(b.token || '').trim() || crypto.randomBytes(5).toString('hex')).toUpperCase();
      const c = { id: crypto.randomBytes(6).toString('hex'), token, note: String(b.note || '').slice(0, 200), claimedBy: null, reservedAt: null, createdAt: now(), claimedAt: null };
      DB.contributions.push(c);
      saveDB();
      return sendJSON(res, 200, { ok: true, contribution: c });
    }

    // ---- 公网入口网关：开启 ----
    if (req.method === 'POST' && p === '/api/gateway/open') {
      const b = await readBody(req);
      const userId = String(b.userId || '').trim();
      if (!userId) return sendJSON(res, 400, { ok: false, error: 'missing userId' });
      if (!b.netName || !b.netSecret || !b.mcVirtualIp || !b.mcPort) {
        return sendJSON(res, 400, { ok: false, error: 'missing netName/netSecret/mcVirtualIp/mcPort' });
      }
      // 同一用户已有网关 → 续期
      const existing = Object.values(GW.entries).find(e => e.userId === userId);
      if (existing) {
        existing.lastHeartbeat = now();
        return sendJSON(res, 200, { ok: true, renewed: true, gateway: gwInfo(existing) });
      }
      try {
        const e = gwStart({
          userId,
          nickname: String(b.nickname || '').slice(0, 32),
          netName: String(b.netName), netSecret: String(b.netSecret),
          mcVirtualIp: String(b.mcVirtualIp), mcPort: Number(b.mcPort),
        });
        return sendJSON(res, 200, { ok: true, gateway: gwInfo(e) });
      } catch (err) {
        return sendJSON(res, 500, { ok: false, error: err.message });
      }
    }

    // ---- 公网入口网关：心跳 ----
    if (req.method === 'POST' && p === '/api/gateway/heartbeat') {
      const b = await readBody(req);
      const e = GW.entries[String(b.gwId || '')];
      if (!e) return sendJSON(res, 404, { ok: false, error: 'GW_NOT_FOUND' });
      if (b.userId && e.userId !== String(b.userId)) return sendJSON(res, 403, { ok: false, error: 'userId mismatch' });
      e.lastHeartbeat = now();
      return sendJSON(res, 200, { ok: true, gateway: gwInfo(e) });
    }

    // ---- 公网入口网关：关闭 ----
    if (req.method === 'POST' && p === '/api/gateway/close') {
      const b = await readBody(req);
      const e = GW.entries[String(b.gwId || '')];
      if (!e) return sendJSON(res, 200, { ok: true, already: true });
      if (b.userId && e.userId !== String(b.userId)) return sendJSON(res, 403, { ok: false, error: 'userId mismatch' });
      gwStop(String(b.gwId));
      return sendJSON(res, 200, { ok: true });
    }

    // ---- 公网入口网关：状态（客户端轮询用）----
    if (req.method === 'GET' && p === '/api/gateway/status') {
      const uid = url.searchParams.get('userId');
      const e = Object.values(GW.entries).find(x => x.userId === uid);
      return sendJSON(res, 200, { ok: true, enabled: CFG.gateway.enabled, gateway: e ? gwInfo(e) : null });
    }

    // ---- 管理员：网关总览 ----
    if (req.method === 'GET' && p === '/api/admin/gateway') {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok: false, error: 'bad admin token' });
      return sendJSON(res, 200, { ok: true, entries: Object.values(GW.entries).map(gwInfo) });
    }

    // ---- 管理员：令牌/会话/用户总览 ----
    if (req.method === 'GET' && p === '/api/admin/overview') {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok: false, error: 'bad admin token' });
      sweep();
      return sendJSON(res, 200, { ok: true, sessions: DB.sessions, users: DB.users, contributions: DB.contributions, ...quotaSnapshot() });
    }

    // ---- 管理员：直接标记贡献者 ----
    if (req.method === 'POST' && p === '/api/admin/users/mark-contributor') {
      if (!isAdmin(req)) return sendJSON(res, 403, { ok: false, error: 'bad admin token' });
      const b = await readBody(req);
      const userId = String(b.userId || '').trim();
      if (!userId) return sendJSON(res, 400, { ok: false, error: 'missing userId' });
      DB.users[userId] = { contributed: b.contributed !== false, contributionId: null, registeredAt: now() };
      for (const s of Object.values(DB.sessions)) if (s.userId === userId) s.contributed = DB.users[userId].contributed;
      saveDB();
      return sendJSON(res, 200, { ok: true, user: DB.users[userId], ...quotaSnapshot() });
    }

    // ---- 版本公告（自动更新兜底：管理员放一个 version.json 在协调中心目录即可）----
    if (req.method === 'GET' && p === '/api/version') {
      try {
        const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
        return sendJSON(res, 200, { ok: true, ...v });
      } catch (_) {
        return sendJSON(res, 404, { ok: false, error: 'no version published' });
      }
    }

    // ---- 受限下载中转（客户端直连失败时使用，主机白名单 + 限流）----
    if (req.method === 'GET' && p === '/api/relay') {
      if (!CFG.relay.enabled) return sendJSON(res, 503, { ok: false, error: 'relay disabled' });
      return handleRelay(req, res);
    }

    // ---- 首页面板 ----
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const q = quotaSnapshot();
      const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>EasySUS Coordinator</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;background:#0f1220;color:#e8eaf2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#181c30;border:1px solid #2a3050;border-radius:16px;padding:32px 40px;max-width:620px}
h1{margin:0 0 8px;font-size:22px}.big{font-size:40px;font-weight:700;color:#7dd3fc}
.tag{display:inline-block;background:#14532d;color:#86efac;border-radius:999px;padding:2px 12px;font-size:13px;margin-left:8px}
table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}td{padding:6px 4px;border-bottom:1px solid #232845}
td:last-child{text-align:right;color:#93c5fd}.cols{display:flex;gap:36px}</style></head><body><div class="card">
<h1>🌐 EasySUS Coordinator <span class="tag">运行中</span></h1>
<div class="cols">
<div><div class="big">${q.taowa.activeUsers} / ${q.taowa.limit}</div><div>🏺 陶瓦联机占用（贡献者不占额度）</div></div>
<div><div class="big">${q.easytier.activeUsers} / ${q.easytier.limit}</div><div>🕸️ EasyTier 占用</div></div>
</div>
<table>
<tr><td>已登记贡献者</td><td>${q.totalContributors}</td></tr>
<tr><td>待认领捐赠令牌</td><td>${q.unclaimedContributions}</td></tr>
</table>
<p style="color:#94a3b8;font-size:13px">捐赠令牌请提交 GitHub issue 申请 · API: /api/status /api/session/request heartbeat release contributions/claim</p>
</div></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    return sendJSON(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: e.message });
  }
});

server.listen(CFG.port, CFG.host, () => {
  console.log(`[coordinator] EasySUS Coordinator v2 已启动: http://${CFG.host}:${CFG.port}`);
  console.log(`[coordinator] 陶瓦上限 ${CFG.taowaUserLimit} | EasyTier 上限 ${CFG.easytierUserLimit}（贡献者豁免）`);
  console.log(`[coordinator] 令牌池: ${CFG.autoTokenPool.enabled ? '自动补充至 ' + CFG.autoTokenPool.size + ' 个' : '关闭'}`);
});

process.on('uncaughtException', e => console.error('[coordinator] uncaught:', e.message));
process.on('unhandledRejection', e => console.error('[coordinator] unhandled:', (e && e.message) || e));
