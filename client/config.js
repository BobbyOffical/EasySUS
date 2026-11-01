'use strict';
/**
 * EasySUS Client —— 通用配置与路径
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const secret = require('./secret');

const ROOT = __dirname;                     // .../client
const DATA_DIR = process.env.EASYSUS_DATA_DIR || path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 协调中心地址：内置 AES 加密常量，不落盘、不外露、不可改
// 运行时函数获取（轮换密钥/密文无需重启进程外的适配）
const builtinCoordinator = () => secret.coordinatorUrl();

const DEFAULTS = {
  webPort: Number(process.env.EASYSUS_PORT) || 19388,
  webHost: '127.0.0.1',
  // Minecraft 服务端存放目录
  dataDir: DATA_DIR,
  serverDir: path.join(DATA_DIR, 'servers'),
  javaDir: path.join(DATA_DIR, 'java'),
  downloadDir: path.join(DATA_DIR, 'downloads'),
  // 下载源优先级（可在网页切换）
  downloadSource: 'official',   // official | bmclapi | mcmod | mirror
  // UI 主题（可在网页调整颜色）
  theme: {
    preset: 'default',            // default | grass | ocean | sunset | purple | custom
    custom: null,                 // {bg,panel,panel2,border,text,muted,accent,green,red,yellow}
  },
  // 联机（玩家如何连入 MC 服务器）
  netMode: 'direct',            // direct（自有公网IP） | taowa（陶瓦联机）
  directPort: 25565,
  taowa: {
    coordinatorUrl: '',   // 运行时由内置加密常量注入，不可修改
    userId: '',
    nickname: os.userInfo().username || 'admin',
    requestedSlots: 7,          // 请求人数+1，默认 6 人 + 腐竹自己
    publicNodes: [],            // 附加 EasyTier 公共节点
  },
  // EasyTier 远程访问控制面板（与玩家联机无关，最多 8 台设备）
  easytier: {
    version: '',                // 留空自动取最新版
    netName: '',                // 首次启动自动生成
    netSecret: '',
    virtualIp: '10.144.144.1',
    port: 25565,
    requestedSlots: 9,          // 最多 8 个远程访问者 + 腐竹自己
  },
};

function ensureDirs(cfg) {
  for (const d of [DATA_DIR, cfg.serverDir, cfg.javaDir, cfg.downloadDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

let CONFIG = null;
function loadConfig() {
  ensureDirs(DEFAULTS);
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
  CONFIG = deepMerge(structuredClone(DEFAULTS), file);
  // 协调中心：永远强制使用内置加密地址（配置文件里写了也无效，防止被指向第三方）
  CONFIG.taowa.coordinatorUrl = builtinCoordinator();
  // 迁移：easytier 已不再是联机模式（改为远程访问面板），回退到 direct
  if (CONFIG.netMode === 'easytier' || !['direct', 'taowa'].includes(CONFIG.netMode)) {
    CONFIG.netMode = 'direct';
  }
  ensureDirs(CONFIG);
  return CONFIG;
}
function saveConfig(patch) {
  if (patch) CONFIG = deepMerge(CONFIG, patch);
  CONFIG.taowa.coordinatorUrl = builtinCoordinator();   // 任何写入都还原为内置地址
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 落盘时剔除协调中心地址，避免暴露
  const onDisk = JSON.parse(JSON.stringify(CONFIG));
  if (onDisk.taowa) delete onDisk.taowa.coordinatorUrl;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2));
  return CONFIG;
}
function getConfig() { return CONFIG || loadConfig(); }

/** 供 API 层使用的脱敏配置（不含协调中心地址） */
function publicNetworkConfig() {
  const cfg = getConfig();
  return {
    netMode: cfg.netMode,
    directPort: cfg.directPort,
    taowa: {
      userId: cfg.taowa.userId,
      nickname: cfg.taowa.nickname,
      requestedSlots: cfg.taowa.requestedSlots,
      publicNodes: cfg.taowa.publicNodes,
    },
    easytier: cfg.easytier,
  };
}

function deepMerge(base, over) {
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      base[k] = deepMerge(base[k] || {}, v);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}

module.exports = { ROOT, DATA_DIR, CONFIG_FILE, DEFAULTS, loadConfig, saveConfig, getConfig, deepMerge, publicNetworkConfig, builtinCoordinator };
