import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EndaxisProjectDocument } from '../core/project/schema';

/**
 * browserSaveBridge 的行为约束。
 *
 * 这些断言对应真实事故，不是形式覆盖：
 * - 上游按"提交即写盘"设计，我们在中间插了合并窗口。**首次编辑必须仍然立即落盘**，
 *   并且原样返回上游那次调用的 Promise —— 多包装一层微任务，上游测试就会挂，
 *   这类"差一拍"的问题极难排查。
 * - 连续编辑必须真的被合并，否则这个模块就没有存在的意义。
 * - 关窗等待必须有上限，否则一个写不动的 IndexedDB 会让窗口关不掉。
 */

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../data/browserProjectStorage', () => ({ saveBrowserProject: mocks.save }));

/** 每个用例重新加载模块，避免模块级队列/timer 在用例之间串味。 */
async function loadBridge() {
  vi.resetModules();
  return import('./browserSaveBridge');
}

function makeProject(id: string): EndaxisProjectDocument {
  return { id } as unknown as EndaxisProjectDocument;
}

afterEach(() => {
  vi.useRealTimers();
  mocks.save.mockReset();
});

describe('browserSaveBridge', () => {
  it('首次编辑立即落盘；随后的连续编辑合并成一次写入', async () => {
    vi.useFakeTimers();
    const bridge = await loadBridge();
    mocks.save.mockResolvedValue(undefined);

    const first = makeProject('a');
    const second = makeProject('b');
    const third = makeProject('c');

    // 队列空闲时走首写：同步调用，不等防抖窗口。
    const firstSave = bridge.queueBrowserSave(first);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0]?.[0]).toBe(first);

    // 同一 tick 内的后续编辑应被合并，不立刻写。
    const secondSave = bridge.queueBrowserSave(second);
    const thirdSave = bridge.queueBrowserSave(third);
    expect(mocks.save).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1300);
    await Promise.all([firstSave, secondSave, thirdSave]);

    // 一共两次写入：首写 + 合并后的一次；中间状态没有单独落盘。
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1]?.[0]).toBe(third);
  });

  it('合并写入的 Promise 在真正写完之后才结算', async () => {
    vi.useFakeTimers();
    const bridge = await loadBridge();
    mocks.save.mockResolvedValue(undefined);

    const firstSave = bridge.queueBrowserSave(makeProject('a')); // 首写
    const queued = bridge.queueBrowserSave(makeProject('b')); // 合并写入

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => {
      releaseWrite = resolve;
    });
    mocks.save.mockImplementation(() => writeGate);

    let settled = false;
    const settledProbe = queued.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1300);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    // 写入还没结束：此时结算会让上游误以为已经落盘，关窗时就不等了。
    expect(settled).toBe(false);

    releaseWrite();
    await Promise.all([firstSave, settledProbe]);
    expect(settled).toBe(true);
  });

  it('flushBrowserSave 会立刻写掉排队的改动，不等防抖窗口', async () => {
    vi.useFakeTimers();
    const bridge = await loadBridge();
    mocks.save.mockResolvedValue(undefined);

    const firstSave = bridge.queueBrowserSave(makeProject('a')); // 首写
    const queued = bridge.queueBrowserSave(makeProject('b')); // 排队
    expect(mocks.save).toHaveBeenCalledTimes(1);

    await bridge.flushBrowserSave();
    expect(mocks.save).toHaveBeenCalledTimes(2);

    await Promise.all([firstSave, queued]);
  });

  it('flushBrowserSaveAndWait 会等正在进行的写入结束', async () => {
    const bridge = await loadBridge();
    // 真实计时器：这里验证的是"等待"，用假计时器反而绕过了等待逻辑。
    mocks.save.mockImplementation(() => new Promise<void>(resolve => setTimeout(resolve, 60)));

    const save = bridge.queueBrowserSave(makeProject('a'));
    const flushing = bridge.flushBrowserSaveAndWait();

    expect(bridge.hasPendingBrowserSave()).toBe(true);
    await flushing;

    expect(bridge.hasPendingBrowserSave()).toBe(false);
    await save;
  });

  it('写入失败时所有等待者都被拒绝，且队列不残留', async () => {
    vi.useFakeTimers();
    const bridge = await loadBridge();
    mocks.save.mockRejectedValue(new Error('storage unavailable'));

    const first = bridge.queueBrowserSave(makeProject('a'));
    const second = bridge.queueBrowserSave(makeProject('b'));
    await bridge.flushBrowserSave();

    const results = await Promise.allSettled([first, second]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(String(result.reason)).toContain('storage unavailable');
      }
    }
    expect(bridge.hasPendingBrowserSave()).toBe(false);

    // 失败后不应卡住：再 flush 一次不重复写、也不抛。
    await expect(bridge.flushBrowserSave()).resolves.toBeUndefined();
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });

  it('持续编辑超过最长等待时强制落盘，保存进度不会被无限推迟', async () => {
    vi.useFakeTimers();
    const bridge = await loadBridge();
    mocks.save.mockResolvedValue(undefined);

    const project = makeProject('a');
    const saves: Array<Promise<void>> = [];
    // 每 1 秒编辑一次（短于防抖窗口），持续 20 秒。
    // 只靠尾触发的话，这段时间内一次都不会写。
    for (let second = 0; second < 20; second += 1) {
      saves.push(bridge.queueBrowserSave(project));
      await vi.advanceTimersByTimeAsync(1000);
    }

    const writes = mocks.save.mock.calls.length;
    expect(writes).toBeGreaterThanOrEqual(2);
    // 远少于编辑次数（20 次）：说明合并确实生效。
    expect(writes).toBeLessThan(10);

    await bridge.flushBrowserSave();
    await Promise.allSettled(saves);
  });

  it('关窗等待有上限：写入卡住时也会放行', async () => {
    vi.useFakeTimers();
    const bridge = await loadBridge();
    // 永不结算的写入，模拟 IndexedDB 卡死。
    mocks.save.mockImplementation(() => new Promise<void>(() => {}));

    bridge.queueBrowserSave(makeProject('a'));
    const flushing = bridge.flushBrowserSaveAndWait();

    // 超过 FLUSH_TIMEOUT_MS（3 秒）后必须放行，否则窗口关不掉。
    await vi.advanceTimersByTimeAsync(4000);
    await expect(flushing).resolves.toBeUndefined();
  });
});
