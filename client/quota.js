'use strict';
/**
 * 配额客户端 —— 与内置联机服务通信（地址见 secret.js，不落盘/不外露）
 * 陶瓦(Terracotta, ≤6) 与 EasyTier 远程访问(≤8) 两种模式共用此客户端。
 * 规则：开启前发送「请求人数+1」申请会话；贡献者豁免且不占额度。
 */
const { getConfig, saveConfig } = require('./config');
const crypto = require('crypto');

const SESSIONS = {};  // mode -> { sessionId, contributed, snapshot }
const HBS = {};       // mode -> interval

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
      timeout: 8000,
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
    client.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, timeout: 8000 }, res => {
      let out = ''; res.setEncoding('utf8');
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out || '{}')); } catch (e) { reject(new Error('bad json')); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

async function getCoordinatorStatus() {
  try {
    const r = await getJSON(base() + '/api/status');
    if (r && typeof r === 'object') delete r.coordinatorUrl;  // 不外露地址
    return r;
  } catch (e) {
    // 注意：不返回地址，只返回状态
    return { ok: false, error: '无法连接协调中心（请检查网络）' };
  }
}

function ensureUserId() {
  const cfg = getConfig();
  if (!cfg.taowa.userId) {
    saveConfig({ taowa: { userId: 'u_' + crypto.randomBytes(6).toString('hex') } });
  }
  return getConfig().taowa.userId;
}

/**
 * 申请额度。mode: 'taowa' | 'easytier'
 * requestedSlots = 请求人数 + 1
 */
async function requestQuota(mode = 'taowa', requestedSlots) {
  const cfg = getConfig();
  const userId = ensureUserId();
  const slots = Number(requestedSlots) || (mode === 'easytier' ? cfg.easytier.requestedSlots : cfg.taowa.requestedSlots);
  try {
    const r = await postJSON(base() + '/api/session/request', {
      userId, nickname: cfg.taowa.nickname, mode, requestedSlots: slots,
    });
    if (r.ok) {
      SESSIONS[mode] = { sessionId: r.sessionId, contributed: r.contributed, snapshot: r };
      startHeartbeat(mode);
    }
    return r;
  } catch (e) {
    return { ok: false, error: '协调中心请求失败: ' + e.message };
  }
}

function startHeartbeat(mode) {
  stopHeartbeat(mode);
  HBS[mode] = setInterval(async () => {
    const s = SESSIONS[mode];
    if (!s) return;
    try {
      const r = await postJSON(base() + '/api/session/heartbeat', { sessionId: s.sessionId, userId: getConfig().taowa.userId });
      if (r && r.ok) s.snapshot = r;
      else if (r && r.error === 'SESSION_NOT_FOUND') { SESSIONS[mode] = null; stopHeartbeat(mode); }
    } catch (_) {}
  }, 30 * 1000);
  HBS[mode].unref();
}
function stopHeartbeat(mode) { if (HBS[mode]) { clearInterval(HBS[mode]); delete HBS[mode]; } }

async function releaseQuota(mode = 'taowa') {
  stopHeartbeat(mode);
  const s = SESSIONS[mode];
  if (s) {
    try { await postJSON(base() + '/api/session/release', { sessionId: s.sessionId, userId: getConfig().taowa.userId }); } catch (_) {}
    SESSIONS[mode] = null;
  }
}

async function claimContribution(token) {
  const userId = ensureUserId();
  try { return await postJSON(base() + '/api/contributions/claim', { userId, token }); }
  catch (e) { return { ok: false, error: e.message }; }
}

function session(mode = 'taowa') { return SESSIONS[mode] || null; }

module.exports = { getCoordinatorStatus, requestQuota, releaseQuota, claimContribution, session };
