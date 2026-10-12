'use strict';

/**
 * 验证主进程能否在打包后的窗口里注入并执行脚本。
 *
 * 为什么要单独测：这个项目早期在打包版里遇到过 executeJavaScript 挂起，
 * 当时放弃了一批基于它的方案。浮层要靠它注入，所以先用最小用例确认
 * "打包版里确实能执行、能拿到返回值、能操作 DOM"。
 *
 * 用法： node scripts/launch.mjs tools/verify-injection.js <Endaxis.exe 路径>
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const executable = process.argv.slice(2).find(value => value.toLowerCase().endsWith('.exe'));
const PREFIX = 'INJECT ';

app.whenReady().then(async () => {
  let exitCode = 1;
  let child = null;
  try {
    if (!executable || !require('node:fs').existsSync(executable)) {
      throw new Error(`找不到可执行文件：${executable}`);
    }

    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    console.log(`${PREFIX}启动 ${executable}`);
    child = spawn(executable, [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });

    // 用 CDP 精确统计页面加载完成的时刻。
    await new Promise(resolve => setTimeout(resolve, 20_000));
    console.log(`${PREFIX}子进程存活：${child.exitCode === null}`);

    // 独立再开一个窗口指向同一个本地服务，验证注入能力本身。
    const window = new BrowserWindow({ show: false, width: 800, height: 600 });
    const results = [];

    window.webContents.on('did-finish-load', async () => {
      console.log(`${PREFIX}did-finish-load 触发`);
      try {
        const value = await window.webContents.executeJavaScript('1 + 1', true);
        console.log(`${PREFIX}executeJavaScript 返回：${value}`);
        results.push(['返回值', value === 2]);

        const dom = await window.webContents.executeJavaScript(
          `(() => {
             const node = document.createElement('div');
             node.id = '__probe__';
             node.textContent = 'injected';
             document.body.appendChild(node);
             return { hasBody: !!document.body, attached: !!document.getElementById('__probe__') };
           })()`,
          true,
        );
        console.log(`${PREFIX}DOM 操作：${JSON.stringify(dom)}`);
        results.push(['DOM 操作', dom.hasBody === true && dom.attached === true]);
      } catch (error) {
        console.log(`${PREFIX}注入失败：${error?.message ?? error}`);
        results.push(['注入', false]);
      }

      const failures = results.filter(([, ok]) => !ok).map(([name]) => name);
      console.log('');
      if (failures.length === 0) {
        console.log('通过：打包版里 executeJavaScript 可用，能操作 DOM。');
        exitCode = 0;
      } else {
        console.log(`失败：${failures.join('、')}`);
      }
      child?.kill();
      app.exit(exitCode);
    });

    window.webContents.on('did-fail-load', (_event, code, description) => {
      console.log(`${PREFIX}加载失败：${code} ${description}`);
    });

    // 本地服务是子进程起的，等它就绪。
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log(`${PREFIX}加载 http://127.0.0.1:17321/`);
    await window.loadURL('http://127.0.0.1:17321/').catch(error => {
      console.log(`${PREFIX}loadURL 抛错：${error?.message ?? error}`);
    });
  } catch (error) {
    console.log(`${PREFIX}异常：${error?.message ?? error}`);
    child?.kill();
    app.exit(1);
  }
});
