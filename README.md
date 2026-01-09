# Proxy URL Switcher

VSCode 插件，用于快速切换 `proxy-url-list-new.json` 中的服务代理地址。

## 功能特性

1. **侧边栏视图**：在左侧活动栏提供可视化的代理切换面板。
2. **多环境支持**：
   - **默认地址**：自动识别文件中已有的代理地址。
   - **标准版**：通过配置预设的环境列表。
   - **自定义地址**：手动添加临时的测试地址。
3. **精细控制**：
   - 可勾选/取消具体的代理对象（如 `rest`, `basic`, `ipd` 等），只更新选中的服务。
4. **一键应用**：点击地址项即可将 Host:Port 应用到勾选的代理对象中，保持原有路径不变。

## 使用方法

1. 打开包含 `proxy-url-list-new.json` 的工作区。
2. 点击左侧活动栏的“服务代理切换”图标。
3. 在“代理对象”分组中勾选需要修改的服务 key。
4. 点击“默认地址”、“标准版”或“自定义地址”中的某一项，即可应用。

## 配置项

- `proxyUrlSwitcher.fileGlob`: 查找 json 文件的 glob 模式（默认 `**/proxy-url-list-new.json`）。
- `proxyUrlSwitcher.profiles`: 预设环境列表，例如：
  ```json
  [
    { "name": "dev (开发环境)", "origin": "http://10.8.130.1:7002", "group": "dev" },
    { "name": "SIT-PG", "origin": "http://10.8.1.80:7002", "group": "SIT" },
    { "name": "uat-PG", "origin": "http://10.8.110.2:7002", "group": "UAT" }
  ]
  ```

## 打包安装

```bash
# 安装依赖（如果需要）
npm install -g @vscode/vsce

# 打包生成 .vsix
vsce package
```
