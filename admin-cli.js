#!/usr/bin/env node
/**
 * EasySUS admin-cli —— 腐竹(Bobby)的命令行令牌管理工具
 * 在本地运行，通过公网 API 管理协调中心，把令牌发给提交 issue 的用户。
 *
 * 用法:
 *   node admin-cli.js take [--note "issue #12"]   # 从池中取一个新令牌，返回给你
 *   node admin-cli.js list                        # 查看所有令牌（待认领/已认领）
 *   node admin-cli.js sessions                    # 查看当前活跃会话
 *   node admin-cli.js mark <userId> [--off]       # 直接标记/取消贡献者
 *   node admin-cli.js grant [--token XXX] [--note "..."]  # 手动造一个指定令牌
 *   node admin-cli.js status                      # 查看配额状态
 *
 * 默认联机服务地址: 内置混淆常量（client/secret.js），可用 EASYSUS_COORD_URL 覆盖
 * 管理员令牌: 环境变量 EASYSUS_ADMIN_TOKEN，或同目录 admin-token 文件，
 *             或首次运行时交互输入并保存到本地。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const COORD = process.env.EASYSUS_COORD_URL || require('./client/secret').coordinatorUrl();
const TOKEN_FILE = path.join(__dirname, 'admin-token.local');

function getAdminToken() {
  if (process.env.EASYSUS_ADMIN_TOKEN) return process.env.EASYSUS_ADMIN_TOKEN;
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) {}
  return null;
}
function saveAdminToken(t) {
  try { fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 }); } catch (_) {}
}
function askToken() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('请输入管理员令牌（保存在本地 admin-token.local）: ', a => { rl.close(); resolve(a.trim()); });
  });
}

function request(method, urlPath, body, adminToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(COORD.replace(/\/$/, '') + urlPath);
    const client = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'X-Admin-Token': adminToken };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = client.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, headers, timeout: 15000 }, res => {
      let out = ''; res.setEncoding('utf8');
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: { raw: out } }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

const fmtDate = ms => ms ? new Date(ms).toLocaleString('zh-CN') : '—';

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] || 'help').toLowerCase();
  const flag = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };

  if (cmd === 'help' || args.length === 0) {
    console.log(`EasySUS 管理员命令行工具
协调中心: ${COORD}

命令:
  take [--note "备注"]        从令牌池取一个新捐赠令牌（发给 issue 提交者）
  grant [--token X] [--note]  手动创建指定令牌
  list                        列出全部令牌
  sessions                    列出当前活跃会话
  status                      查看配额状态
  mark <userId> [--off]       直接标记(或取消)贡献者

首次使用需输入管理员令牌（自动保存到 admin-token.local）。`);
    return;
  }

  let token = getAdminToken();
  if (!token) { token = await askToken(); if (token) saveAdminToken(token); }
  if (!token) { console.error('❌ 没有管理员令牌'); process.exit(1); }

  const call = async (m, p, b) => {
    try {
      const r = await request(m, p, b, token);
      if (r.status === 403) { console.error('❌ 管理员令牌无效（403）。检查 admin-token.local 或设置 EASYSUS_ADMIN_TOKEN'); process.exit(1); }
      return r.body;
    } catch (e) { console.error('❌ 无法连接协调中心:', e.message); process.exit(1); }
  };

  switch (cmd) {
    case 'take': {
      const r = await call('POST', '/api/admin/contributions/take', { note: flag('note') || '' });
      if (r.ok) {
        console.log('✅ 新捐赠令牌（发给提交 issue 的用户）:');
        console.log('');
        console.log('   ╔══════════════════════╗');
        console.log(`   ║   ${r.token.padEnd(16)}   ║`);
        console.log('   ╚══════════════════════╝');
        console.log('');
        console.log(`令牌ID: ${r.contribution.id}  备注: ${r.contribution.note || '—'}  剩余池: ${(await call('GET', '/api/admin/overview')).contributions.filter(c => !c.claimedBy && !c.reservedAt).length} 个可用`);
        console.log('提示: 用户在 EasySUS 网页「捐赠令牌」页填入即可成为贡献者。');
      } else console.error('❌', r.error);
      break;
    }
    case 'grant': {
      const r = await call('POST', '/api/admin/contributions/grant', { token: flag('token') || '', note: flag('note') || '' });
      if (r.ok) console.log(`✅ 已创建令牌: ${r.contribution.token} (id ${r.contribution.id})`);
      else console.error('❌', r.error);
      break;
    }
    case 'list': {
      const r = await call('GET', '/api/admin/overview');
      if (!r.ok) { console.error('❌', r.error); break; }
      const cs = r.contributions;
      console.log(`共 ${cs.length} 个令牌 | 待认领 ${cs.filter(c => !c.claimedBy).length} | 已认领 ${cs.filter(c => c.claimedBy).length}`);
      console.log('');
      for (const c of cs.sort((a, b) => b.createdAt - a.createdAt)) {
        const st = c.claimedBy ? `已认领 → ${c.claimedBy}` : (c.reservedAt ? `已取出待发 (${fmtDate(c.reservedAt)})` : '池中可用');
        console.log(`  ${c.token}  [${st}]  note=${c.note || '—'}  created=${fmtDate(c.createdAt)}`);
      }
      break;
    }
    case 'sessions': {
      const r = await call('GET', '/api/admin/overview');
      if (!r.ok) { console.error('❌', r.error); break; }
      const ss = Object.entries(r.sessions);
      console.log(`活跃会话 ${ss.length} 个 | 陶瓦 ${r.taowa.activeUsers}/${r.taowa.limit} | EasyTier ${r.easytier.activeUsers}/${r.easytier.limit}`);
      for (const [id, s] of ss) {
        console.log(`  ${id.slice(0, 8)}..  mode=${s.mode || 'taowa'}  user=${s.userId}  nick=${s.nickname || '—'}  slots=${s.requestedSlots}  ${s.contributed ? '⭐贡献者' : ''}  心跳=${fmtDate(s.lastHeartbeat)}`);
      }
      break;
    }
    case 'status': {
      const r = await call('GET', '/api/status');
      console.log(`🏺 陶瓦联机: ${r.taowa.activeUsers}/${r.taowa.limit} (剩 ${r.taowa.remaining}) 贡献者会话 ${r.taowa.contributorSessions}`);
      console.log(`🕸️ EasyTier: ${r.easytier.activeUsers}/${r.easytier.limit} (剩 ${r.easytier.remaining}) 贡献者会话 ${r.easytier.contributorSessions}`);
      console.log(`⭐ 贡献者总数: ${r.totalContributors} | 待认领令牌: ${r.unclaimedContributions}`);
      break;
    }
    case 'mark': {
      const userId = args[1];
      if (!userId) { console.error('用法: mark <userId> [--off]'); break; }
      const r = await call('POST', '/api/admin/users/mark-contributor', { userId, contributed: !args.includes('--off') });
      if (r.ok) console.log(`✅ ${userId} 贡献者状态 = ${r.user.contributed}`);
      else console.error('❌', r.error);
      break;
    }
    default:
      console.error('未知命令:', cmd, '（用 help 查看用法）');
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
