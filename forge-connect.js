const onLocalHost = location.protocol === 'http:' && location.hostname === '127.0.0.1';
const workbenchLink = document.querySelector('#forge-connect-link');
if (workbenchLink) workbenchLink.hidden = !onLocalHost;

const panel = document.querySelector('#forge-connection');
if (panel) {
  const connect = panel.querySelector('#connect');
  const inventory = panel.querySelector('#inventory');
  const status = panel.querySelector('#status');
  const results = panel.querySelector('#results');
  const tools = panel.querySelector('#tools');
  function busy(value) { connect.disabled = inventory.disabled = value; }
  async function run(action) {
    busy(true);
    const login = action === 'login';
    status.textContent = login ? '正在准备 ForgeCAD 授权页面…' : '正在从 ForgeCAD 读取工具清单…';
    try {
      const response = await fetch(login ? './api/forge/mcp/login' : './api/forge/mcp', {
        method:'POST', headers:{'Content-Type':'application/json'}, cache:'no-store',
        body:JSON.stringify(login ? {} : {operation:'inventory'}),
      });
      const data = await response.json();
      if (!response.ok) throw Error(response.status === 401 ? '请先点击“连接 ForgeCAD”完成授权。' :
        data.error || 'ForgeCAD 请求失败，请重试。');
      if (login) {
        if (data.url !== 'http://127.0.0.1:43168/start') throw Error('授权入口无效，请重试。');
        location.assign(data.url);
        return;
      }
      const list = document.createDocumentFragment();
      for (const tool of data.tools) {
        const entry = document.createElement('details');
        const name = document.createElement('summary');
        name.textContent = tool.name;
        entry.append(name);
        if (tool.description) {
          const description = document.createElement('p');
          description.textContent = tool.description;
          entry.append(description);
        }
        const schema = document.createElement('pre');
        schema.textContent = JSON.stringify(tool.inputSchema, null, 2);
        entry.append(schema);
        list.append(entry);
      }
      tools.replaceChildren(list);
      panel.querySelector('#count').textContent = '工具清单 · ' + data.tools.length + ' 项';
      results.hidden = false;
      status.textContent = '已读取 ' + (data.server?.name || 'ForgeCAD') + ' 当前的接口清单。展开工具可查看说明与参数。';
    } catch (error) {
      results.hidden = true;
      status.textContent = error instanceof Error ? error.message : '连接失败，请稍后重试。';
    } finally { busy(false); }
  }
  if (onLocalHost) {
    connect.addEventListener('click', () => run('login'));
    inventory.addEventListener('click', () => run('inventory'));
    if (new URLSearchParams(location.search).get('inventory') === '1') {
      history.replaceState(null, '', location.pathname);
      run('inventory');
    }
  } else {
    busy(true);
    status.textContent = '请在运行本机工作台的电脑上连接 ForgeCAD。';
    panel.querySelector('#local-entry').hidden = false;
  }
}
