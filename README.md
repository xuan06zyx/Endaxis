# Endfield Timeline Editor - 《明日方舟：终末地》排轴工具

**Endaxis** 是一个基于 Web 专为《明日方舟：终末地》设计的可视化时间轴编辑工具。

开发者从 [开发文档](docs/README.md) 进入；架构、操作、当前交接和本机环境分别维护。

> ⚠️ **注意**：本项目是一个粉丝自制工具，目前处于开发阶段。

> 本仓库是 [Lieyuan621/Endaxis](https://github.com/Lieyuan621/Endaxis) 的 fork，
> 在同步上游代码的基础上**额外做了一层 Electron 桌面壳**，用于以 Windows 应用形式
> 离线使用与自动更新。上游前端代码基本原样保留，可直接跟随上游更新；
> 桌面壳源码在 [`desktop-shell/`](desktop-shell/)，说明见
> [desktop-shell/DESKTOP.md](desktop-shell/DESKTOP.md)。
>
> 如果你只是想在浏览器里用，请直接用下面的在线体验地址，不需要本仓库的桌面版。

## 桌面版（Windows）

从 [Releases](https://github.com/xuan06zyx/Endaxis/releases/latest) 下载
`Endaxis-Setup-x.y.z-x64.exe` 安装即可。安装包**未做代码签名**，首次运行
Windows SmartScreen 会提示"未知发布者"，需点"仍要运行"。

- 项目数据保存在本机（`%APPDATA%\endaxis-desktop`），**离线可用**
- 关闭程序时会把排队中的编辑写入磁盘，不会丢最后一次改动
- 启动时自动检查更新；更新前自动备份项目数据
- 无法直连 GitHub 时可在「帮助 → 检查更新」里**测速并选择镜像站**
- 关于固定端口、数据位置、更新与发布流程，见
  [desktop-shell/DESKTOP.md](desktop-shell/DESKTOP.md)

## 在线体验

**项目已部署，点击下方链接即可直接使用：**

**<https://www.end-axis.com/>**

## 目前所能实现的效果

![项目预览](assets/preview.png)

## 核心功能

- **高精度排轴**：基于 CSS Grid 的时间网格，支持精确到 `1帧` 的动作块拖拽与对齐。
- **拖放交互**：支持从技能库放置技能，以及轨道内移动和调整。
- **连携可视化**：通过 SVG 动态绘制贝塞尔曲线，实时显示技能之间的连携与依赖关系。
- **多角色管理**：支持切换轨道干员、编辑配装与技能；模拟报告无法执行或不合法的输入。

## 技术栈

本项目使用现代前端技术栈构建：

- **框架**: [Vue 3](https://vuejs.org/) (Composition API)
- **构建工具**: [Vite](https://vitejs.dev/)
- **状态管理**: [Pinia](https://pinia.vuejs.org/)
- **UI 组件库**: [Element Plus](https://element-plus.org/)
- **国际化**: [vue-i18n](https://vue-i18n.intlify.dev/)
- **拖拽库**: [Vue.Draggable](https://github.com/SortableJS/vue.draggable.next)
- **样式**: CSS Grid + CSS Variables

## 语言与主题

界面与游戏内容按需加载语言资源，主题只影响显示。开发规则见 [编辑器说明](docs/architecture/editor.md)。

## 本地开发

如果你想在本地运行或参与开发：

### 环境要求

- Node.js（22.12 或更高版本）
- npm（依赖版本以仓库锁文件为准）

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
npm run dev
```

启动后使用终端实际显示的地址，端口可能因本机占用而变化。
验证命令、数据生成和本机环境记录见 [开发指南](docs/development/README.md)。
