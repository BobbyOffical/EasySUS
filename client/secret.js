'use strict';
/**
 * 内置敏感常量 —— 协调中心（联机服务）地址
 *
 * 存储方式：AES-256-GCM 密文，密钥由 netkeys.js 的三段碎片派生
 * （SHA-256(K1:K2:K3)），密文与密钥分居两个文件。
 *
 * 保护目标：
 *   - 地址在仓库任何文件中都不以明文出现（grep / 搜索无果）；
 *   - 不写入用户机器的 config.json；API 不返回；UI 不显示且不可修改。
 *
 * 诚实说明：客户端代码最终必须能解密出地址，因此这属于「混淆防护」——
 * 挡住搜索、扒取与批量滥用，防不住愿意完整调试本程序的人。
 * 真正的访问控制在服务端（白名单、限流、鉴权）。
 *
 * 轮换/首次发布: node tools/obfuscate.js --rotate "<协调中心地址>"
 */
const crypto = require('crypto');

// AES-256-GCM 密文（base64 of iv|tag|ciphertext），由 tools/obfuscate.js 生成
const CIPHER = 'g1:iz105PHaQb94yl3Fo35vKznpqrmzh/AysNeyl8UaM6uYq7f6MSkY/5F0ao7o+Je8UzAtqOS5bA==';

function deriveKey() {
  // 碎片延迟 require：静态扫描时密钥与密文不在同一文件
  const { K1, K2, K3 } = require('./netkeys');
  return crypto.createHash('sha256').update(K1 + ':' + K2 + ':' + K3).digest();
}

/** 解码得到内置协调中心地址（仅供内部使用，切勿暴露给前端） */
function coordinatorUrl() {
  if (!CIPHER.startsWith('g1:')) return '';   // 未加密发布时宁可不联网
  try {
    const raw = Buffer.from(CIPHER.slice(3), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (_) {
    return '';  // 密文与密钥碎片不匹配（被篡改/轮换失误）：返回空，各调用方自行降级
  }
}

module.exports = { coordinatorUrl, get COORDINATOR_URL() { return coordinatorUrl(); } };