const vscode = require('vscode');

const CONFIG_SECTION = 'proxyUrlSwitcher';
const STATE_CUSTOM_ORIGINS = 'proxyUrlSwitcher.customOrigins';
const STATE_SELECTED_TARGETS = 'proxyUrlSwitcher.selectedTargets';
const STATE_CURRENT_ORIGIN = 'proxyUrlSwitcher.currentOrigin';

function normalizeOrigin(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  }

  const withScheme = `http://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

function hasExplicitPort(origin) {
  try {
    const u = new URL(origin);
    return Boolean(u.port);
  } catch {
    return false;
  }
}

function validateOriginInputRequirePort(input) {
  const origin = normalizeOrigin(input);
  if (!origin) return '输入格式不合法';
  if (!hasExplicitPort(origin)) return '端口不能为空，例如 10.8.150.33:7002';
  return null;
}

function groupBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item) || '';
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

async function pickTargetFile() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const fileGlob = config.get('fileGlob') || '**/{proxy-url-list.json,proxy-url-list-new.json}';
  const uris = await vscode.workspace.findFiles(fileGlob, '**/{node_modules,dist,build,out,.git}/**', 20);
  if (!uris.length) {
    vscode.window.showErrorMessage(`未找到文件：${fileGlob}`);
    return null;
  }
  if (uris.length === 1) return uris[0];

  const items = uris.map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择要更新的配置文件' });
  return picked?.uri || null;
}

async function readJson(uri) {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 解析失败：${vscode.workspace.asRelativePath(uri)}`);
  }
}

async function writeJson(uri, data) {
  const text = JSON.stringify(data, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

function applyOriginToMap(mapObj, origin, onlyKeys) {
  const out = { ...mapObj };
  const changed = [];
  const originUrl = new URL(origin);
  Object.entries(out).forEach(([key, value]) => {
    if (Array.isArray(onlyKeys) && onlyKeys.length && !onlyKeys.includes(key)) return;
    if (typeof value !== 'string') return;
    let url;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    const next = new URL(url.toString());
    next.protocol = originUrl.protocol;
    next.hostname = originUrl.hostname;
    if (originUrl.port) next.port = originUrl.port;
    const nextValue = next.toString().replace(/\/$/, '');
    if (nextValue !== value) {
      out[key] = nextValue;
      changed.push(key);
    }
  });
  return { out, changed };
}

async function applyOrigin(origin, selectedTargets) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    vscode.window.showErrorMessage('地址不合法');
    return;
  }
  if (!hasExplicitPort(normalized)) {
    vscode.window.showErrorMessage('端口不能为空，例如 10.8.150.33:7002');
    return;
  }

  const uri = await pickTargetFile();
  if (!uri) return;

  let json;
  try {
    json = await readJson(uri);
  } catch (e) {
    vscode.window.showErrorMessage(e.message || String(e));
    return;
  }

  const { out, changed } = applyOriginToMap(json, normalized, selectedTargets);
  await writeJson(uri, out);

  const fileName = vscode.workspace.asRelativePath(uri);
  const changedText = changed.length ? `，更新 ${changed.length} 项` : '，无变化';
  vscode.window.showInformationMessage(`已应用 ${normalized} 到 ${fileName}${changedText}`);
}

function getProfiles() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const profiles = config.get('profiles') || [];
  return Array.isArray(profiles) ? profiles : [];
}

async function setCurrentProfile(name) {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('currentProfile', name, vscode.ConfigurationTarget.Workspace);
}

function getCurrentProfileName() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get('currentProfile') || '';
}

async function findTargetFileForView() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const fileGlob = config.get('fileGlob') || '**/{proxy-url-list.json,proxy-url-list-new.json}';
  const uris = await vscode.workspace.findFiles(fileGlob, '**/{node_modules,dist,build,out,.git}/**', 20);
  
  if (uris.length === 0) return null;
  if (uris.length === 1) return uris[0];

  // Prefer proxy-url-list-new.json if multiple found
  const preferred = uris.find(u => u.path.endsWith('proxy-url-list-new.json'));
  return preferred || uris[0];
}

async function loadProxyMapForView() {
  const uri = await findTargetFileForView();
  if (!uri) return { uri: null, map: null };
  try {
    const map = await readJson(uri);
    return { uri, map };
  } catch {
    return { uri, map: null };
  }
}

function getTargetKeys(map) {
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map).sort();
}

function getSelectedTargets(context, map) {
  const saved = context.workspaceState.get(STATE_SELECTED_TARGETS);
  const allKeys = getTargetKeys(map);
  if (!Array.isArray(saved) || !saved.length) return allKeys;
  const set = new Set(saved);
  return allKeys.filter(k => set.has(k));
}

async function setSelectedTargets(context, targets) {
  const unique = Array.from(new Set(Array.isArray(targets) ? targets : [])).sort();
  await context.workspaceState.update(STATE_SELECTED_TARGETS, unique);
}

function isTargetSelected(context, key, map) {
  const selected = getSelectedTargets(context, map);
  return selected.includes(key);
}

async function toggleTargetKey(context, key, map) {
  const allKeys = getTargetKeys(map);
  const current = getSelectedTargets(context, map);
  const set = new Set(current);
  if (set.has(key)) {
    set.delete(key);
  } else {
    set.add(key);
  }
  const next = allKeys.filter(k => set.has(k));
  await setSelectedTargets(context, next);
  return next;
}

class SectionNode {
  constructor(id, label) {
    this.id = id;
    this.label = label;
  }
}

class GroupNode {
  constructor(sectionId, label) {
    this.sectionId = sectionId;
    this.label = label;
  }
}

class OriginNode {
  constructor(sectionId, name, origin) {
    this.sectionId = sectionId;
    this.name = name;
    this.origin = origin;
  }
}

class ActionNode {
  constructor(label, command) {
    this.label = label;
    this.command = command;
  }
}

class TargetNode {
  constructor(key, value) {
    this.key = key;
    this.value = value;
  }
}

class ProxyUrlTreeDataProvider {
  constructor(context) {
    this.context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.latest = { uri: null, map: null };
  }

  async reload() {
    this.latest = await loadProxyMapForView();
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    if (element instanceof SectionNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = element.id;
      item.contextValue = element.id; // default, standard, custom, targets
      if (element.id === 'standard') item.iconPath = new vscode.ThemeIcon('server');
      else if (element.id === 'custom') item.iconPath = new vscode.ThemeIcon('beaker');
      else if (element.id === 'targets') item.iconPath = new vscode.ThemeIcon('target');
      return item;
    }

    if (element instanceof GroupNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${element.sectionId}:${element.label}`;
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }

    if (element instanceof OriginNode) {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
      item.description = element.origin;
      // Set distinct contextValue for menu contribution
      if (element.sectionId === 'standard') {
        item.contextValue = 'standardProfileItem';
        item.iconPath = new vscode.ThemeIcon('link', new vscode.ThemeColor('charts.green'));
      } else if (element.sectionId === 'custom') {
        item.contextValue = 'customOriginItem';
        item.iconPath = new vscode.ThemeIcon('link', new vscode.ThemeColor('charts.yellow'));
      } else {
        item.contextValue = 'originNode';
        item.iconPath = new vscode.ThemeIcon('link');
      }
      item.command = {
        command: 'proxyUrlSwitcher.applyOriginFromView',
        title: 'apply',
        arguments: [element.origin, element.name]
      };
      return item;
    }

    if (element instanceof ActionNode) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.command = { command: element.command, title: element.label };
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }

    if (element instanceof TargetNode) {
      const item = new vscode.TreeItem(element.key, vscode.TreeItemCollapsibleState.None);
      item.description = element.value;
      item.contextValue = 'targetNode';
      item.iconPath = new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.blue'));
      item.checkboxState = isTargetSelected(this.context, element.key, this.latest.map)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      item.command = {
        command: 'proxyUrlSwitcher.toggleTarget',
        title: 'toggle',
        arguments: [element.key]
      };
      return item;
    }

    return new vscode.TreeItem('');
  }

  async getChildren(element) {
    if (!this.latest.uri) {
      await this.reload();
    }

    if (!element) {
      return [
        new SectionNode('standard', '标准版地址'),
        new SectionNode('custom', '自定义地址'),
        new SectionNode('targets', '代理对象')
      ];
    }

    if (element instanceof SectionNode) {
      if (element.id === 'standard') {
        const profiles = getProfiles()
          .map(p => ({ ...p, origin: normalizeOrigin(p.origin) }))
          .filter(p => p.origin);

        if (!profiles.length) {
          return [new ActionNode('未配置标准版地址（点击这里输入地址）', 'proxyUrlSwitcher.setHostPort')];
        }

        // Flattened list, sorted by group priority then name
        return profiles.sort((a, b) => {
          const groupOrder = ['dev', 'SIT', 'UAT', '标准版'];
          const ga = a.group || '标准版';
          const gb = b.group || '标准版';
          
          const ia = groupOrder.indexOf(ga);
          const ib = groupOrder.indexOf(gb);
          
          if (ia !== -1 && ib !== -1) {
            if (ia !== ib) return ia - ib;
          } else if (ia !== -1) {
            return -1;
          } else if (ib !== -1) {
            return 1;
          } else {
            const compareGroup = ga.localeCompare(gb);
            if (compareGroup !== 0) return compareGroup;
          }
          
          return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
        }).map(p => new OriginNode('standard', p.name, p.origin));
      }

      if (element.id === 'custom') {
        const customOrigins = this.context.workspaceState.get(STATE_CUSTOM_ORIGINS) || [];
        const nodes = Array.isArray(customOrigins)
          ? customOrigins.map(o => {
              // Backward compatibility for string array
              if (typeof o === 'string') {
                return new OriginNode('custom', o, o);
              }
              // New object structure: { name, origin }
              return new OriginNode('custom', o.name || o.origin, o.origin);
            })
          : [];
        return [new ActionNode('添加自定义地址…', 'proxyUrlSwitcher.addCustomOrigin'), ...nodes];
      }

      if (element.id === 'targets') {
        const map = this.latest.map;
        if (!map) {
          return [new ActionNode('未读取到代理配置（点击刷新）', 'proxyUrlSwitcher.refreshView')];
        }
        const keys = getTargetKeys(map);
        return keys.map(k => new TargetNode(k, map[k]));
      }
    }

    if (element instanceof GroupNode) {
      if (element.sectionId === 'standard') {
        const profiles = getProfiles()
          .map(p => ({ ...p, origin: normalizeOrigin(p.origin) }))
          .filter(p => p.origin);
        const grouped = groupBy(profiles, p => p.group || '标准版');
        const list = grouped[element.label] || [];
        return list
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'))
          .map(p => new OriginNode('standard', p.name, p.origin));
      }
    }

    return [];
  }
}

function activate(context) {
  const provider = new ProxyUrlTreeDataProvider(context);
  const treeView = vscode.window.createTreeView('proxyUrlSwitcher.view', {
    treeDataProvider: provider,
    showCollapseAll: false
  });
  context.subscriptions.push(treeView);

  const refreshView = vscode.commands.registerCommand('proxyUrlSwitcher.refreshView', async () => {
    await provider.reload();
    provider.refresh();
  });

  const addCustomOrigin = vscode.commands.registerCommand('proxyUrlSwitcher.addCustomOrigin', async () => {
    const name = await vscode.window.showInputBox({
      prompt: '输入别名（例如：Local Dev）',
      placeHolder: 'Local Dev'
    });
    if (!name) return;

    const input = await vscode.window.showInputBox({
      prompt: '输入 host:port 或完整 URL（例如 10.8.130.1:7002 或 http://10.8.130.1:7002）',
      value: '',
      validateInput: validateOriginInputRequirePort
    });
    if (input === undefined) return;
    const origin = normalizeOrigin(input);
    if (!origin || !hasExplicitPort(origin)) {
      vscode.window.showErrorMessage(!origin ? '输入格式不合法' : '端口不能为空，例如 10.8.150.33:7002');
      return;
    }

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const profiles = config.get('profiles') || [];
    const existsInProfiles = profiles.some(p => normalizeOrigin(p.origin) === origin || p.name === name);

    if (existsInProfiles) {
      vscode.window.showWarningMessage(`该名称或地址已在“标准版”中存在：${name} / ${origin}`);
      return;
    }

    const current = context.workspaceState.get(STATE_CUSTOM_ORIGINS) || [];
    // Check duplicates in custom list (handle both string and object formats)
    const existsInCustom = current.some(o => {
      const existingOrigin = typeof o === 'string' ? o : o.origin;
      const existingName = typeof o === 'string' ? o : o.name;
      return existingOrigin === origin || existingName === name;
    });

    if (existsInCustom) {
      vscode.window.showWarningMessage(`该名称或地址已存在：${name} / ${origin}`);
      return;
    }

    // Store as object: { name, origin }
    const newItem = { name: name, origin };
    
    // Normalize existing data to objects for consistent storage
    const normalizedCurrent = current.map(o => (typeof o === 'string' ? { name: o, origin: o } : o));
    const next = [...normalizedCurrent, newItem].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    
    await context.workspaceState.update(STATE_CUSTOM_ORIGINS, next);
    provider.refresh();
  });

  const deleteCustomOrigin = vscode.commands.registerCommand('proxyUrlSwitcher.deleteCustomOrigin', async (node) => {
    if (!node || !node.origin) return;
    const current = context.workspaceState.get(STATE_CUSTOM_ORIGINS) || [];
    // Filter out by origin (handle both string and object formats)
    const next = current.filter(o => {
      const existingOrigin = typeof o === 'string' ? o : o.origin;
      return existingOrigin !== node.origin;
    });
    await context.workspaceState.update(STATE_CUSTOM_ORIGINS, next);
    provider.refresh();
  });

  const addStandardProfile = vscode.commands.registerCommand('proxyUrlSwitcher.addStandardProfile', async () => {
    const name = await vscode.window.showInputBox({
      prompt: '输入名称（例如：My Dev Env）',
      placeHolder: 'My Dev Env'
    });
    if (!name) return;

    const input = await vscode.window.showInputBox({
      prompt: '输入地址（例如：http://10.8.1.1:7002）',
      placeHolder: 'http://10.8.1.1:7002',
      validateInput: validateOriginInputRequirePort
    });
    if (input === undefined) return;
    const origin = normalizeOrigin(input);
    if (!origin || !hasExplicitPort(origin)) {
      vscode.window.showErrorMessage(!origin ? '输入地址格式不合法' : '端口不能为空，例如 10.8.150.33:7002');
      return;
    }

    const group = await vscode.window.showInputBox({
      prompt: '输入分组（可选，默认为“标准版”）',
      placeHolder: '标准版'
    });

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const profiles = config.get('profiles') || [];
    
    // Check for duplicates
    const exists = profiles.some(p => p.origin === origin || p.name === name);
    if (exists) {
      vscode.window.showWarningMessage(`该名称或地址已存在：${name} / ${origin}`);
      return;
    }

    const newProfile = { name, origin, group: group || '标准版' };
    const newProfiles = [...profiles, newProfile];
    await config.update('profiles', newProfiles, vscode.ConfigurationTarget.Global);
    provider.refresh();
  });

  const deleteStandardProfile = vscode.commands.registerCommand('proxyUrlSwitcher.deleteStandardProfile', async (node) => {
    if (!node || !node.name) return;
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const profiles = config.get('profiles') || [];
    const newProfiles = profiles.filter(p => p.name !== node.name || normalizeOrigin(p.origin) !== node.origin);
    await config.update('profiles', newProfiles, vscode.ConfigurationTarget.Global);
    provider.refresh();
  });

  const clearCustomOrigins = vscode.commands.registerCommand('proxyUrlSwitcher.clearCustomOrigins', async () => {
    await context.workspaceState.update(STATE_CUSTOM_ORIGINS, []);
    provider.refresh();
  });

  const applyOriginFromView = vscode.commands.registerCommand(
    'proxyUrlSwitcher.applyOriginFromView',
    async (origin, name) => {
      const normalized = normalizeOrigin(origin);
      if (!normalized) {
        vscode.window.showErrorMessage('地址不合法');
        return;
      }
      if (!hasExplicitPort(normalized)) {
        vscode.window.showErrorMessage('端口不能为空，请删除该地址后重新添加（例如 10.8.150.33:7002）');
        return;
      }
      const selectedTargets = getSelectedTargets(context, provider.latest.map);
      await context.workspaceState.update(STATE_CURRENT_ORIGIN, normalized);
      if (name) {
        await setCurrentProfile(name);
      }
      await applyOrigin(normalized, selectedTargets);
      await provider.reload();
      provider.refresh();
    }
  );

  const toggleTarget = vscode.commands.registerCommand('proxyUrlSwitcher.toggleTarget', async key => {
    if (!provider.latest.map) await provider.reload();
    if (!provider.latest.map) return;
    await toggleTargetKey(context, key, provider.latest.map);
    provider.refresh();
  });

  const setHostPort = vscode.commands.registerCommand('proxyUrlSwitcher.setHostPort', async () => {
    const input = await vscode.window.showInputBox({
      prompt: '输入 host:port 或完整 URL（例如 10.8.130.1:7002 或 http://10.8.130.1:7002）',
      value: '',
      validateInput: validateOriginInputRequirePort
    });
    if (input === undefined) return;
    const origin = normalizeOrigin(input);
    if (!origin || !hasExplicitPort(origin)) {
      vscode.window.showErrorMessage(!origin ? '输入格式不合法' : '端口不能为空，例如 10.8.150.33:7002');
      return;
    }
    const selectedTargets = getSelectedTargets(context, provider.latest.map);
    await context.workspaceState.update(STATE_CURRENT_ORIGIN, origin);
    await applyOrigin(origin, selectedTargets);
    await provider.reload();
    provider.refresh();
  });

  const selectProfile = vscode.commands.registerCommand('proxyUrlSwitcher.selectProfile', async () => {
    const profiles = getProfiles();
    if (!profiles.length) {
      vscode.window.showErrorMessage('未配置 profiles，请在 VSCode 设置中配置 proxyUrlSwitcher.profiles');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map(p => ({ label: p.name, description: p.origin, profile: p })),
      { placeHolder: '选择一个 profile 并应用' }
    );
    if (!picked?.profile) return;
    const origin = normalizeOrigin(picked.profile.origin);
    if (!origin) {
      vscode.window.showErrorMessage(`profile origin 不合法：${picked.profile.origin}`);
      return;
    }
    if (!hasExplicitPort(origin)) {
      vscode.window.showErrorMessage(`profile 缺少端口：${picked.profile.origin}`);
      return;
    }
    await setCurrentProfile(picked.profile.name);
    const selectedTargets = getSelectedTargets(context, provider.latest.map);
    await context.workspaceState.update(STATE_CURRENT_ORIGIN, origin);
    await applyOrigin(origin, selectedTargets);
    await provider.reload();
    provider.refresh();
  });

  const applyProfile = vscode.commands.registerCommand('proxyUrlSwitcher.applyProfile', async () => {
    const name = getCurrentProfileName();
    const profiles = getProfiles();
    const profile = profiles.find(p => p?.name === name);
    if (!profile) {
      vscode.window.showErrorMessage('未找到 currentProfile 对应的 profile，请先选择 profile');
      return;
    }
    const origin = normalizeOrigin(profile.origin);
    if (!origin) {
      vscode.window.showErrorMessage(`profile origin 不合法：${profile.origin}`);
      return;
    }
    if (!hasExplicitPort(origin)) {
      vscode.window.showErrorMessage(`profile 缺少端口：${profile.origin}`);
      return;
    }
    const selectedTargets = getSelectedTargets(context, provider.latest.map);
    await context.workspaceState.update(STATE_CURRENT_ORIGIN, origin);
    await applyOrigin(origin, selectedTargets);
    await provider.reload();
    provider.refresh();
  });

  context.subscriptions.push(
    refreshView,
    addCustomOrigin,
    deleteCustomOrigin,
    addStandardProfile,
    deleteStandardProfile,
    clearCustomOrigins,
    applyOriginFromView,
    toggleTarget,
    setHostPort,
    selectProfile,
    applyProfile
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
