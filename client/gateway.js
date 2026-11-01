'use strict';
/**
 * 公网入口（Gateway）客户端
 *
 * 让玩家不装任何软件、不用房间号，直接连「域名/公网IP:端口」进服：
 *   1. 确保本机 EasyTier 已运行（腐竹的私有网，虚拟 IP 上跑着 MC 服务器）
 *   2. 向内置联机服务申请开启公网入口（服务端用 easytier-core 加入同一网络，
 *      并把公网端口转发到 本机虚拟IP:MC端口）
 *   3. 维持 30 秒心跳；停止时释放公网端口
 *
 * 占用一个「远程访问(easytier)」额度池的名额（≤8），贡献者豁免。
 */
const { getConfig } = require('./config');
const quota = require('./quota');
const easytier = require('./easytier');
const mc = require('./mcserver');

const HB_MS = 30 * 1000;
let HB = null;
let GW = null;   // { gwId, publicAddress, status, log }

function base() { return getConfig().taowa.coordinatorUrl.replace(/\/$/, ''); }

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === 'https:' ? require('https') : require('http');
    const data = JSON.stringify(body || {});
    const req = client.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000,
    }, res => {
      let out = ''; res.setEncoding('utf8');
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out || '{}')); } catch (e) { resolve({ ok: false, raw: out }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === 'https:' ? require('https') : require('http');
    client.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, timeout: 15000 }, res => {
      let out = ''; res.setEncoding('utf8');
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out || '{}')); } catch (e) { reject(new Error('bad json')); } });
    }).on('error', reject);
  });
}

/**
 * 开启公网入口
 * 前提检查：MC 服务器在运行；本机 EasyTier 在运行（不在则自动启动）
 */
async function open() {
  if (GW && GW.status === 'ready') return { ok: true, already: true, gateway: GW };
  const cfg = getConfig();
  const et = ensureEasytierRunning();
  if (!et.ok) return et;

  // 占一个 easytier 额度（贡献者豁免）
  const q = await quota.requestQuota('easytier');
  if (!q.ok) return { ok: false, error: 'EASYTIER_QUOTA', detail: q, message: q.message || '远程访问额度已满' };

  try {
    const info = easytier.ensureNetwork();
    const mcPort = mc.getStatus().port || cfg.directPort || 25565;
    const r = await postJSON(base() + '/api/gateway/open', {
      userId: cfg.taowa.userId,
      nickname: cfg.taowa.nickname,
      netName: info.netName,
      netSecret: info.netSecret,
      mcVirtualIp: info.virtualIp,
      mcPort,
    });
    if (!r.ok || !r.gateway) {
      await quota.releaseQuota('easytier');
      return { ok: false, error: r.error || 'GW_OPEN_FAILED', message: r.message || r.error || '公网入口开启失败' };
    }
    GW = Object.assign({ status: r.gateway.status }, r.gateway);
    startHeartbeat();
    return { ok: true, gateway: GW, renewed: r.renewed };
  } catch (e) {
    await quota.releaseQuota('easytier');
    return { ok: false, error: e.message };
  }
}

async function ensureEasytierRunning() {
  const st = easytier.getStatus();
  if (st.running) return { ok: true };
  const r = await easytier.start({});
  if (!r.ok) return { ok: false, error: r.error || 'ET_NOT_RUNNING',
    message: r.error === 'NEED_ADMIN'
      ? '本机 EasyTier 需要管理员权限（创建虚拟网卡），请以管理员身份运行 EasySUS'
      : '本机 EasyTier 启动失败：' + (r.message || r.error) };
  // 等待组网就绪
  await new Promise(x => setTimeout(x, 4000));
  const st2 = easytier.getStatus();
  if (!st2.running) return { ok: false, error: 'ET_NOT_RUNNING', message: '本机 EasyTier 未能保持运行，请查看远程访问页日志' };
  return { ok: true };
}

function startHeartbeat() {
  stopHeartbeat();
  HB = setInterval(async () => {
    if (!GW) return;
    try {
      const r = await postJSON(base() + '/api/gateway/heartbeat', { gwId: GW.gwId, userId: getConfig().taowa.userId });
      if (r && r.ok && r.gateway) { GW = Object.assign({}, GW, r.gateway); }
      else if (r && r.error === 'GW_NOT_FOUND') { GW = null; stopHeartbeat(); }
    } catch (_) {}
  }, HB_MS);
  HB.unref();
}
function stopHeartbeat() { if (HB) { clearInterval(HB); HB = null; } }

async function close() {
  stopHeartbeat();
  if (GW) {
    try { await postJSON(base() + '/api/gateway/close', { gwId: GW.gwId, userId: getConfig().taowa.userId }); } catch (_) {}
    GW = null;
  }
  // 网关与「远程访问面板」共用同一个 easytier 额度会话；
  // 仅当本机 EasyTier 也不再运行时才真正释放额度
  if (!easytier.getStatus().running) await quota.releaseQuota('easytier');
  return { ok: true };
}

async function status() {
  // 本地缓存 + 服务端实时状态合并
  try {
    const r = await getJSON(base() + '/api/gateway/status?userId=' + encodeURIComponent(getConfig().taowa.userId || ''));
    if (r && r.ok) {
      if (r.gateway) GW = Object.assign({}, GW || {}, r.gateway);
      else if (GW && GW.status !== 'error') GW = null;
      return { ok: true, gateway: r.gateway, enabled: r.enabled };
    }
  } catch (_) {}
  return { ok: false, gateway: GW, enabled: null };
}

module.exports = { open, close, status, get gw() { return GW; } };