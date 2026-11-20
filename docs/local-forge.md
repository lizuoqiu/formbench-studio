# 本机重新计算 ForgeCAD 模型

在自己的电脑按 ForgeCAD 的适用许可安装 `npm install -g forgecad@0.13.0 --legacy-peer-deps`，确认 `forgecad --version` 可用。若 CLI 没有加入 PATH，可将 `FORGECAD_BIN` 设置为其可执行文件的绝对路径。工作台不分发 ForgeCAD 运行时。执行 `node tools/build.mjs` 和 `node server/local.mjs`，打开 `http://127.0.0.1:4173/#mechanical`。

本机接口 `POST /api/forge` 接受 JSON，例如 `{"part":"lid","w":76,"d":32,"h":17}`，回传二进制 STL。`w`、`d`、`h` 分别为长度（62–100 mm）、宽度（29–64 mm）和底座高度（15–42 mm）；只可选择本项目的 `base`、`lid` 模板。此接口不涉及账户或 API key，不接收外部程序、脚本或源文件，也不在 GitHub Pages 中运行。打印与实际装配需另行验证。
