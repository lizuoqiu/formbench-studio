# 在本机用 ForgeCAD 生成整机与零件

## 需求生成的装配体

本工作台的研究原型使用官方 `forgecad@0.8.2`。下列命令安装该版本，并在本机启用真实的实体计算。

```sh
npm install --prefix "$HOME/.formbench/tools/forgecad-research-0.8.2" forgecad@0.8.2 --legacy-peer-deps
export FORGECAD_BIN="$HOME/.formbench/tools/forgecad-research-0.8.2/node_modules/.bin/forgecad"
export FORGECAD_RESEARCH_AUTOMATION=true
node tools/build.mjs
node server/local.mjs
```

打开 [本机碰拳示例](http://127.0.0.1:4173/?example=fist)。工作台把毫米尺寸、布尔运算、装配位置和运动参数写成 ForgeCAD 程序，再调用 CLI 为每个实体导出 STL。结果页显示实际执行的引擎，并提供整机源文件。拖动行程滑块可以查看固定零件与活动零件的相对位置。替换零件尺寸后，原先的安装位置需要重新设计。

本研究配置运行在回环地址。0.8.2 的使用范围见[该版本随包发布的许可](https://unpkg.com/forgecad@0.8.2/LICENSE)。静态站点可以加载随示例保存的 ForgeCAD 计算结果。编辑结构后，静态页面会显示此次预览实际使用的引擎。

## 在模型上试用交互

有交互定义的项目可以在工作台直接操作模型。拖动旋钮改变角度，按住按钮观察轴向行程，释放后观察屏幕或灯的反馈。空白区域用于转动视角。「交互原理」列出控制器、输入输出及引脚，点击「在模型中查看控制板」可以定位其装配位置。旧项目只展示该版本已经定义的功能。

下载整机 `.forge.js` 后，可在 ForgeCAD Studio 的 View 面板操作原生关节滑杆和播放动作。工作台把转动输出为 `addRevolute`，把按压与滑动输出为 `addPrismatic`，共用活动件的动作组合到装配坐标系中。0.8.2 的 CLI 与 Studio 已用同一组转动、按压关节验证。ForgeCAD 官方也提供可播放的装配案例和用于连接设计代理的 MCP 服务。本项目使用本机 CLI，托管 MCP 的匿名请求在本次测试中返回 HTTP 401。[装配 API](https://forgecad.io/docs/assembly) · [原生交互演示](https://forgecad.io/) · [MCP 接入文档](https://forgecad.io/docs/ai-agents)

网页借用现有 CAD 视图的拾取结果，把使用者操作映射到指定实体，再用 XState 驱动设备状态和反馈。例如，旋钮转一格可以加一分钟，按下可以在运行与暂停之间切换。两种作用由每个项目自己的交互定义决定。需要验证程序如何处理真实引脚信号时，可另用 Wokwi 等电路与固件仿真工具；其编码器有独立的 A/B 相和按压输入。[XState](https://github.com/statelyai/xstate) · [Wokwi 编码器](https://docs.wokwi.com/parts/wokwi-ky-040)

生成和修改均使用[功能复核 skill](../server/skills/functional-review/SKILL.md)。复核包括 BOM 和 CAD 实体绑定、可检查姿态的几何相交、状态事件重放，以及独立模型对用户意图和实现的审阅。发现阻断问题时，生成器会带着具体问题修订并复查。公差、手感和真实通电结果需要样机测试。

## 既有的 Pico 模板

在自己的电脑按 ForgeCAD 的适用许可安装 `npm install -g forgecad@0.13.0 --legacy-peer-deps`，确认 `forgecad --version` 可用。若 CLI 没有加入 PATH，可将 `FORGECAD_BIN` 设置为其可执行文件的绝对路径。工作台不分发 ForgeCAD 运行时。执行 `node tools/build.mjs` 和 `node server/local.mjs`，打开 `http://127.0.0.1:4173/#mechanical`。

本机接口 `POST /api/forge` 接受 JSON，例如 `{"part":"lid","w":76,"d":32,"h":17}`，回传二进制 STL。`w`、`d`、`h` 分别为长度（62–100 mm）、宽度（29–64 mm）和底座高度（15–42 mm）；只可选择本项目的 `base`、`lid` 模板。此接口不涉及账户或 API key，不接收外部程序、脚本或源文件，也不在 GitHub Pages 中运行。打印与实际装配需另行验证。
