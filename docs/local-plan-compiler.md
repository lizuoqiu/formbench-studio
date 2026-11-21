# 从项目 CAD 方案生成 STL

网页和本机工作台共用 **Manifold 3.5.1** 的实体布尔运算，把项目的 `design.cadPlan` 一次编译为多个独立的二进制 STL。引擎已经随静态资源附带，使用 Node 22 或更新版本，无须安装 ForgeCAD CLI、申请 API key 或设置几何环境变量。从仓库根目录运行：

```sh
node tools/build.mjs
node server/local.mjs
```

用浏览器打开 `http://127.0.0.1:4173`。已经运行旧版本服务的情况下，先停止并重新启动该进程。GitHub Pages 不提供本机 HTTP 路由。静态页面可在浏览器内启动同一个几何引擎，无需将 CAD 计划发送给服务器。

**静态网页调用。** 使用模块 Worker，发送一次计划。收到一份带 `result`（与下面 HTTP 的成功响应一致）或 `error` 的消息后关闭 Worker；消费端还应在取消、出错或超时（例如 30 秒）时调用 `terminate()`。
```js
const task = new Worker(new URL('./cad-worker.js', import.meta.url), {type:'module'});
task.onmessage = ({data}) => { task.terminate(); /* 使用 data.result 或显示 data.error */ };
task.postMessage({cadPlan: design.cadPlan});
```

**本机 HTTP 调用。** 从工作台所在的同一来源向 `/api/forge/plan` 发送一次 POST：
```js
const res = await fetch('/api/forge/plan', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({cadPlan: design.cadPlan})
});
const result = await res.json();
if (!res.ok) throw Error(result.error);
for (const body of result.bodies) {
  const bytes = Uint8Array.from(atob(body.stlBase64), c => c.charCodeAt(0));
  // 用同一份 bytes 预览或生成 Blob 下载，下载名用 body.fileName。
}
```

**单位与坐标。** 文件以毫米为约定。每个 `feature.centerMm` 是图元自己的几何中心，用设计体局部坐标表示；盒体和椭球用三向全尺寸，圆柱用 [直径,直径,高度]，默认轴沿 Z。图元可选的 `rotationDeg: [rx,ry,rz]` 以度为单位，绕图元中心按固定轴 X→Y→Z 旋转，再平移至 `centerMm`。按照特征顺序添加或切除。返回的 `bodies` 与输入同序，保留 `name`、`role`、`partIndex` 及 `positionMm`。切勿把装配平移写进独立 STL；组合预览时仅应用一次 `positionMm`。同一 BOM 行有多个实体时，按数组顺序和独立文件名加以区分。`reference` 角色的 STL 供占位对照，不应随 `printed` 角色默认送去打印。

**失败时。** 400 表示版本/字段、图元类型、尺度或首个操作无效；422 表示布尔运算未留下有效实体或网格过大；429 表示另一项编译尚未完成；504 表示运行超过 30 秒。上述情况不会返回部分零件，不应使用旧 STL 冒充此次结果。一个实体最多 65,000 个三角面，整批 STL 最多 12 MiB。没有在此服务运行任意 JavaScript，也不会自动调用或分发 ForgeCAD。导出实体并不验证装配间隙、材料、壁厚或结构强度。

路由和真实几何回归验证：`node --test server/forge-plan.test.mjs`。引擎来源和 Apache-2.0 许可证见[随包记录](../assets/manifold-3d/README.md)。
