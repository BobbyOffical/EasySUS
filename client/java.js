'use strict';
/**
 * Java 检测与自动获取 —— 适配 Windows / Linux / macOS
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { getConfig } = require('./config');

function run(cmd, args, timeout = 8000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

/** 从 `java -version` 输出解析主版本号 */
function parseVersion(text) {
  const m = text.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  if (major === 1 && m[2]) return Number(m[2]); // 1.8 -> 8
  return major;
}

/** 探测系统上可用的 java，返回 {path, version} 列表 */
async function detectSystemJava() {
  const results = [];
  const candidates = [];

  // PATH 中的 java
  candidates.push('java');

  // 常见安装位置
  const plat = process.platform;
  if (plat === 'win32') {
    const roots = [process.env.JAVA_HOME, 'C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu', 'C:\\Program Files (x86)\\Java'];
    for (const r of roots) {
      if (!r) continue;
      if (fs.existsSync(r) && fs.statSync(r).isDirectory()) {
        for (const sub of safeReaddir(r)) {
          candidates.push(path.join(r, sub, 'bin', 'java.exe'));
        }
      } else if (r.endsWith('java.exe')) candidates.push(r);
    }
    if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  } else if (plat === 'darwin') {
    const base = '/Library/Java/JavaVirtualMachines';
    if (fs.existsSync(base)) {
      for (const sub of safeReaddir(base)) {
        candidates.push(path.join(base, sub, 'Contents', 'Home', 'bin', 'java'));
      }
    }
    candidates.push('/opt/homebrew/opt/openjdk/bin/java', '/usr/local/opt/openjdk/bin/java');
  } else { // linux
    const base = '/usr/lib/jvm';
    if (fs.existsSync(base)) {
      for (const sub of safeReaddir(base)) {
        candidates.push(path.join(base, sub, 'bin', 'java'));
      }
    }
  }

  for (const c of candidates) {
    if (!c) continue;
    // PATH 里的直接尝试，绝对路径要存在
    if (c !== 'java' && !fs.existsSync(c)) continue;
    const r = await run(c, ['-version']);
    const text = (r.stdout + ' ' + r.stderr);
    const v = parseVersion(text);
    if (v) results.push({ path: c, version: v, raw: text.split('\n')[0] });
  }

  // 去重并按版本降序
  const seen = new Set();
  return results.filter(x => {
    const key = x.path + '@' + x.version;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => b.version - a.version);
}

function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch (_) { return []; }
}

/** 检查 EasySUS 自己下载的 java */
function downloadedJava() {
  const cfg = getConfig();
  const dir = cfg.javaDir;
  if (!fs.existsSync(dir)) return null;
  for (const sub of safeReaddir(dir)) {
    const exe = javaExecutable(path.join(dir, sub));
    if (exe && fs.existsSync(exe)) return exe;
  }
  return null;
}

function javaExecutable(javaHome) {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const p = path.join(javaHome, 'bin', exe);
  return fs.existsSync(p) ? p : null;
}

/** 根据服务端版本推荐所需 Java 主版本 */
function requiredJavaFor(mcVersion) {
  // mcVersion 形如 "1.20.4"
  const m = String(mcVersion || '').match(/^1\.(\d+)/);
  if (!m) return 21;
  const minor = Number(m[1]);
  if (minor >= 20 && Number(String(mcVersion).split('.')[2] || 0) >= 5) return 21; // 1.20.5+
  if (minor >= 18) return 21;   // 1.18+ 建议 17，1.20.5+ 需要 21；这里宽松给 21
  if (minor >= 17) return 17;
  return 8;
}

/** 综合：返回当前最佳可用 java */
async function resolveJava(preferVersion) {
  const list = await detectSystemJava();
  if (list.length === 0) {
    const dl = downloadedJava();
    if (dl) return { path: dl, version: null, downloaded: true };
    return null;
  }
  if (preferVersion) {
    const exact = list.find(j => j.version === preferVersion);
    if (exact) return exact;
    const higher = list.find(j => j.version >= preferVersion);
    if (higher) return higher;
  }
  return list[0];
}

// ---------------- Java 一键下载（Adoptium Temurin） ----------------
const https = require('https');

/**
 * 下载指定主版本的 Temurin JRE/JDK 并解压到 javaDir。
 * major: 8 | 17 | 21；imageType: 'jdk'（默认，Forge 安装器需要）
 * 下载源可切换：adoptium(官方) / tsinghua(清华镜像，国内推荐)
 */
async function downloadJava(major, onProgress, sourceHint) {
  const cfg = getConfig();
  const plat = process.platform;               // win32 | linux | darwin
  const arch = process.arch === 'x64' ? 'x64' : (process.arch === 'arm64' ? 'aarch64' : 'x64');
  const osName = plat === 'win32' ? 'windows' : (plat === 'darwin' ? 'mac' : 'linux');
  const ext = plat === 'win32' ? 'zip' : 'tar.gz';

  let url;
  const useMirror = sourceHint === 'mirror' || cfg.downloadSource === 'bmclapi' || cfg.downloadSource === 'mcmod';
  if (useMirror && major !== 8) {
    // 清华 Adoptium 镜像
    url = `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/jdk/${arch}/${osName}/`;
    // 镜像目录需要列目录，改为使用 API 获取文件名再拼镜像地址
  }

  // 统一走 Adoptium API（支持重定向到镜像）
  const api = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${arch}/jdk/hotspot/normal/eclipse`;
  url = api;

  const destDir = path.join(cfg.javaDir, `temurin-${major}-${arch}`);
  fs.mkdirSync(destDir, { recursive: true });
  const archive = path.join(cfg.javaDir, `temurin-${major}.${ext}`);

  await downloadFileGeneric(url, archive, onProgress);

  // 解压
  if (ext === 'zip') {
    await run('tar', ['-xf', archive, '-C', destDir]);   // Win10+ 自带 tar 支持 zip
  } else {
    await run('tar', ['-xzf', archive, '-C', destDir]);
  }
  try { fs.unlinkSync(archive); } catch (_) {}

  // 找到解压出的 home 目录
  const subs = safeReaddir(destDir);
  const home = subs.length ? path.join(destDir, subs[0]) : destDir;
  const exe = javaExecutable(home);
  if (!exe) throw new Error('Java 解压后未找到可执行文件');
  return { path: exe, home, version: major };
}

function downloadFileGeneric(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let redirected = 0;
    function get(target) {
      https.get(target, { headers: { 'User-Agent': 'EasySUS/1.0' } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirected < 8) {
          redirected++;
          res.resume();
          const next = new URL(res.headers.location, target);
          return (next.protocol === 'http:' ? require('http') : https).get(next.toString(), handleFinal);
        }
        handleFinal(res);
      }).on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    }
    function handleFinal(res) {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirected < 8) {
        redirected++;
        res.resume();
        const next = new URL(res.headers.location);
        return (next.protocol === 'http:' ? require('http') : https).get(next.toString(), handleFinal).on('error', reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const total = Number(res.headers['content-length']) || 0;
      let done = 0;
      res.on('data', chunk => { done += chunk.length; if (onProgress && total) onProgress(done, total); });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve({ size: done })));
      file.on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    }
    get(url);
  });
}

module.exports = { detectSystemJava, downloadedJava, javaExecutable, requiredJavaFor, resolveJava, run, downloadJava };
