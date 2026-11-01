#!/usr/bin/env node
/**
 * EasySUS Client —— 腐竹本机运行的网页控制台
 * 零依赖，Node.js >= 16，跨平台（Windows / Linux / macOS）
 * 启动: node server.js  → 打开 http://127.0.0.1:19388
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, getConfig, publicNetworkConfig } = require('./config');
const mc = require('./mcserver');
const dl = require('./download');
const java = require('./java');
const quota = require('./quota');
const terracotta = require('./terracotta');
const easytier = require('./easytier');
const mods = require('./mods');
const lanbroadcast = require('./lanbroadcast');
const gateway = require('./gateway');

loadConfig();

process.on('uncaughtException', e => console.error('[EasySUS] uncaught:', e.message));
process.on('unhandledRejection', e => console.error('[EasySUS] unhandled rejection:', (e && e.message) || e));

const WEB_ROOT = path.join(__dirname, 'web');

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const PROGRESS = {};  // taskId -> {type, version, done, total, status, file}

function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(WEB_ROOT, p);
  if (!file.startsWith(WEB_ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const M = req.method;

  try {
    // ===== 状态总览 =====
    if (M === 'GET' && p === '/api/status') {
      const cfg = getConfig();
      const st = mc.getStatus();
      let coord = null;
      try { coord = await quota.getCoordinatorStatus(); } catch (_) {}
      return sendJSON(res, 200, {
        ok: true,
        server: {
          running: st.running, starting: st.starting, type: st.serverType, version: st.version,
          pid: st.pid, port: st.port, uptimeMs: st.uptimeMs, players: st.players, motd: st.motd, tps: st.tps,
          java: st.javaPath, lastError: st.lastError, console: st.console,
        },
        network: {
          mode: cfg.netMode,
          webPort: cfg.webPort,
          direct: { port: cfg.directPort },
          coordinator: coord ? Object.assign({}, coord, { connected: coord.ok === true }) : { connected: false },
          taowa: Object.assign({ requestedSlots: cfg.taowa.requestedSlots,
            userId: cfg.taowa.userId, nickname: cfg.taowa.nickname, session: quota.session('taowa') },
            pickTerracotta(terracotta.getStatus())),
          easytier: Object.assign({ requestedSlots: cfg.easytier.requestedSlots, session: quota.session('easytier') },
            pickEasytier(easytier.getStatus())),
          gateway: gateway.gw,
        },
        theme: cfg.theme,
        instances: mc.listInstances(),
      });
    }

    function pickTerracotta(t) {
      return { installed: t.installed, running: t.running, state: t.state, room: t.room,
        profiles: t.profiles, httpPort: t.httpPort, meta: t.meta, log: t.log, mirrors: t.mirrors,
        broadcast: t.broadcast };
    }
    function pickEasytier(e) {
      return { installed: e.installed, running: e.running, virtualIp: e.virtualIp,
        netName: e.netName, log: e.log, joinInfo: e.joinInfo };
    }

    // ===== 控制台日志 =====
    if (M === 'GET' && p === '/api/console') {
      const st = mc.getStatus();
      return sendJSON(res, 200, { ok: true, console: st.console, running: st.running, starting: st.starting });
    }

    // ===== 启动 / 停止 / 命令 =====
    if (M === 'POST' && p === '/api/server/start') {
      const b = await readBody(req);
      const cfg = getConfig();
      // 陶瓦模式：必须先拿到额度
      if (cfg.netMode === 'taowa') {
        const q = await quota.requestQuota('taowa');
        if (!q.ok) return sendJSON(res, 409, { ok: false, error: 'TAOWA_QUOTA', detail: q, message: q.message || '陶瓦联机额度申请失败' });
      }
      const r = await mc.start(b);
      if (!r.ok && cfg.netMode === 'taowa') await quota.releaseQuota('taowa');
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (M === 'POST' && p === '/api/server/stop') {
      const cfg = getConfig();
      const r = await mc.stop();
      if (cfg.netMode === 'taowa') { await terracotta.stop(); await quota.releaseQuota('taowa'); }
      // 服务器停了，公网入口也失去意义 → 自动关闭
      if (gateway.gw) { try { await gateway.close(); } catch (_) {} }
      return sendJSON(res, 200, r);
    }
    if (M === 'POST' && p === '/api/server/kill') return sendJSON(res, 200, mc.kill());
    if (M === 'POST' && p === '/api/server/command') {
      const b = await readBody(req);
      return sendJSON(res, 200, mc.sendCommand(String(b.command || '')));
    }

    // ===== 实例 / props =====
    if (M === 'GET' && p === '/api/instances') return sendJSON(res, 200, { ok: true, instances: mc.listInstances() });
    if (M === 'POST' && p === '/api/instances/delete') {
      const b = await readBody(req);
      const cfg = getConfig();
      const id = String(b.id || '');
      const dir = safeJoin(cfg.serverDir, id);
      if (!dir || dir === cfg.serverDir) return sendJSON(res, 403, { ok: false, error: '非法的实例名' });
      if (!fs.existsSync(dir)) return sendJSON(res, 404, { ok: false, error: `实例 ${id} 不存在` });
      // 运行中的实例不允许删除
      const st = mc.getStatus();
      if (st.running && st.dir === dir) {
        return sendJSON(res, 409, { ok: false, error: 'RUNNING', message: '该服务端正在运行，请先停止再删除' });
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return sendJSON(res, 200, { ok: true, removed: id });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }
    if (M === 'GET' && p === '/api/instance/props') {
      const cfg = getConfig();
      const dir = safeJoin(cfg.serverDir, url.searchParams.get('id'));
      if (!dir) return sendJSON(res, 403, { ok: false });
      return sendJSON(res, 200, { ok: true, props: mc.readServerProps(dir) });
    }
    if (M === 'POST' && p === '/api/instance/props') {
      const b = await readBody(req);
      const cfg = getConfig();
      const dir = safeJoin(cfg.serverDir, String(b.id || ''));
      if (!dir) return sendJSON(res, 403, { ok: false });
      mc.writeServerProps(dir, b.props || {});
      return sendJSON(res, 200, { ok: true });
    }

    // ===== 下载服务端 =====
    if (M === 'GET' && p === '/api/download/meta') {
      const cfg = getConfig();
      return sendJSON(res, 200, { ok: true, types: dl.SERVER_TYPES, sources: dl.DOWNLOAD_SOURCES, currentSource: cfg.downloadSource });
    }
    if (M === 'GET' && p === '/api/download/versions') {
      const type = url.searchParams.get('type') || '';
      try {
        return sendJSON(res, 200, { ok: true, type, versions: await dl.listVersionsByType(type) });
      } catch (e) {
        // 拿不到该类型的专属版本列表时，回退到官方版本清单
        try { return sendJSON(res, 200, { ok: true, type, versions: await dl.listVersions(), fallback: true, error: e.message }); }
        catch (e2) { return sendJSON(res, 200, { ok: false, versions: [], error: e2.message }); }
      }
    }
    if (M === 'POST' && p === '/api/download/source') {
      const b = await readBody(req);
      dl.setDownloadSource(String(b.source));
      return sendJSON(res, 200, { ok: true, source: getConfig().downloadSource });
    }
    if (M === 'POST' && p === '/api/download/start') {
      const b = await readBody(req);
      const type = String(b.type), version = String(b.version);
      const taskId = `${type}-${version}-${Date.now()}`;
      PROGRESS[taskId] = { type, version, done: 0, total: 0, status: 'downloading' };
      dl.downloadServer(type, version, (done, total) => { PROGRESS[taskId].done = done; PROGRESS[taskId].total = total; })
        .then(r => {
        PROGRESS[taskId].status = 'done'; PROGRESS[taskId].file = r.file;
        PROGRESS[taskId].dir = r.dir; PROGRESS[taskId].note = r.note; PROGRESS[taskId].isInstaller = r.isInstaller;
        PROGRESS[taskId].relayed = r.relayed;
      })
        .catch(e => { PROGRESS[taskId].status = 'error'; PROGRESS[taskId].error = e.message; });
      return sendJSON(res, 200, { ok: true, taskId });
    }
    if (M === 'GET' && p === '/api/download/progress') return sendJSON(res, 200, { ok: true, progress: PROGRESS[url.searchParams.get('taskId')] || null });

    // ===== 模组 / 插件下载（Modrinth）=====
    if (M === 'GET' && p === '/api/mods/meta') {
      return sendJSON(res, 200, { ok: true, loaders: mods.LOADERS, projectTypes: mods.PROJECT_TYPES, loaderMap: mods.LOADER_MAP, instances: mc.listInstances().map(i => ({ id: i.id, type: i.type, version: i.version })) });
    }
    if (M === 'GET' && p === '/api/mods/search') {
      const r = await mods.search({
        query: url.searchParams.get('query') || '',
        projectType: url.searchParams.get('type') || '',
        loader: url.searchParams.get('loader') || '',
        gameVersion: url.searchParams.get('gameVersion') || '',
        index: url.searchParams.get('index') || 'relevance',
        offset: Number(url.searchParams.get('offset')) || 0,
        limit: Number(url.searchParams.get('limit')) || 20,
      });
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (M === 'GET' && p === '/api/mods/versions') {
      const list = await mods.versions(url.searchParams.get('projectId'), {
        loader: url.searchParams.get('loader') || '',
        gameVersion: url.searchParams.get('gameVersion') || '',
      });
      return sendJSON(res, 200, { ok: true, versions: list });
    }
    if (M === 'GET' && p === '/api/mods/installed') {
      const instanceId = url.searchParams.get('instanceId');
      return sendJSON(res, 200, { ok: true, files: mods.listInstalled(instanceId) });
    }
    if (M === 'POST' && p === '/api/mods/install') {
      const b = await readBody(req);
      const taskId = `mod-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      PROGRESS[taskId] = { type: 'mod', done: 0, total: b.file && b.file.size || 0, status: 'downloading', name: b.file && b.file.filename };
      mods.install({
        instanceId: String(b.instanceId || ''),
        projectType: String(b.projectType || 'mod'),
        loaders: Array.isArray(b.loaders) ? b.loaders : [],
        file: b.file,
        versionName: String(b.versionName || ''),
      }, (done, total) => { PROGRESS[taskId].done = done; PROGRESS[taskId].total = total; })
        .then(r => { PROGRESS[taskId].status = 'done'; PROGRESS[taskId].file = r.file; PROGRESS[taskId].subdir = r.subdir; })
        .catch(e => { PROGRESS[taskId].status = 'error'; PROGRESS[taskId].error = e.message; });
      return sendJSON(res, 200, { ok: true, taskId });
    }
    if (M === 'POST' && p === '/api/mods/remove') {
      const b = await readBody(req);
      try {
        const r = mods.remove(String(b.instanceId || ''), String(b.subdir || 'mods'), String(b.name || ''));
        return sendJSON(res, 200, { ok: true, ...r });
      } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    }
    if (M === 'POST' && p === '/api/mods/toggle') {
      const b = await readBody(req);
      try {
        const r = mods.toggle(String(b.instanceId || ''), String(b.subdir || 'mods'), String(b.name || ''), b.enable !== false);
        return sendJSON(res, 200, { ok: true, ...r });
      } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    }

    // ===== Java =====
    if (M === 'GET' && p === '/api/java') {
      const list = await java.detectSystemJava();
      return sendJSON(res, 200, { ok: true, system: list, downloaded: java.downloadedJava(), platform: process.platform, arch: process.arch });
    }
    if (M === 'POST' && p === '/api/java/download') {
      const b = await readBody(req);
      const major = Number(b.major) || 21;
      const taskId = `java-${major}-${Date.now()}`;
      PROGRESS[taskId] = { type: 'java', version: major, done: 0, total: 0, status: 'downloading' };
      java.downloadJava(major, (done, total) => { PROGRESS[taskId].done = done; PROGRESS[taskId].total = total; })
        .then(r => { PROGRESS[taskId].status = 'done'; PROGRESS[taskId].file = r.path; })
        .catch(e => { PROGRESS[taskId].status = 'error'; PROGRESS[taskId].error = e.message; });
      return sendJSON(res, 200, { ok: true, taskId });
    }

    // ===== 主题（UI 颜色）=====
    if (M === 'GET' && p === '/api/theme') return sendJSON(res, 200, { ok: true, theme: getConfig().theme });
    if (M === 'POST' && p === '/api/theme') {
      const b = await readBody(req);
      const theme = {};
      if (b.preset) theme.preset = String(b.preset);
      if (b.custom) theme.custom = b.custom;
      saveConfig({ theme });
      return sendJSON(res, 200, { ok: true, theme: getConfig().theme });
    }

    // ===== 联机配置 =====
    if (M === 'GET' && p === '/api/network/config') {
      // 脱敏：不返回协调中心地址
      return sendJSON(res, 200, { ok: true, ...publicNetworkConfig() });
    }
    if (M === 'POST' && p === '/api/network/config') {
      const b = await readBody(req);
      const patch = {};
      if (b.netMode && ['direct', 'taowa'].includes(b.netMode)) patch.netMode = b.netMode;
      if (b.directPort) patch.directPort = Number(b.directPort);
      if (b.taowa) {
        patch.taowa = {};
        // coordinatorUrl 为内置锁定项：请求里带了也一律忽略（防止被指向第三方服务）
        if (b.taowa.coordinatorUrl !== undefined) console.warn('[EasySUS] 忽略对内置协调中心地址的修改请求');
        if (b.taowa.nickname !== undefined) patch.taowa.nickname = String(b.taowa.nickname);
        if (b.taowa.requestedSlots !== undefined) patch.taowa.requestedSlots = Number(b.taowa.requestedSlots);
        if (b.taowa.publicNodes !== undefined) patch.taowa.publicNodes = Array.isArray(b.taowa.publicNodes) ? b.taowa.publicNodes : [];
      }
      if (b.easytier) {
        patch.easytier = {};
        if (b.easytier.port !== undefined) patch.easytier.port = Number(b.easytier.port);
        if (b.easytier.requestedSlots !== undefined) patch.easytier.requestedSlots = Number(b.easytier.requestedSlots);
        if (b.easytier.virtualIp !== undefined) patch.easytier.virtualIp = String(b.easytier.virtualIp);
      }
      saveConfig(patch);
      return sendJSON(res, 200, { ok: true, config: publicNetworkConfig() });
    }

    // ===== 陶瓦联机 (Terracotta) =====
    if (M === 'GET' && p === '/api/taowa/status') return sendJSON(res, 200, { ok: true, ...terracotta.getStatus() });
    if (M === 'POST' && p === '/api/taowa/install') {
      const b = await readBody(req);
      const taskId = `terracotta-${Date.now()}`;
      PROGRESS[taskId] = { type: 'terracotta', done: 0, total: 0, status: 'downloading' };
      terracotta.install(b.mirror, (done, total) => { PROGRESS[taskId].done = done; PROGRESS[taskId].total = total; })
        .then(r => { PROGRESS[taskId].status = 'done'; PROGRESS[taskId].file = r.exe; })
        .catch(e => { PROGRESS[taskId].status = 'error'; PROGRESS[taskId].error = e.message; });
      return sendJSON(res, 200, { ok: true, taskId });
    }
    if (M === 'POST' && p === '/api/taowa/start') {
      // 先申请额度
      const q = await quota.requestQuota('taowa');
      if (!q.ok) return sendJSON(res, 409, { ok: false, error: 'TAOWA_QUOTA', detail: q, message: q.message });
      const r = await terracotta.start();
      if (!r.ok) await quota.releaseQuota('taowa');
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (M === 'POST' && p === '/api/taowa/host') {
      const b = await readBody(req);
      const cfg = getConfig();
      const st = mc.getStatus();
      if (!st.running) {
        return sendJSON(res, 400, { ok: false, error: 'MC_NOT_RUNNING',
          message: '请先启动 Minecraft 服务器再创建房间：陶瓦需要发现本机正在运行的服务器端口。' });
      }
      const r = await terracotta.hostRoom(b.playerName || cfg.taowa.nickname, b.room, st.port || cfg.directPort);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    // 局域网广播手动开关（陶瓦靠它发现专用服务端）
    if (M === 'POST' && p === '/api/taowa/broadcast') {
      const b = await readBody(req);
      const st = mc.getStatus();
      if (b.enable === false) return sendJSON(res, 200, { ok: true, ...lanbroadcast.stop() });
      const port = Number(b.port) || st.port || getConfig().directPort;
      return sendJSON(res, 200, { ok: true, ...lanbroadcast.start(port) });
    }
    if (M === 'POST' && p === '/api/taowa/stop') {
      await terracotta.stop();
      await quota.releaseQuota('taowa');
      return sendJSON(res, 200, { ok: true });
    }

    // ===== EasyTier =====
    if (M === 'GET' && p === '/api/easytier/status') return sendJSON(res, 200, { ok: true, ...easytier.getStatus() });
    if (M === 'POST' && p === '/api/easytier/install') {
      const b = await readBody(req);
      const taskId = `easytier-${Date.now()}`;
      PROGRESS[taskId] = { type: 'easytier', done: 0, total: 0, status: 'downloading' };
      easytier.install(b.mirror, (done, total) => { PROGRESS[taskId].done = done; PROGRESS[taskId].total = total; })
        .then(r => { PROGRESS[taskId].status = 'done'; PROGRESS[taskId].file = r.exe; })
        .catch(e => { PROGRESS[taskId].status = 'error'; PROGRESS[taskId].error = e.message; });
      return sendJSON(res, 200, { ok: true, taskId });
    }
    if (M === 'POST' && p === '/api/easytier/start') {
      const q = await quota.requestQuota('easytier');
      if (!q.ok) return sendJSON(res, 409, { ok: false, error: 'EASYTIER_QUOTA', detail: q, message: q.message });
      const cfg = getConfig();
      const r = await easytier.start({ mcPort: cfg.easytier.port || cfg.directPort });
      if (!r.ok) await quota.releaseQuota('easytier');
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (M === 'POST' && p === '/api/easytier/stop') {
      easytier.stop();
      await quota.releaseQuota('easytier');
      return sendJSON(res, 200, { ok: true });
    }

    // ===== 公网入口（玩家免装软件直连）=====
    if (M === 'GET' && p === '/api/gateway/status') {
      const r = await gateway.status();
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (M === 'POST' && p === '/api/gateway/open') {
      const st = mc.getStatus();
      if (!st.running) {
        return sendJSON(res, 400, { ok: false, error: 'MC_NOT_RUNNING',
          message: '请先启动 Minecraft 服务器，再开启公网入口（网关要把公网端口转发到你正在运行的服务器）' });
      }
      const r = await gateway.open();
      return sendJSON(res, r.ok ? 200 : 409, r);
    }
    if (M === 'POST' && p === '/api/gateway/close') {
      const r = await gateway.close();
      return sendJSON(res, 200, r);
    }

    // ===== 贡献令牌认领 =====
    if (M === 'POST' && p === '/api/contribution/claim') {
      const b = await readBody(req);
      const r = await quota.claimContribution(String(b.token || ''));
      return sendJSON(res, r.ok ? 200 : 400, r);
    }

    if (M === 'GET') return serveStatic(res, p);
    return sendJSON(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: e.message, stack: e.stack });
  }
});

function safeJoin(root, sub) {
  if (!sub) return null;
  const full = path.join(root, sub);
  return full.startsWith(root) ? full : null;
}

const cfg = getConfig();
server.listen(cfg.webPort, cfg.webHost, () => {
  console.log('===========================================');
  console.log('  🟩 EasySUS —— Minecraft 服务器快速搭建');
  console.log('===========================================');
  console.log(`  控制台: http://${cfg.webHost}:${cfg.webPort}`);
  console.log(`  联机模式: ${({ direct: '自有公网IP', taowa: '陶瓦联机' })[cfg.netMode]}`);
  console.log(`  联机服务: 已内置加密（地址不显示，不可修改）`);
  console.log('===========================================');
});

process.on('SIGINT', async () => {
  console.log('\n[EasySUS] 正在关闭...');
  if (mc.getStatus().running) { try { await mc.stop(); } catch (_) {} }
  try { await terracotta.stop(); } catch (_) {}
  try { await gateway.close(); } catch (_) {}
  easytier.stop();
  for (const mode of ['taowa', 'easytier']) { try { await quota.releaseQuota(mode); } catch (_) {} }
  setTimeout(() => process.exit(0), 1500);
});
