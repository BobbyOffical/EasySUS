'use strict';
/**
 * 服务端下载 —— 支持多种服务端类型，多种下载源可切换
 * 类型: vanilla(官方) / paper / purpur / fabric / forge / spigot
 * 下载源: official(官方) / bmclapi(BMCLAPI 国内镜像) / mcmod / mirror
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { getConfig, saveConfig, builtinCoordinator } = require('./config');

const UA = { 'User-Agent': 'EasySUS/1.0 (+https://github.com/easysus/easysus)' };

const SERVER_TYPES = [
  { id: 'vanilla', name: '原版 Vanilla', desc: 'Mojang 官方服务端，最稳定' },
  { id: 'paper', name: 'Paper', desc: '高性能优化，插件服首选（推荐）' },
  { id: 'purpur', name: 'Purpur', desc: 'Paper 分支，更多可配置项' },
  { id: 'fabric', name: 'Fabric', desc: '轻量模组加载器，适合模组服' },
  { id: 'forge', name: 'Forge', desc: '经典模组加载器，下载的是安装器' },
  { id: 'spigot', name: 'Spigot', desc: '老牌插件服务端（需 BuildTools 编译）' },
];

const DOWNLOAD_SOURCES = [
  { id: 'official', name: '官方源', desc: '直连官方（Mojang/PaperMC/Purpur/Fabric/Forge），全部类型可用', region: 'global' },
  { id: 'bmclapi', name: 'BMCLAPI', desc: '国内镜像：原版 + Forge maven 加速（Paper/Fabric 无镜像，仍走官方）', region: 'cn' },
  { id: 'mcmod', name: '国内镜像', desc: '同 BMCLAPI（原版 + Forge 加速）', region: 'cn' },
  { id: 'mirror', name: '备用源', desc: '海外直连（等同官方源）', region: 'global' },
];

// ---------------- 下载工具 ----------------
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let redirected = 0;
    let settled = false;
    const fail = e => {
      if (settled) return; settled = true;
      try { file.destroy(); } catch (_) {}
      fs.unlink(dest, () => {});
      reject(e);
    };
    function get(target) {
      const u = new URL(target);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.get(target, { headers: UA, timeout: 30000 }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirected < 8) {
          redirected++;
          res.resume();
          return get(new URL(res.headers.location, target).toString());
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`HTTP ${res.statusCode} @ ${target}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let done = 0;
        res.on('data', chunk => {
          done += chunk.length;
          if (onProgress && total) onProgress(done, total);
        });
        res.on('error', fail);
        res.pipe(file);
        file.on('finish', () => { if (!settled) { settled = true; file.close(() => resolve({ size: done })); } });
        file.on('error', fail);
      });
      req.on('error', fail);
      req.on('timeout', () => req.destroy(new Error('download timeout')));
    }
    get(url);
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    let redirected = 0;
    let settled = false;
    const fail = e => { if (!settled) { settled = true; reject(e); } };
    function get(target) {
      const u = new URL(target);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.get(target, { headers: UA, timeout: 20000 }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirected < 8) {
          redirected++;
          res.resume();
          return get(new URL(res.headers.location, target).toString());
        }
        if (res.statusCode !== 200) { res.resume(); return fail(new Error(`HTTP ${res.statusCode} @ ${target}`)); }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => data += c);
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return; settled = true;
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on('error', fail);
      req.on('timeout', () => req.destroy(new Error('fetch timeout')));
    }
    get(url);
  });
}

/**
 * 受限中转：当用户网络直连不到某个下载域名时（国内常见，
 * 例如 purpurmc.org 会被针对性阻断，而 BMCLAPI 又没有 Purpur 镜像），
 * 改由内置联机服务代为下载。服务端带主机白名单 + 限流保护。
 */
function relayURL(target) {
  const coord = builtinCoordinator();
  if (!coord || !/^https?:\/\//.test(String(target))) return null;
  return coord.replace(/\/$/, '') + '/api/relay?url=' + encodeURIComponent(target);
}

/** 取 JSON：直连失败自动走中转 */
async function fetchJSONSmart(url) {
  try {
    return await fetchJSON(url);
  } catch (e) {
    const viaRelay = relayURL(url);
    if (!viaRelay) throw e;
    try { return await fetchJSON(viaRelay); }
    catch (e2) { throw new Error(`直连失败（${e.message}），中转也失败（${e2.message}）`); }
  }
}

/** 下载文件：直连失败自动走中转，并标记是否走了中转 */
async function downloadFileSmart(url, dest, onProgress) {
  try {
    const r = await downloadFile(url, dest, onProgress);
    return Object.assign(r, { relayed: false });
  } catch (e) {
    const viaRelay = relayURL(url);
    if (!viaRelay) throw e;
    await new Promise(r => fs.unlink(dest, () => r()));
    const out = await downloadFile(viaRelay, dest, onProgress);
    return Object.assign(out, { relayed: true, relayFrom: url });
  }
}

// ---------------- 版本清单 ----------------
/** 官方版本清单（原版服务端的通用版本列表） */
async function listVersions() {
  const cfg = getConfig();
  const src = (cfg.downloadSource === 'bmclapi' || cfg.downloadSource === 'mcmod')
    ? 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'
    : 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
  const manifest = await fetchJSONSmart(src);
  const seen = new Set();
  return manifest.versions
    .filter(v => v.type === 'release')
    .filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; })
    .slice(0, 400)
    .map(v => ({ id: v.id, type: v.type, url: v.url, releaseTime: v.releaseTime }));
}

/** 版本号降序比较（1.21.4 > 1.20.6 > 1.20） */
function cmpVersionDesc(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return y - x;
  }
  return 0;
}

/**
 * 按服务端类型列出「真正可用」的版本，避免用户选了不支持的版本后下载失败
 */
async function listVersionsByType(type) {
  switch (type) {
    case 'paper': {
      const r = await fetchJSONSmart('https://fill.papermc.io/v3/projects/paper');
      const out = new Set();
      const walk = v => {
        if (typeof v === 'string') { if (/^\d+\.\d+(\.\d+)?$/.test(v)) out.add(v); }
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(r && (r.versions || r));
      if (out.size === 0) throw new Error('Paper 版本列表获取失败');
      return [...out].sort(cmpVersionDesc).map(id => ({ id, type: 'release' }));
    }
    case 'purpur': {
      const r = await fetchJSONSmart('https://api.purpurmc.org/v2/purpur');
      const list = (r.versions || []).filter(v => /^\d+\.\d+(\.\d+)?$/.test(v));
      if (list.length === 0) throw new Error('Purpur 版本列表获取失败');
      return list.sort(cmpVersionDesc).map(id => ({ id, type: 'release' }));
    }
    case 'fabric': {
      const r = await fetchJSONSmart('https://meta.fabricmc.net/v2/versions/game');
      const list = (Array.isArray(r) ? r : []).filter(v => v.stable && /^\d+\.\d+(\.\d+)?$/.test(v.version));
      return list.map(v => ({ id: v.version, type: 'release' }));
    }
    case 'forge': {
      const r = await fetchJSONSmart('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const ids = new Set();
      for (const k of Object.keys(r.promos || {})) {
        const m = k.match(/^(\d+\.\d+(?:\.\d+)?)-(recommended|latest)$/);
        if (m) ids.add(m[1]);
      }
      return [...ids].sort(cmpVersionDesc).map(id => ({ id, type: 'release' }));
    }
    default:
      return listVersions();
  }
}

/**
 * 解析某个服务端类型 + 版本 + 下载源，返回下载地址与文件名
 *
 * 各类型端点（已实测校准）：
 *  - vanilla  piston-meta.mojang.com  ＋ BMCLAPI 镜像
 *  - paper    fill.papermc.io/v3（旧 v2 已停用，返回 410 Gone，无国内镜像）
 *  - purpur   api.purpurmc.org/v2（国内易被阻断 → 自动走中转）
 *  - fabric   meta.fabricmc.net 需要「游戏版本 + loader 版本 + installer 版本」三段
 *  - forge    maven.minecraftforge.net 路径含完整版本号 {mc}-{forge}，BMCLAPI 有 maven 镜像
 */
async function resolveDownload(type, version) {
  const cfg = getConfig();
  const source = cfg.downloadSource || 'official';
  const mirror = source === 'bmclapi' || source === 'mcmod';

  switch (type) {
    case 'vanilla': {
      const manifest = await fetchJSONSmart(
        mirror
          ? 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'
          : 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
      const entry = manifest.versions.find(v => v.id === version);
      if (!entry) throw new Error(`未找到原版 ${version}`);
      const detail = await fetchJSONSmart(entry.url);
      if (!detail.downloads || !detail.downloads.server) throw new Error(`${version} 无官方服务端（过老版本可能没有）`);
      let url = detail.downloads.server.url;
      if (mirror) url = url.replace('https://piston-data.mojang.com', 'https://bmclapi2.bangbang93.com');
      return { url, filename: `server-${version}.jar`, source, size: detail.downloads.server.size };
    }

    case 'paper': {
      // PaperMC v3 API（v2 已废弃 → 410 Gone）
      const builds = await fetchJSONSmart(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds`);
      if (!Array.isArray(builds) || builds.length === 0) throw new Error(`Paper 没有 ${version} 的构建，换个版本或改用原版`);
      const stable = builds.filter(b => b.channel === 'STABLE');
      const pool = stable.length ? stable : builds;
      const latest = pool.slice().sort((a, b) => (a.id || 0) - (b.id || 0))[pool.length - 1];
      const dl = latest.downloads && (latest.downloads['server:default'] || Object.values(latest.downloads)[0]);
      if (!dl || !dl.url) throw new Error('Paper 下载信息缺失，请稍后重试');
      return { url: dl.url, filename: dl.name || `paper-${version}-${latest.id}.jar`, source, size: dl.size };
    }

    case 'purpur': {
      return { url: `https://api.purpurmc.org/v2/purpur/${version}/latest/download`,
        filename: `purpur-${version}.jar`, source };
    }

    case 'fabric': {
      const metaBase = 'https://meta.fabricmc.net';
      let loaders = [];
      try { loaders = await fetchJSONSmart(`${metaBase}/v2/versions/loader/${version}`); } catch (_) { loaders = []; }
      const list = Array.isArray(loaders) ? loaders : [];
      const pick = list.find(x => x.loader && x.loader.stable) || list[0];
      if (!pick) throw new Error(`Fabric 不支持 ${version}（或该版本暂无 loader）`);
      const loaderVer = pick.loader.version;
      // server jar 端点必须带 installer 版本，否则 404
      let installerVer = '1.1.2';
      try {
        const ins = await fetchJSONSmart(`${metaBase}/v2/versions/installer`);
        const insList = Array.isArray(ins) ? ins : [];
        const stable = insList.find(i => i.stable) || insList[0];
        if (stable && stable.version) installerVer = stable.version;
      } catch (_) {}
      const url = `${metaBase}/v2/versions/loader/${version}/${loaderVer}/${installerVer}/server/jar`;
      return { url, filename: `fabric-server-${version}-loader${loaderVer}.jar`, source, size: 0,
        note: `Fabric Loader ${loaderVer} · Installer ${installerVer}` };
    }

    case 'forge': {
      const promos = await fetchJSONSmart('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const p = promos.promos || {};
      const forgeVer = p[`${version}-recommended`] || p[`${version}-latest`];
      if (!forgeVer) throw new Error(`Forge 没有 ${version} 的版本，换个版本试试`);
      const full = `${version}-${forgeVer}`;
      const mavenBase = mirror ? 'https://bmclapi2.bangbang93.com/maven' : 'https://maven.minecraftforge.net';
      return {
        url: `${mavenBase}/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
        filename: `forge-${full}-installer.jar`, source, isInstaller: true,
        note: `Forge ${forgeVer}（下载的是安装器，需运行一次完成安装）`,
      };
    }

    case 'spigot': {
      throw new Error('Spigot 需通过 BuildTools 自行编译，暂不支持一键下载，建议改用 Paper');
    }

    default:
      throw new Error(`未知服务端类型 ${type}`);
  }
}

/**
 * 执行下载到 serverDir，返回保存路径
 */
async function downloadServer(type, version, onProgress) {
  const cfg = getConfig();
  const resolved = await resolveDownload(type, version);
  const dir = path.join(cfg.serverDir, `${type}-${version}`);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, resolved.filename);
  const r = await downloadFileSmart(resolved.url, dest, onProgress);
  return Object.assign({ dir, file: dest }, resolved, { relayed: r.relayed });
}

function setDownloadSource(sourceId) {
  if (!DOWNLOAD_SOURCES.some(s => s.id === sourceId)) throw new Error('未知下载源');
  return saveConfig({ downloadSource: sourceId });
}

module.exports = { SERVER_TYPES, DOWNLOAD_SOURCES, listVersions, listVersionsByType, resolveDownload, downloadServer,
  setDownloadSource, downloadFile, downloadFileSmart, fetchJSON, fetchJSONSmart, relayURL };