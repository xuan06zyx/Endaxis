#!/usr/bin/env node
/**
 * 从项目自带的 logo 生成桌面壳图标。
 *
 * 不引入 ico 打包依赖：ICO 只是"目录 + 内嵌 PNG"的容器，自己写更可控，
 * 也能保证每个尺寸都是独立重采样的 PNG 而不是把大图缩糊。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(here, '..');

/**
 * 上游 logo 的位置随目录布局变化，这里把两种都覆盖：
 *   - 嵌套布局（本仓库内）：desktop-shell/ 与 public/ 同级 → ../public/
 *   - 同级布局（本地开发）：desktop-shell/ 与 Endaxis/ 同级 → ../Endaxis/public/
 * 漏掉嵌套布局会让 CI 上第一步就失败（实测：工作流 40 秒挂在找 logo）。
 */
const sourceCandidates = [
  path.join(shellRoot, '..', 'public', 'logo-white.webp'),
  path.join(shellRoot, '..', 'public', 'logo.webp'),
  path.join(shellRoot, '..', 'Endaxis', 'public', 'logo-white.webp'),
  path.join(shellRoot, '..', 'Endaxis', 'public', 'logo.webp'),
];
const buildDirectory = path.join(shellRoot, 'build');

/** Windows 资源管理器会按需挑选合适尺寸，这些是实际会用到的档位。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const sourcePath = sourceCandidates.find(candidate => fs.existsSync(candidate));
if (sourcePath === undefined) {
  console.error(`[icon] 找不到图标来源，已尝试：\n  ${sourceCandidates.join('\n  ')}`);
  process.exit(1);
}

fs.mkdirSync(buildDirectory, { recursive: true });

/** 去掉四周透明留白，否则 logo 在任务栏里会显得很小。 */
async function loadTrimmedLogo() {
  const image = sharp(sourcePath, { failOn: 'none' }).ensureAlpha();
  try {
    return await image.trim({ threshold: 1 }).png().toBuffer();
  } catch {
    // 没有可裁剪边界（例如整图不透明）时回退到原图。
    return await sharp(sourcePath, { failOn: 'none' }).ensureAlpha().png().toBuffer();
  }
}

function renderPng(logoBuffer, size) {
  return sharp(logoBuffer)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** 按 ICO 规范拼装：ICONDIR + ICONDIRENTRY[] + PNG 数据区。 */
function packIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  const directory = Buffer.alloc(headerSize + entrySize * images.length);

  directory.writeUInt16LE(0, 0); // 保留位
  directory.writeUInt16LE(1, 2); // 类型：1 = 图标
  directory.writeUInt16LE(images.length, 4);

  let offset = directory.length;
  images.forEach((image, index) => {
    const entry = headerSize + entrySize * index;
    // 256 在 ICO 里用 0 表示。
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 0);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // 调色板数量（真彩为 0）
    directory.writeUInt8(0, entry + 3); // 保留位
    directory.writeUInt16LE(1, entry + 4); // 色彩平面
    directory.writeUInt16LE(32, entry + 6); // 位深
    directory.writeUInt16LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([directory, ...images.map(image => image.data)]);
}

const logo = await loadTrimmedLogo();

const images = [];
for (const size of ICO_SIZES) {
  images.push({ size, data: await renderPng(logo, size) });
}

const icoPath = path.join(buildDirectory, 'icon.ico');
fs.writeFileSync(icoPath, packIco(images));

// 开发运行时（非打包）用 PNG 更省事，同时留给 Linux/macOS 使用。
const pngPath = path.join(buildDirectory, 'icon.png');
fs.writeFileSync(pngPath, await renderPng(logo, 512));

const meta = await sharp(logo).metadata();
console.log(
  `[icon] 来源 ${path.relative(shellRoot, sourcePath)} (${meta.width}x${meta.height}) → ` +
    `build/icon.ico (${ICO_SIZES.join(', ')}) + build/icon.png (512)`,
);
