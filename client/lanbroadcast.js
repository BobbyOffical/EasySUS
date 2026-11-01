'use strict';
/**
 * Minecraft 局域网广播（LAN Discovery）发送器
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * 陶瓦联机(Terracotta) 开房时，其「扫描 MC 端口」并不是真的扫描端口，
 * 而是监听 Minecraft 客户端的局域网广播组播组：
 *      224.0.2.60:4445  (IPv4) / FF75:230::60:4445 (IPv6)
 * 并解析数据包中的 [MOTD]...[/MOTD][AD]端口[/AD]。
 * （源码：src/mc/scanning.rs，过滤条件 MOTD != Terracotta 自己的标语）
 *
 * 单人存档「对局域网开放」时会自动发这个包，所以用启动器联机没问题；
 * 但**专用服务端（server.jar）永远不会发局域网广播** —— 于是陶瓦开房时
 * 就会一直卡在「正在扫描本机 Minecraft 端口」。
 *
 * 本模块代替专用服务端周期性地发出同样格式的广播包（每 1.5 秒，
 * 与 Terracotta 自带的 FakeServer 完全一致，扫描器保留期为 5 秒），
 * 让陶瓦能立刻发现并锁定我们的服务器端口。
 * ────────────────────────────────────────────────────────────
 */
const dgram = require('dgram');
const os = require('os');

const ADDR_V4 = { host: '224.0.2.60', port: 4445 };
const ADDR_V6 = { host: 'ff75:230::60', port: 4445 };
const INTERVAL_MS = 1500;
// 必须与 Terracotta 内置标语不同，否则会被它的扫描器过滤掉
const DEFAULT_MOTD = '§bEasySUS 服务器（局域网广播）';

let TIMER = null;
let SOCKETS = [];
let STATE = { running: false, port: null, motd: null, sent: 0, lastSendAt: null, errors: [], ifaces: [] };

/** 枚举本机可用于组播发送的 IPv4 地址（参照 Terracotta 对每个本地地址建 socket 的做法） */
function localV4Addresses() {
  const out = ['0.0.0.0'];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) {
        out.push(info.address);
        STATE.ifaces.push(`${name}:${info.address}`);
      }
    }
  }
  return [...new Set(out)];
}

function makePacket(port, motd) {
  return Buffer.from(`[MOTD]${motd}[/MOTD][AD]${port}[/AD]`, 'utf8');
}

/**
 * 开始广播
 * @param {number} port  Minecraft 服务端端口（server.properties 的 server-port）
 * @param {string} [motd] 自定义标语（不要用陶瓦默认标语）
 */
function start(port, motd) {
  if (TIMER) return { ok: true, already: true, ...getStatus() };
  const p = Number(port) || 25565;
  const text = motd || DEFAULT_MOTD;
  const packet = makePacket(p, text);
  STATE = { running: false, port: p, motd: text, sent: 0, lastSendAt: null, errors: [], ifaces: [] };
  SOCKETS = [];

  for (const addr of localV4Addresses()) {
    try {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', e => { STATE.errors.push(`${addr}: ${e.message}`); if (STATE.errors.length > 20) STATE.errors.shift(); });
      sock.bind(0, addr, () => {
        try {
          sock.setBroadcast(true);
          sock.setMulticastTTL(4);
          sock.setMulticastLoopback(true);   // 关键：让本机的陶瓦扫描器能收到
        } catch (e) { STATE.errors.push(`${addr} 设置失败: ${e.message}`); }
      });
      SOCKETS.push({ sock, addr, family: 4 });
    } catch (e) { STATE.errors.push(`${addr}: ${e.message}`); }
  }
  // IPv6 组播（尽力而为）
  for (const info of Object.values(os.networkInterfaces()).flat()) {
    if (info && info.family === 'IPv6' && !info.internal) {
      try {
        const sock = dgram.createSocket({ type: 'udp6', reuseAddr: true });
        sock.on('error', () => {});
        sock.bind(0, info.address, () => { try { sock.setMulticastLoopback(true); sock.setMulticastTTL(4); } catch (_) {} });
        SOCKETS.push({ sock, addr: info.address, family: 6 });
      } catch (_) {}
      break;
    }
  }

  const send = () => {
    let okCount = 0;
    for (const { sock, family } of SOCKETS) {
      const target = family === 6 ? ADDR_V6 : ADDR_V4;
      try {
        sock.send(packet, target.port, target.host, err => {
          if (err) STATE.errors.push(`${target.host}: ${err.message}`);
        });
        okCount++;
      } catch (e) { STATE.errors.push(e.message); }
    }
    STATE.sent++;
    STATE.lastSendAt = Date.now();
    if (okCount) STATE.running = true;
  };

  send();
  TIMER = setInterval(send, INTERVAL_MS);
  TIMER.unref();
  return { ok: true, ...getStatus() };
}

function stop() {
  if (TIMER) { clearInterval(TIMER); TIMER = null; }
  for (const { sock } of SOCKETS) { try { sock.close(); } catch (_) {} }
  SOCKETS = [];
  STATE.running = false;
  return { ok: true, ...getStatus() };
}

function getStatus() {
  return {
    running: STATE.running,
    port: STATE.port,
    motd: STATE.motd,
    sent: STATE.sent,
    lastSendAt: STATE.lastSendAt,
    ifaces: STATE.ifaces,
    errors: STATE.errors.slice(-5),
  };
}

module.exports = { start, stop, getStatus, DEFAULT_MOTD, ADDR_V4, ADDR_V6, INTERVAL_MS };