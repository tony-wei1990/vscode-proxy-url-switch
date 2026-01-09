const vscode = require('vscode');

const CONFIG_SECTION = 'proxyUrlSwitcher';
const STATE_CUSTOM_ORIGINS = 'proxyUrlSwitcher.customOrigins';
const STATE_SELECTED_TARGETS = 'proxyUrlSwitcher.selectedTargets';
const STATE_CURRENT_ORIGIN = 'proxyUrlSwitcher.currentOrigin';

/**
 * @description 规范化输入的 URL 地址
 * @author tony
 * @param {string} input - 用户输入的地址字符串
 * @returns {string|null} - 返回规范化后的 origin (例如 http://10.8.1.1:7002)，如果输入无效则返回 null
 */
function normalizeOrigin(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // 如果输入已经包含了 http:// 或 https://，直接解析
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  }

  // 如果没有提供协议，我们尝试补全 http://，但这种情况下强制要求必须有端口号
  const withScheme = `http://${raw}`;
  try {
    const u = new URL(withScheme);
    // 如果没有显式端口，且输入又不带协议，则视为不合法
    if (!u.port) {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * @description 检查地址是否包含端口号或为标准协议默认端口
 * @author tony
 * @param {string} origin - 规范化后的 origin 地址
 * @returns {boolean} - 如果包含端口号或为已知协议（http/https）则返回 true
 */
function isSupportedOrigin(origin) {
  try {
    const u = new URL(origin);
    // 如果有显式端口，直接通过
    if (u.port) return true;
    // 如果没有显式端口，但协议是 http 或 https，也认为是合法的（使用默认端口 80/443）
    if (u.protocol === 'http:' || u.protocol === 'https:') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * @description 校验用户输入的地址
 * @author tony
 * @param {string} input - 用户输入的地址字符串
 * @returns {string|null} - 如果校验不通过返回错误信息，通过则返回 null
 */
function validateOriginInput(input) {
  const origin = normalizeOrigin(input);
  if (!origin) return '输入格式不合法';
  if (!isSupportedOrigin(origin)) return '地址必须包含端口号或使用标准协议(http/https)';
  return null;
}

/**
 * @description 对数组进行分组
 * @author tony
 * @param {Array} items - 待分组的数组
 * @param {Function} getKey - 获取分组 key 的函数
 * @returns {Object} - 分组后的对象，key 为分组名，value 为数组
 */
function groupBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item) || '';
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

/**
 * @description 让用户选择要更新的目标配置文件
 * @author tony
 * @returns {Promise<vscode.Uri|null>} - 返回选中的文件 Uri，如果没有找到或未选择则返回 null
 */
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

/**
 * @description 读取 JSON 文件内容
 * @author tony
 * @param {vscode.Uri} uri - 文件 Uri
 * @returns {Promise<Object>} - 解析后的 JSON 对象
 */
async function readJson(uri) {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 解析失败：${vscode.workspace.asRelativePath(uri)}`);
  }
}

/**
 * @description 将数据写入 JSON 文件
 * @author tony
 * @param {vscode.Uri} uri - 文件 Uri
 * @param {Object} data - 要写入的数据对象
 */
async function writeJson(uri, data) {
  const text = JSON.stringify(data, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

/**
 * @description 将新的 origin 应用到配置对象中
 * @author tony
 * @param {Object} mapObj - 原始配置对象
 * @param {string} origin - 新的 origin 地址
 * @param {Array<string>} onlyKeys - 仅更新指定的 key 列表，如果为空则更新所有匹配项
 * @returns {Object} - { out: 更新后的对象, changed: 发生变更的 key 列表 }
 */
function applyOriginToMap(mapObj, origin, onlyKeys) {
  const out = { ...mapObj };
  const changed = [];
  const originUrl = new URL(origin);
  
  // 核心逻辑：如果提供了 onlyKeys（即使是空数组），也应该严格按 onlyKeys 过滤
  // 之前的逻辑中，如果 onlyKeys 为空（length 为 0），会跳过过滤导致更新所有节点
  const hasFilter = Array.isArray(onlyKeys);

  Object.entries(out).forEach(([key, value]) => {
    if (hasFilter && !onlyKeys.includes(key)) return;
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
    // 如果新 origin 有端口，则应用它；如果没有（如 https://www.baidu.com），则清空端口（使用协议默认端口）
    if (originUrl.port) {
      next.port = originUrl.port;
    } else {
      next.port = '';
    }
    const nextValue = next.toString().replace(/\/$/, '');
    if (nextValue !== value) {
      out[key] = nextValue;
      changed.push(key);
    }
  });
  return { out, changed };
}

/**
 * @description 执行应用 origin 的主要流程：校验、读取文件、更新内容、写入文件、提示结果
 * @author tony
 * @param {string} origin - 要应用的 origin 地址
 * @param {Array<string>} selectedTargets - 选中的要更新的目标 key 列表
 */
async function applyOrigin(origin, selectedTargets) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    vscode.window.showErrorMessage('地址不合法');
    return;
  }
  if (!isSupportedOrigin(normalized)) {
    vscode.window.showErrorMessage('地址必须包含端口号或使用标准协议(http/https)');
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

  if (changed.length > 0) {
    // 成功：绿色勾勾效果（通过文本模拟）
    vscode.window.showInformationMessage(`✅ Success! 已应用 ${normalized} 到 ${fileName}，更新 ${changed.length} 项`);
  } else {
    // 无变化：黄色感叹号
    vscode.window.showWarningMessage(`已应用 ${normalized} 到 ${fileName}，但无变化 (内容一致或未匹配)`);
  }
}

/**
 * @description 获取配置中的标准版配置列表
 * @author tony
 * @returns {Array} - 标准版配置数组
 */
function getProfiles() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const profiles = config.get('profiles') || [];
  return Array.isArray(profiles) ? profiles : [];
}

/**
 * @description 设置当前选中的配置名称（持久化到 workspace 配置）
 * @author tony
 * @param {string} name - 配置名称
 */
async function setCurrentProfile(name) {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('currentProfile', name, vscode.ConfigurationTarget.Workspace);
}

/**
 * @description 获取当前选中的配置名称
 * @author tony
 * @returns {string} - 配置名称
 */
function getCurrentProfileName() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get('currentProfile') || '';
}

/**
 * @description 查找用于视图显示的配置文件 Uri
 * 优先查找 proxy-url-list-new.json，其次是 proxy-url-list.json
 * @author tony
 * @returns {Promise<vscode.Uri|null>} - 文件 Uri 或 null
 */
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

/**
 * @description 加载代理配置映射以供视图显示
 * @author tony
 * @returns {Promise<Object>} - { uri, map }
 */
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

/**
 * @description 获取映射对象的所有 Key
 * @author tony
 * @param {Object} map - 映射对象
 * @returns {Array<string>} - 排序后的 Key 数组
 */
function getTargetKeys(map) {
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map).sort();
}

/**
 * @description 获取当前选中的目标 Key 列表
 * @author tony
 * @param {vscode.ExtensionContext} context - 扩展上下文
 * @param {Object} map - 映射对象，用于过滤不存在的 key
 * @returns {Array<string>} - 选中的 Key 列表
 */
function getSelectedTargets(context, map) {
  const saved = context.workspaceState.get(STATE_SELECTED_TARGETS);
  const allKeys = getTargetKeys(map);
  
  // 逻辑优化：
  // 1. undefined -> 首次运行 -> 全选
  // 2. [] (空数组) -> 全不选 -> 在本插件场景下，全不选意味着点击切换无任何效果，这通常不是用户预期的。
  //    这也解决了用户反馈的“初始化进去都是未勾选状态”的问题（通常是之前的状态变成了空数组）。
  //    所以，如果是空数组，我们也默认视为“全选”。
  if (!Array.isArray(saved) || saved.length === 0) {
    return allKeys;
  }
  
  const set = new Set(saved);
  // 只返回“既在 saved 中，又在当前 map 中”的 key
  const validTargets = allKeys.filter(k => set.has(k));

  // 二次兜底：如果过滤后发现一个都没选中（比如之前的 key 都改名了），那也恢复全选
  if (validTargets.length === 0) {
    return allKeys;
  }

  return validTargets;
}

/**
 * @description 设置选中的目标 Key 列表
 * @author tony
 * @param {vscode.ExtensionContext} context - 扩展上下文
 * @param {Array<string>} targets - 新的 Key 列表
 */
async function setSelectedTargets(context, targets) {
  const unique = Array.from(new Set(Array.isArray(targets) ? targets : [])).sort();
  await context.workspaceState.update(STATE_SELECTED_TARGETS, unique);
}

/**
 * @description 判断指定 Key 是否被选中
 * @author tony
 * @param {vscode.ExtensionContext} context - 扩展上下文
 * @param {string} key - 目标 Key
 * @param {Object} map - 映射对象
 * @returns {boolean}
 */
function isTargetSelected(context, key, map) {
  const selected = getSelectedTargets(context, map);
  return selected.includes(key);
}

/**
 * @description 切换指定 Key 的选中状态
 * @author tony
 * @param {vscode.ExtensionContext} context - 扩展上下文
 * @param {string} key - 目标 Key
 * @param {Object} map - 映射对象
 * @returns {Promise<Array<string>>} - 更新后的选中列表
 */
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

/**
 * @description 树视图中的顶级分段节点（如：标准版地址、自定义地址、代理对象）
 * @author tony
 */
class SectionNode {
  /**
   * @description 构造函数
   * @author tony
   * @param {string} id - 分段 ID
   * @param {string} label - 显示的标签名称
   */
  constructor(id, label) {
    this.id = id;
    this.label = label;
  }
}

/**
 * @description 树视图中的分组节点（用于对标准版地址进行分组）
 * @author tony
 */
class GroupNode {
  /**
   * @description 构造函数
   * @author tony
   * @param {string} sectionId - 所属分段 ID
   * @param {string} label - 分组名称
   */
  constructor(sectionId, label) {
    this.sectionId = sectionId;
    this.label = label;
  }
}

/**
 * @description 树视图中的地址节点，代表一个具体的代理地址
 * @author tony
 */
class OriginNode {
  /**
   * @description 构造函数
   * @author tony
   * @param {string} sectionId - 所属分段 ID
   * @param {string} name - 地址别名
   * @param {string} origin - 实际的 URL origin 地址
   */
  constructor(sectionId, name, origin) {
    this.sectionId = sectionId;
    this.name = name;
    this.origin = origin;
  }
}

/**
 * @description 树视图中的操作节点（如：添加自定义地址、刷新等）
 * @author tony
 */
class ActionNode {
  /**
   * @description 构造函数
   * @author tony
   * @param {string} label - 操作显示的文本
   * @param {string} command - 点击时执行的 VS Code 命令 ID
   */
  constructor(label, command) {
    this.label = label;
    this.command = command;
  }
}

/**
 * @description 树视图中的代理目标节点（proxy-url-list.json 中的具体 key）
 * @author tony
 */
class TargetNode {
  /**
   * @description 构造函数
   * @author tony
   * @param {string} key - 代理目标的 key
   * @param {string} value - 当前指向的地址
   */
  constructor(key, value) {
    this.key = key;
    this.value = value;
  }
}

/**
 * @description 代理地址切换器的树视图数据提供者
 * 负责解析配置文件、管理自定义地址，并将其渲染为树状结构
 * @author tony
 */
class ProxyUrlTreeDataProvider {
  /**
   * @description 构造函数
   * @author tony
   * @param {vscode.ExtensionContext} context - 扩展上下文
   */
  constructor(context) {
    this.context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.latest = { uri: null, map: null };
  }

  /**
   * @description 重新加载代理配置映射数据
   * @author tony
   */
  async reload() {
    this.latest = await loadProxyMapForView();
  }

  /**
   * @description 刷新树视图 UI
   * @author tony
   */
  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * @description 获取单个树节点的显示项配置
   * @author tony
   * @param {any} element - 树节点对象
   * @returns {vscode.TreeItem} - VS Code 树项对象
   */
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
      // 优化 UI：使用更精简的 description，详细信息移至 tooltip
      // item.description = element.origin; 
      // 仅显示 Host 部分，避免太长
      try {
        const url = new URL(element.origin);
        item.description = url.port ? `${url.hostname}:${url.port}` : url.hostname;
      } catch {
        item.description = element.origin;
      }

      const currentOrigin = this.context.workspaceState.get(STATE_CURRENT_ORIGIN);
      const isSelected = currentOrigin === element.origin;
      
      // 高级 UI：Markdown Tooltip
      const md = new vscode.MarkdownString();
      md.supportHtml = true;
      md.appendMarkdown(`**名称**: ${element.name}\n\n`);
      md.appendMarkdown(`**地址**: \`${element.origin}\`\n\n`);
      if (isSelected) {
        md.appendMarkdown(`---\n\n✅ **当前已应用**`);
      } else {
        md.appendMarkdown(`---\n\n点击应用此代理`);
      }
      item.tooltip = md;

      if (isSelected) {
        item.iconPath = this.context.asAbsolutePath('resources/selected_v3.svg');
        // Keep contextValue to support menus
        if (element.sectionId === 'standard') {
          item.contextValue = 'standardProfileItem';
        } else if (element.sectionId === 'custom') {
          item.contextValue = 'customOriginItem';
        } else {
          item.contextValue = 'originNode';
        }
      } else {
        // 优化图标：使用更语义化的图标
        const iconName = 'globe'; // 使用 globe 代表网络/代理
        // Set distinct contextValue for menu contribution
        if (element.sectionId === 'standard') {
          item.contextValue = 'standardProfileItem';
          item.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor('charts.green'));
        } else if (element.sectionId === 'custom') {
          item.contextValue = 'customOriginItem';
          item.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor('charts.orange')); // 改为 orange 区分度更高
        } else {
          item.contextValue = 'originNode';
          item.iconPath = new vscode.ThemeIcon(iconName);
        }
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
      // 优化图标：添加操作通常用 add
      if (element.command === 'proxyUrlSwitcher.addCustomOrigin') {
        item.iconPath = new vscode.ThemeIcon('add', new vscode.ThemeColor('textLink.foreground'));
      } else if (element.command === 'proxyUrlSwitcher.refreshView') {
        item.iconPath = new vscode.ThemeIcon('refresh');
      } else if (element.command === 'proxyUrlSwitcher.setHostPort') {
        item.iconPath = new vscode.ThemeIcon('edit');
      } else {
        item.iconPath = new vscode.ThemeIcon('info');
      }
      return item;
    }

    if (element instanceof TargetNode) {
      const item = new vscode.TreeItem(element.key, vscode.TreeItemCollapsibleState.None);
      item.description = element.value;
      item.contextValue = 'targetNode';
      // 优化图标：使用 variable 或 symbol-variable 显得更像配置项
      item.iconPath = new vscode.ThemeIcon('symbol-variable', new vscode.ThemeColor('charts.blue'));
      
      // 高级 UI：Tooltip 显示完整信息
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Key**: \`${element.key}\`\n\n`);
      md.appendMarkdown(`**Value**: \`${element.value}\``);
      item.tooltip = md;

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

  /**
   * @description 获取指定节点的子节点列表，用于构建树形结构
   * @author tony
   * @param {any} element - 父节点对象，如果为 undefined 则返回根节点列表
   * @returns {Promise<any[]>} - 子节点数组
   */
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

/**
 * @description 插件激活时的入口函数，负责初始化视图、注册所有命令和事件
 * @author tony
 * @param {vscode.ExtensionContext} context - 插件上下文，用于存储状态和订阅销毁事件
 */
function activate(context) {
  const provider = new ProxyUrlTreeDataProvider(context);
  const treeView = vscode.window.createTreeView('proxyUrlSwitcher.view', {
    treeDataProvider: provider,
    showCollapseAll: false
  });
  context.subscriptions.push(treeView);

  // 监听复选框变更事件，更新 workspaceState
  treeView.onDidChangeCheckboxState(async e => {
    const items = e.items;
    if (!items || items.length === 0) return;

    const map = provider.latest.map;
    if (!map) return;

    let current = getSelectedTargets(context, map);
    const set = new Set(current);

    // 更新 set
    for (const [element, state] of items) {
      if (element instanceof TargetNode) {
        if (state === vscode.TreeItemCheckboxState.Checked) {
          set.add(element.key);
        } else {
          set.delete(element.key);
        }
      }
    }

    // 保存回 workspaceState
    const allKeys = getTargetKeys(map);
    const next = allKeys.filter(k => set.has(k));
    await setSelectedTargets(context, next);
  });

  // 移除状态栏相关逻辑（用户反馈体验不佳）
  // const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  // ...

  // 监听配置变更以刷新视图
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(CONFIG_SECTION)) {
      provider.refresh();
    }
  }));

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

    // 尝试从剪贴板获取 URL
    const clipboardText = await vscode.env.clipboard.readText();
    const defaultUrl = normalizeOrigin(clipboardText) ? clipboardText : '';

    const input = await vscode.window.showInputBox({
      prompt: '输入 host:port 或完整 URL（例如 10.8.130.1:7002 或 http://10.8.130.1:7002）',
      value: defaultUrl,
      validateInput: validateOriginInput
    });
    if (input === undefined) return;
    const origin = normalizeOrigin(input);
    if (!origin || !isSupportedOrigin(origin)) {
      vscode.window.showErrorMessage(!origin ? '输入格式不合法' : '地址必须包含端口号或使用标准协议(http/https)');
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

    // 尝试从剪贴板获取 URL
    const clipboardText = await vscode.env.clipboard.readText();
    const defaultUrl = normalizeOrigin(clipboardText) ? clipboardText : '';

    const input = await vscode.window.showInputBox({
      prompt: '输入地址（例如：http://10.8.1.1:7002）',
      placeHolder: 'http://10.8.1.1:7002',
      value: defaultUrl,
      validateInput: validateOriginInput
    });
    if (input === undefined) return;
    const origin = normalizeOrigin(input);
    if (!origin || !isSupportedOrigin(origin)) {
      vscode.window.showErrorMessage(!origin ? '输入地址格式不合法' : '地址必须包含端口号或使用标准协议(http/https)');
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
      if (!isSupportedOrigin(normalized)) {
        vscode.window.showErrorMessage('地址必须包含端口号或使用标准协议(http/https)');
        return;
      }
      const selectedTargets = getSelectedTargets(context, provider.latest.map);
      
      // 智能提示：如果选中列表为空（可能是因为之前的 BUG 导致状态丢失，或者用户误操作），提示是否应用到全部
      // 这解决了用户反馈的“图一切换之前 图二切换之后”全都没了的问题
      if (selectedTargets.length === 0) {
        const allKeys = getTargetKeys(provider.latest.map);
        // 如果有可用的 targets，才进行提示
        if (allKeys.length > 0) {
          const answer = await vscode.window.showInformationMessage(
            '当前未选中任何代理对象。是否应用到所有对象？',
            '是 (Yes)',
            '取消 (Cancel)'
          );
          if (answer === '是 (Yes)') {
            // 更新选中状态为全选
            await setSelectedTargets(context, allKeys);
            // 使用全选列表进行应用
            await context.workspaceState.update(STATE_CURRENT_ORIGIN, normalized);
            if (name) {
              await setCurrentProfile(name);
            }
            await applyOrigin(normalized, allKeys);
            await provider.reload();
            provider.refresh();
            return;
          }
        }
      }

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
      validateInput: validateOriginInput
    });
    if (input === undefined) return;
    const origin = normalizeOrigin(input);
    if (!origin || !isSupportedOrigin(origin)) {
      vscode.window.showErrorMessage(!origin ? '输入格式不合法' : '地址必须包含端口号 or 使用标准协议(http/https)');
      return;
    }
    const selectedTargets = getSelectedTargets(context, provider.latest.map);
    await context.workspaceState.update(STATE_CURRENT_ORIGIN, origin);
    await applyOrigin(origin, selectedTargets);
    await provider.reload();
    provider.refresh();
  });

  const selectProfile = vscode.commands.registerCommand('proxyUrlSwitcher.selectProfile', async () => {
    // 汇总所有可选地址
    const profiles = getProfiles();
    const customOrigins = context.workspaceState.get(STATE_CUSTOM_ORIGINS) || [];
    
    const items = [
      ...profiles.map(p => ({ 
        label: p.name, 
        description: p.origin, 
        detail: `[标准版] ${p.group || ''}`,
        origin: p.origin,
        name: p.name
      })),
      ...customOrigins.map(o => {
        const origin = typeof o === 'string' ? o : o.origin;
        const name = typeof o === 'string' ? o : o.name;
        return {
          label: name,
          description: origin,
          detail: '[自定义]',
          origin: origin,
          name: name
        };
      })
    ];

    if (!items.length) {
      vscode.window.showErrorMessage('没有可用的代理地址，请先添加地址');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, { 
      placeHolder: '选择一个代理地址并应用',
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (!picked) return;

    const origin = normalizeOrigin(picked.origin);
    if (!origin || !isSupportedOrigin(origin)) {
      vscode.window.showErrorMessage(`地址不合法：${picked.origin}`);
      return;
    }

    await setCurrentProfile(picked.name);
    const selectedTargets = getSelectedTargets(context, provider.latest.map);
    await context.workspaceState.update(STATE_CURRENT_ORIGIN, origin);
    await applyOrigin(origin, selectedTargets);
    await provider.reload();
    provider.refresh();
  });

  const applyProfile = vscode.commands.registerCommand('proxyUrlSwitcher.applyProfile', async () => {
    const name = getCurrentProfileName();
    const profiles = getProfiles();
    const customOrigins = context.workspaceState.get(STATE_CUSTOM_ORIGINS) || [];
    
    // 先找标准版，再找自定义
    let profile = profiles.find(p => p?.name === name);
    if (!profile) {
      const custom = customOrigins.find(o => (typeof o === 'string' ? o : o.name) === name);
      if (custom) {
        profile = typeof custom === 'string' ? { name: custom, origin: custom } : custom;
      }
    }

    if (!profile) {
      vscode.window.showErrorMessage('未找到当前选中的配置，请先在列表中选择');
      return;
    }

    const origin = normalizeOrigin(profile.origin);
    if (!origin || !isSupportedOrigin(origin)) {
      vscode.window.showErrorMessage(`地址不合法：${profile.origin}`);
      return;
    }

    const selectedTargets = getSelectedTargets(context, provider.latest.map);
    await context.workspaceState.update(STATE_CURRENT_ORIGIN, origin);
    await applyOrigin(origin, selectedTargets);
    await provider.reload();
    provider.refresh();
  });

  /**
   * @description 复制地址到剪贴板
   * @author tony
   * @param {OriginNode} node - 地址节点
   */
  const copyOrigin = vscode.commands.registerCommand('proxyUrlSwitcher.copyOrigin', async (node) => {
    if (node && node.origin) {
      await vscode.env.clipboard.writeText(node.origin);
      vscode.window.showInformationMessage(`已复制地址: ${node.origin}`);
    }
  });

  /**
   * @description 编辑现有的地址（支持标准版和自定义地址）
   * @author tony
   * @param {OriginNode} node - 要编辑的节点
   */
  const editOrigin = vscode.commands.registerCommand('proxyUrlSwitcher.editOrigin', async (node) => {
    if (!node || !node.origin) return;

    const isStandard = node.sectionId === 'standard';
    const isCustom = node.sectionId === 'custom';

    // 1. 获取新名称
    const newName = await vscode.window.showInputBox({
      prompt: '编辑名称',
      value: node.name
    });
    if (newName === undefined) return;

    // 2. 获取新地址
    const newInput = await vscode.window.showInputBox({
      prompt: '编辑地址',
      value: node.origin,
      validateInput: validateOriginInput
    });
    if (newInput === undefined) return;
    const newOrigin = normalizeOrigin(newInput);
    if (!newOrigin || !isSupportedOrigin(newOrigin)) {
      vscode.window.showErrorMessage('地址不合法');
      return;
    }

    if (isStandard) {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const profiles = config.get('profiles') || [];
      const index = profiles.findIndex(p => p.name === node.name && normalizeOrigin(p.origin) === node.origin);
      if (index !== -1) {
        const newProfiles = [...profiles];
        newProfiles[index] = { ...newProfiles[index], name: newName, origin: newOrigin };
        await config.update('profiles', newProfiles, vscode.ConfigurationTarget.Global);
      }
    } else if (isCustom) {
      const current = context.workspaceState.get(STATE_CUSTOM_ORIGINS) || [];
      const index = current.findIndex(o => {
        const origin = typeof o === 'string' ? o : o.origin;
        const name = typeof o === 'string' ? o : o.name;
        return origin === node.origin && name === node.name;
      });
      if (index !== -1) {
        const next = [...current];
        next[index] = { name: newName, origin: newOrigin };
        await context.workspaceState.update(STATE_CUSTOM_ORIGINS, next);
      }
    }

    provider.refresh();
  });

  context.subscriptions.push(
    refreshView,
    addCustomOrigin,
    deleteCustomOrigin,
    editOrigin,
    copyOrigin,
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
