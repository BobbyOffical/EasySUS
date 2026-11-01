#!/usr/bin/env node
'use strict';
/**
 * apply-update.js —— 分离进程（由 updater.apply() 拉起，不随主进程退出而死）
 *
 * 职责：
 *   1. 等待主 EasySUS 进程退出（轮询进程表 / 超时强继续）
 *   2. 把 staging 中的代码文件覆盖到项目根（跳过受保护路径）
 *   3. 备份被覆盖的旧文件到 data/update-backup/（可回滚）
 *   4. 重启主进程（跨平台）
 * 全程写日志到 data/update-apply.log，方便排查。
 *
 * 用法: node apply-update.js <ROOT> <STAGING> [--no-restart]
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(process.argv[2] || '.');
const STAGING = path.resolve(process.argv[3] || path.join(ROOT, 'client', 'data', 'update-staging'));
const PORT = Number(process.argv[4] && /^\d+$/.test(process.argv[4]) ? process.argv[4] : 19388);
const NO_RESTART = process.argv.includes('--no-restart');
const LOG = path.join(ROOT, 'client', 'data', 'update-apply.log');
const BACKUP = path.join(ROOT, 'client', 'data', 'update-backup');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}

const PROTECTED_DIRS = ['client/data', '.git', 'client/data/update-staging', 'client/data/update-backup'];
const SKIP_FILES = ['admin-token.local'];   // 受保护文件（相对根）

function isProtected(rel) {
  const r = rel.split(path.sep).join('/').toLowerCase();
  return PROTECTED_DIRS.some(p => r === p || r.startsWith(p + '/')) || SKIP_FILES.includes(r);
}

// ---- 1. 等待主进程退出：探测 19388 端口空闲（跨平台，最可靠）----
function portBusy(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp`, { timeout: 5000 }).toString();
      return new RegExp(`:(${port})\\s+.*LISTENING`, 'i').test(out);
    }
    const out = execSync('ss -tln 2>/dev/null || netstat -tln', { timeout: 5000, shell: true }).toString();
    return new RegExp(`[:.]${port}\\s`, 'i').test(out);
  } catch (_) { return true; }   // 探测失败当作仍占用，继续等
}

function waitExit(maxMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (!portBusy(PORT)) return true;
    const t1 = Date.now(); while (Date.now() - t1 < 800) {}   // sleep 0.8s
  }
  return false;
}

// ---- 2/3. 复制 + 备份 ----
function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(rel);
  }
  return out;
}

function applyFiles() {
  if (!fs.existsSync(path.join(STAGING, 'VERSION'))) throw new Error('staging 无 VERSION，中止');
  const files = walk(STAGING, STAGING, []);
  fs.rmSync(BACKUP, { recursive: true, force: true });
  let copied = 0, skipped = 0;
  for (const rel of files) {
    if (isProtected(rel)) { skipped++; continue; }
    const src = path.join(STAGING, rel);
    const dst = path.join(ROOT, rel);
    const dstRel = path.relative(ROOT, dst);
    if (!dstRel || dstRel.startsWith('..')) { skipped++; continue; }   // 防穿越
    // 备份旧文件
    if (fs.existsSync(dst)) {
      const bak = path.join(BACKUP, rel);
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.copyFileSync(dst, bak);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;
  }
  return { copied, skipped, total: files.length };
}

// ---- 4. 重启 ----
function restart() {
  const entry = path.join(ROOT, 'client', 'server.js');
  // 直接 detached 启动 node（跨平台一致）。
  // 不要用 `cmd /c start 标题 程序`：start 只有在标题带引号时才当标题，
  // 否则会把 "EasySUS" 当成程序名，静默失败。
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: false,
  });
  child.unref();
  log('restart issued pid=' + child.pid);
}

// ---- main ----
(async () => {
  try {
    log(`apply-update start root=${ROOT} staging=${STAGING}`);
    const exited = waitExit();
    log(exited ? 'main process gone (port free)' : 'WARN: port still busy after 20s, continue anyway');
    await new Promise(r => setTimeout(r, 1200));   // 留时间释放文件句柄
    const stats = applyFiles();
    log(`files copied=${stats.copied} skipped=${stats.skipped} total=${stats.total}`);
    fs.rmSync(STAGING, { recursive: true, force: true });
    if (!NO_RESTART) restart();
    log('done');
  } catch (e) {
    log('FATAL: ' + (e && e.stack || e));
    process.exit(1);
  }
})();