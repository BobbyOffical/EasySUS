'use strict';
/**
 * 模组 / 插件 下载 —— 基于 Modrinth 公开 API（无需 API Key）
 * 文档: https://docs.modrinth.com/api/
 *
 * 功能：搜索模组、按游戏版本+加载器筛选版本、下载安装到实例的 mods/ 或 plugins/ 目录、
 *       查看已安装列表、删除已安装文件。
 */
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');
const { downloadFileSmart, fetchJSONSmart, relayURL } = require('./download');

const API = 'https://api.modrinth.com/v2';
const UA = { 'User-Agent': 'EasySUS/1.0 (Minecraft server helper)' };

// EasySUS 服务端类型 → Modrinth 加载器 / 项目类型
const LOADER_MAP = {
  vanilla: { projectType: 'datapack', loaders: [] },
  paper:   { projectType: 'plugin',   loaders: ['paper', 'spigot', 'bukkit'] },
  purpur:  { projectType: 'plugin',   loaders: ['purpur', 'paper', 'spigot', 'bukkit'] },
  spigot:  { projectType: 'plugin',   loaders: ['spigot', 'bukkit'] },
  fabric:  { projectType: 'mod',      loaders: ['fabric'] },
  forge:   { projectType: 'mod',      loaders: ['forge'] },
  neoforge:{ projectType: 'mod',      loaders: ['neoforge'] },
};

// 可选加载器（用于前端下拉）
const LOADERS = [
  { id: '', name: '全部加载器' },
  { id: 'fabric', name: 'Fabric' },
  { id: 'forge', name: 'Forge' },
  { id: 'neoforge', name: 'NeoForge' },
  { id: 'quilt', name: 'Quilt' },
  { id: 'paper', name: 'Paper' },
  { id: 'purpur', name: 'Purpur' },
  { id: 'spigot', name: 'Spigot' },
  { id: 'bukkit', name: 'Bukkit' },
];

// 可选项目类型
const PROJECT_TYPES = [
  { id: 'mod', name: '模组 Mod' },
  { id: 'plugin', name: '插件 Plugin' },
  { id: 'datapack', name: '数据包 Datapack' },
  { id: 'modpack', name: '整合包 Modpack' },
  { id: 'resourcepack', name: '资源包' },
  { id: 'shader', name: '光影' },
];

function fetchJSONAuth(url) {
  return fetchJSONWithHeaders(url);
}

/** 带 UA 请求 Modrinth；直连失败自动走内置中转（部分网络会阻断 Modrinth CDN） */
async function fetchModrinth(url) {
  try {
    return await fetchJSONWithHeaders(url);
  } catch (e) {
    const viaRelay = relayURL(url);
    if (!viaRelay) throw e;
    try { return await fetchJSONWithHeaders(viaRelay); }
    catch (e2) { throw new Error(`Modrinth 直连失败（${e.message}），中转也失败（${e2.message}）`); }
  }
}

/** 带 User-Agent 的 JSON 请求（Modrinth 要求） */
function fetchJSONWithHeaders(url) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve, reject) => {
    let redirected = 0, settled = false;
    const fail = e => { if (!settled) { settled = true; reject(e); } };
    function get(target) {
      const u = new URL(target);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.get(target, { headers: UA, timeout: 20000 }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirected < 8) {
          redirected++; res.resume();
          return get(new URL(res.headers.location, target).toString());
        }
        if (res.statusCode !== 200) { res.resume(); return fail(new Error(`HTTP ${res.statusCode} @ ${target}`)); }
        let data = ''; res.setEncoding('utf8');
        res.on('data', c => data += c);
        res.on('error', fail);
        res.on('end', () => { if (settled) return; settled = true; try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', fail);
      req.on('timeout', () => req.destroy(new Error('timeout')));
    }
    get(url);
  });
}

/**
 * 搜索模组/插件
 * opts: { query, projectType, loader, gameVersion, index, limit, offset }
 */
async function search(opts = {}) {
  const facets = [];
  if (opts.projectType) facets.push([`project_type:${opts.projectType}`]);
  if (opts.loader) facets.push([`categories:${opts.loader}`]);
  if (opts.gameVersion) facets.push([`versions:${opts.gameVersion}`]);
  // 服务端可用的项目（排除纯客户端）
  facets.push(['server_side:required', 'server_side:optional', 'server_side:unknown']);

  const params = new URLSearchParams();
  params.set('query', opts.query || '');
  params.set('limit', String(Math.min(Number(opts.limit) || 20, 50)));
  params.set('offset', String(Number(opts.offset) || 0));
  params.set('index', opts.index || 'relevance');
  params.set('facets', JSON.stringify(facets));

  const r = await fetchModrinth(`${API}/search?${params.toString()}`);
  return {
    total: r.total_hits,
    hits: (r.hits || []).map(h => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      follows: h.follows,
      iconUrl: h.icon_url,
      categories: h.categories || [],
      versions: (h.versions || []).slice(-8).reverse(),
      projectType: h.project_type,
      license: h.license,
      latestVersion: h.latest_version,
    })),
  };
}

/** 获取某项目可用版本（可按加载器/游戏版本过滤） */
async function versions(projectId, opts = {}) {
  const params = new URLSearchParams();
  if (opts.loader) params.set('loaders', JSON.stringify([opts.loader]));
  if (opts.gameVersion) params.set('game_versions', JSON.stringify([opts.gameVersion]));
  const q = params.toString();
  const list = await fetchModrinth(`${API}/project/${encodeURIComponent(projectId)}/version${q ? '?' + q : ''}`);
  return (Array.isArray(list) ? list : []).map(v => {
    const primary = (v.files || []).find(f => f.primary) || (v.files || [])[0] || {};
    return {
      versionId: v.id,
      name: v.name,
      versionNumber: v.version_number,
      gameVersions: v.game_versions || [],
      loaders: v.loaders || [],
      versionType: v.version_type,
      downloads: v.downloads,
      datePublished: v.date_published,
      file: primary.hashes ? {
        filename: primary.filename,
        url: primary.url,
        size: primary.size,
        sha1: primary.hashes && primary.hashes.sha1,
      } : null,
      dependencies: (v.dependencies || []).filter(d => d.project_id || d.version_id),
    };
  }).filter(v => v.file);
}

// ---------------- 实例目录与已安装文件 ----------------
/** 找到实例目录（serverDir/<instanceId>） */
function instanceDir(instanceId) {
  const cfg = getConfig();
  const dir = path.join(cfg.serverDir, String(instanceId || ''));
  if (!dir.startsWith(cfg.serverDir)) throw new Error('非法的实例名');
  if (!fs.existsSync(dir)) throw new Error(`实例 ${instanceId} 不存在，请先下载服务端`);
  return dir;
}

/** 根据项目类型决定安装子目录 */
function targetSubdir(projectType) {
  switch (projectType) {
    case 'plugin': return 'plugins';
    case 'datapack': return path.join('world', 'datapacks');
    case 'mod':
    default: return 'mods';
  }
}

// 服务端插件加载器（装了应该放 plugins/ 而不是 mods/）
const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia', 'velocity', 'bungeecord', 'waterfall', 'sponge'];
// 数据包加载器
const DATAPACK_LOADERS = ['datapack'];

/**
 * 综合「项目类型 + 版本 loaders」判断应装到哪个目录。
 * 优先用 loaders：Modrinth 上不少插件（如 EssentialsX）的 project_type 会返回 mod，
 * 只靠 project_type 会错装进 mods/ 目录。
 */
function resolveSubdir({ projectType, loaders } = {}) {
  const ls = (loaders || []).map(l => String(l).toLowerCase());
  if (ls.some(l => PLUGIN_LOADERS.includes(l))) return 'plugins';
  if (ls.some(l => DATAPACK_LOADERS.includes(l))) return path.join('world', 'datapacks');
  if (ls.length) return 'mods';
  return targetSubdir(projectType);
}

/**
 * 下载安装一个模组/插件版本到实例目录
 * { instanceId, projectType, file:{filename,url}, versionName }
 */
async function install(opts, onProgress) {
  const { instanceId, projectType = 'mod' } = opts;
  const file = opts.file;
  if (!file || !file.url) throw new Error('缺少下载文件信息');
  const dir = instanceDir(instanceId);
  const sub = resolveSubdir({ projectType, loaders: opts.loaders });
  const destDir = path.join(dir, sub);
  fs.mkdirSync(destDir, { recursive: true });
  // 防目录穿越
  const filename = path.basename(file.filename || 'download.jar');
  const dest = path.join(destDir, filename);
  if (!dest.startsWith(destDir)) throw new Error('非法文件名');
  await downloadFileSmart(file.url, dest, onProgress);
  const size = fs.statSync(dest).size;
  return { file: dest, subdir: sub, filename, size, instanceId, versionName: opts.versionName || '' };
}

/** 列出实例中已安装的模组/插件 */
function listInstalled(instanceId) {
  const dir = instanceDir(instanceId);
  const out = [];
  for (const sub of ['mods', 'plugins', path.join('world', 'datapacks')]) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      // 跳过 fabric/forge 放置的 .disabled 与目录
      const full = path.join(d, f);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      out.push({ subdir: sub, name: f, size: st.size, isDir: st.isDirectory(), mtime: st.mtimeMs, disabled: f.endsWith('.disabled') });
    }
  }
  return out;
}

/** 删除已安装的模组/插件 */
function remove(instanceId, subdir, name) {
  const dir = instanceDir(instanceId);
  const allow = ['mods', 'plugins', path.join('world', 'datapacks')];
  if (!allow.includes(subdir)) throw new Error('不允许的目录');
  const target = path.join(dir, subdir, path.basename(String(name)));
  if (!target.startsWith(path.join(dir, subdir))) throw new Error('非法路径');
  if (!fs.existsSync(target)) throw new Error('文件不存在');
  fs.rmSync(target, { recursive: true, force: true });
  return { removed: target };
}

/** 启用/禁用模组（重命名加/去 .disabled 后缀） */
function toggle(instanceId, subdir, name, enable) {
  const dir = instanceDir(instanceId);
  const allow = ['mods', 'plugins'];
  if (!allow.includes(subdir)) throw new Error('该目录不支持禁用');
  const base = String(name);
  const src = path.join(dir, subdir, base);
  if (!fs.existsSync(src)) throw new Error('文件不存在');
  const dest = enable
    ? (base.endsWith('.disabled') ? path.join(dir, subdir, base.slice(0, -'.disabled'.length)) : null)
    : (base.endsWith('.disabled') ? null : path.join(dir, subdir, base + '.disabled'));
  if (!dest) return { name: base, changed: false };
  fs.renameSync(src, dest);
  return { name: path.basename(dest), changed: true };
}

module.exports = { search, versions, install, listInstalled, remove, toggle, LOADERS, PROJECT_TYPES, LOADER_MAP, instanceDir, targetSubdir, resolveSubdir };