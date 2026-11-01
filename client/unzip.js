'use strict';
/**
 * 极简 ZIP 解压（纯 Node，零依赖）—— 自动更新用
 * 支持 stored 与 deflate 两种压缩方式，足够解析 GitHub 仓库 zip。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function readZip(zipPath, destDir, onEntry) {
  const buf = fs.readFileSync(zipPath);
  // 找 End of Central Directory（签名 0x06054b50），从尾部最多 64KB 内搜索
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  let done = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) { done++; continue; }
    // 读本地文件头，算数据起点
    const l = e.localOff;
    if (buf.readUInt32LE(l) !== 0x04034b50) throw new Error('zip 本地头损坏: ' + e.name);
    const lNameLen = buf.readUInt16LE(l + 26);
    const lExtraLen = buf.readUInt16LE(l + 28);
    const dataStart = l + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + e.compSize);

    let data;
    if (e.method === 0) data = Buffer.from(raw);
    else if (e.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('不支持的压缩方式 ' + e.method + ': ' + e.name);

    // 防目录穿越
    const outPath = path.resolve(destDir, e.name);
    if (!outPath.startsWith(path.resolve(destDir) + path.sep)) continue;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
    done++;
    if (onEntry) onEntry(e.name, done, entries.length);
  }
  return entries.length;
}

module.exports = { readZip };