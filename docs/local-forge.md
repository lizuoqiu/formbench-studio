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

## 既有的 Pico 模板

在自己的电脑按 ForgeCAD 的适用许可安装 `npm install -g forgecad@0.13.0 --legacy-peer-deps`，确认 `forgecad --version` 可用。若 CLI 没有加入 PATH，可将 `FORGECAD_BIN` 设置为其可执行文件的绝对路径。工作台不分发 ForgeCAD 运行时。执行 `node tools/build.mjs` 和 `node server/local.mjs`，打开 `http://127.0.0.1:4173/#mechanical`。

本机接口 `POST /api/forge` 接受 JSON，例如 `{"part":"lid","w":76,"d":32,"h":17}`，回传二进制 STL。`w`、`d`、`h` 分别为长度（62–100 mm）、宽度（29–64 mm）和底座高度（15–42 mm）；只可选择本项目的 `base`、`lid` 模板。此接口不涉及账户或 API key，不接收外部程序、脚本或源文件，也不在 GitHub Pages 中运行。打印与实际装配需另行验证。
