import {loginToForge, forgetForgeLogin} from '../server/forge-mcp-auth.mjs';
try {
  if (!process.argv[2]) {
    await loginToForge(process.env, {ready: url => console.log('请在本机浏览器打开此链接，并在 ForgeCAD 页面授权：\n' + url)});
    console.log('已保存 Formbench 的本机 ForgeCAD 授权。');
  } else if (process.argv[2] === '--forget') {
    await forgetForgeLogin(process.env);
    console.log('已清除 Formbench 本地保存的 ForgeCAD 登录。');
  } else {
    throw Error('Usage: node tools/auth-forge-mcp.mjs [--forget]');
  }
} catch (error) {
  // SDK errors may include upstream response text. Only print our own guidance.
  console.error(error.code === 'EADDRINUSE' ? '本机 ForgeCAD 授权窗口已在运行或端口 43168 已被占用。' :
    'ForgeCAD 授权未完成。请检查网络，确认浏览器授权后重试。');
  process.exitCode = 1;
}
