'use strict';

/**
 * 更新源测速。
 *
 * 只测**下载路径**：用户真正关心的是"从哪个源下 117 MB 更快"。所以用发布资产
 * 做 Range 请求取固定大小的样本，测两件事：
 *   - 首字节延迟（TTFB）：反映连通性与握手开销；
 *   - 采样吞吐：反映实际下载速度。
 *
 * 为什么不只测延迟：反代站常见"握手快但限速"，只看延迟会选错。
 *
 * 为什么必须支持 Range：完整包 117 MB，测速不可能整包下载。若某镜像不支持
 * Range，就退化为"只测首字节 + 一小段后主动断开"，仍然能给出可用结论。
 */

const { applyMirror } = require('./mirrors');

/** 采样目标大小：太小受抖动影响，太大浪费用户流量。 */
const SAMPLE_BYTES = 512 * 1024;
/**
 * 单个镜像的测速上限。
 *
 * 实测 ghfast.top 在部分网络下握手要 1.2 秒、偶尔 10 秒连不上、第三次才成功
 * （6.5 秒）。超时给太紧会把"慢但能用"直接判死，用户就看不到它可用了。
 * 15 秒是折中：慢站能出结果，也不会让整体等待失控（各站是并发的）。
 */
const MIRROR_TIMEOUT_MS = 15_000;

/**
 * 测一个镜像。
 *
 * @param {object} mirror
 * @param {string} assetUrl 形如 https://github.com/owner/repo/releases/download/v1.0.6/xxx.exe
 * @returns {Promise<{id: string, ok: boolean, ttfbMs: number|null, speedBps: number|null,
 *   sampleBytes: number, error: string|null}>}
 */
async function testMirror(mirror, assetUrl) {
  const url = applyMirror(assetUrl, mirror);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MIRROR_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${SAMPLE_BYTES - 1}` },
      signal: controller.signal,
    });

    const ttfbMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        id: mirror.id,
        ok: false,
        ttfbMs: null,
        speedBps: null,
        sampleBytes: 0,
        error: `HTTP ${response.status}`,
      };
    }

    // 服务器可能忽略 Range 而返回整包（200）——那就读一小段后主动断开，
    // 不能因为不支持 Range 就把它判为不可用。
    let received = 0;
    const reader = response.body?.getReader();
    if (reader === undefined) {
      return { id: mirror.id, ok: true, ttfbMs, speedBps: null, sampleBytes: 0, error: null };
    }
    const readStartedAt = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.byteLength ?? 0;
      if (received >= SAMPLE_BYTES) break;
    }
    // 主动取消，避免继续下载整包。
    await reader.cancel().catch(() => {});
    const elapsedMs = Math.max(1, Date.now() - readStartedAt);

    return {
      id: mirror.id,
      ok: true,
      ttfbMs,
      speedBps: received > 0 ? Math.round((received / elapsedMs) * 1000) : null,
      sampleBytes: received,
      error: null,
    };
  } catch (error) {
    return {
      id: mirror.id,
      ok: false,
      ttfbMs: null,
      speedBps: null,
      sampleBytes: 0,
      error: error?.name === 'AbortError' ? '超时' : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 测一个镜像，失败时重试一次。
 *
 * 为什么要重试：实测 ghfast.top 有一次采样失败、紧接着连测三次都正常
 * （1.15 / 1.10 / 5.24 MB/s）。单次抖动就判定"不可用"会让用户排除掉本来
 * 可用的镜像——那是把网络噪声当成结论。
 *
 * 为什么不重试多次：真挂的镜像重试也还是挂，多试只是让用户多等。
 * 重试成功的会带 `unstable: true`，界面照实说明，不假装它和一次就通的等价。
 *
 * @param {object} mirror
 * @param {string} assetUrl
 * @returns {Promise<object>} 结果对象，含 unstable 标记
 */
async function testMirrorWithRetry(mirror, assetUrl) {
  const first = await testMirror(mirror, assetUrl);
  if (first.ok) return { ...first, unstable: false };
  const second = await testMirror(mirror, assetUrl);
  if (second.ok) return { ...second, unstable: true };
  // 两次都失败：保留首次的错误信息（更可能是根因），并保留第二次作对照。
  return { ...first, unstable: false, secondError: second.error };
}

/**
 * 并发测所有镜像。
 *
 * 并发而不是串行：串行时总耗时等于最慢那个，用户要干等；并发下整体耗时
 * 由最慢者决定但更快出结果，而且各站互不影响。
 *
 * @param {object[]} mirrors
 * @param {string} assetUrl
 * @returns {Promise<object[]>} 与 mirrors 同序的结果数组
 */
async function testMirrors(mirrors, assetUrl) {
  return Promise.all(mirrors.map(mirror => testMirrorWithRetry(mirror, assetUrl)));
}

module.exports = { testMirror, testMirrorWithRetry, testMirrors, SAMPLE_BYTES };
