'use strict';

/**
 * 验证脚本共用的"制造一次真实编辑"的代码片段。
 *
 * 为什么必须共用：这段逻辑极易踩坑，散落多份就会各修一遍。
 *
 * 踩过的坑：
 *   1. 合成 DOM 事件必须走**原生 setter + 派发 input/change**，否则 Vue 的
 *      响应式不会更新，压根不产生项目提交（"改不动"会被误判成"保存失败"）；
 *   2. 不能只按"输入框的旧值"挑目标：上一次运行已经把值改掉了，
 *      再按原值找就会失败（第一遍过、第二遍报错）；
 *   3. **必须优先挑敌人面板里的数值框**：页面上还有别处的数字输入（比如方案
 *      序号 "01"），改那些不会触发项目提交，于是"没写盘"看起来像"保存坏了"；
 *   4. 应用的数值框是数字输入，标记值要用纯数字，超长字符串会被拒绝。
 *
 * 用法：把 `buildEditScript(marker)` 的返回值传给 executeJavaScript。
 */

/** 生成"改一个敌人数值输入框"的脚本；marker 用 6 位纯数字。 */
function buildEditScript(marker) {
  return `
(() => {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const inputs = Array.from(document.querySelectorAll('input'));
  const normalized = input => String(input.value ?? '').replace(/[,\\s]/g, '');

  const inEnemyPanel = input =>
    input.closest('[class*="enemy"], [class*="Enemy"]') !== null;
  const numeric = inputs.filter(input => /^\\d+$/.test(normalized(input)));

  // 只认敌人面板里的数值框：那是能稳定触发 projectSession.commit 的入口，
  // 且在空项目下也存在。挑不到就明确失败，不要退而求其次改别的输入框。
  const target = numeric.find(input => inEnemyPanel(input) && normalized(input) !== '${marker}');

  if (target === undefined) {
    return {
      ok: false,
      reason: 'no-enemy-numeric-input',
      numericValues: numeric.map(i => normalized(i)).slice(0, 12),
      hasEnemyPanel: document.querySelector('[class*="enemy"], [class*="Enemy"]') !== null,
    };
  }

  const previous = target.value;
  setValue.call(target, '${marker}');
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  target.blur();
  return { ok: true, previous, now: target.value };
})()
`;
}

module.exports = { buildEditScript };
