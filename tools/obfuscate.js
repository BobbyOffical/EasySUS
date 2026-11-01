#!/usr/bin/env node
'use strict';
/**
 * EasySUS 发布前混淆工具
 *
 * 作用：把协调中心地址以 AES-256-GCM 加密写入 client/secret.js，
 * 并可选择轮换 client/netkeys.js 里的密钥碎片。
 * 仓库中永远不会有明文地址。
 *
 * 用法：
 *   node tools/obfuscate.js --rotate "https://your-coord.example/coord"
 *   node tools/obfuscate.js --rotate "..." --new-keys          # 同时轮换密钥碎片
 *   node tools/obfuscate.js --verify                            # 验证当前密文可解密
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SECRET = path.join(ROOT, 'client', 'secret.js');
const KEYS = path.join(ROOT, 'client', 'netkeys.js');

function deriveKey(k1, k2, k3) {
  return crypto.createHash('sha256').update(k1 + ':' + k2 + ':' + k3).digest();
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function readKeys() {
  const s = fs.readFileSync(KEYS, 'utf8');
  const g = n => (s.match(new RegExp(n + " = '([^']+)'")) || [])[1];
  return { K1: g('K1'), K2: g('K2'), K3: g('K3') };
}

function genKeys() {
  return {
    K1: 'easysus-' + crypto.randomBytes(6).toString('hex'),
    K2: crypto.randomBytes(10).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 20).toLowerCase(),
    K3: crypto.randomBytes(8).toString('hex'),
  };
}

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const val = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };

if (flag('rotate')) {
  const url = val('rotate');
  if (!/^https?:\/\//.test(url || '')) { console.error('❌ --rotate 需要一个 http(s) 地址'); process.exit(1); }
  let k = readKeys();
  if (flag('new-keys')) {
    k = genKeys();
    fs.writeFileSync(KEYS,
      `'use strict';\n/**\n * 密钥碎片（与 secret.js 的密文分离存放）\n * 由 tools/obfuscate.js --rotate --new-keys 生成于 ${new Date().toISOString()}\n */\nconst K1 = '${k.K1}';\nconst K2 = '${k.K2}';\nconst K3 = '${k.K3}';\nmodule.exports = { K1, K2, K3 };\n`);
    console.log('✅ 已轮换 netkeys.js 密钥碎片');
  }
  const cipher = 'g1:' + encrypt(url, deriveKey(k.K1, k.K2, k.K3));
  let s = fs.readFileSync(SECRET, 'utf8');
  s = s.replace(/const CIPHER = '[^']*';/, `const CIPHER = '${cipher}';`);
  fs.writeFileSync(SECRET, s);
  console.log('✅ 已加密写入 client/secret.js');
  // 自校验
  delete require.cache[SECRET]; delete require.cache[KEYS];
  const back = require(SECRET).coordinatorUrl();
  if (back === url) console.log('✅ 解密自校验通过');
  else { console.error('❌ 自校验失败！'); process.exit(1); }
} else if (flag('verify')) {
  delete require.cache[SECRET];
  const u = require(SECRET).coordinatorUrl();
  console.log(u ? `✅ 密文可解密（地址已隐藏，长度 ${u.length}）` : '❌ 解密失败：CIPHER 未生成或密钥碎片不匹配');
  process.exitCode = u ? 0 : 1;
} else {
  console.log('用法:\n  node tools/obfuscate.js --rotate "<地址>" [--new-keys]\n  node tools/obfuscate.js --verify');
}