# Clash Proxy Plugin for AstrBot

使用 Clash 进行代理管理，支持通过订阅链接导入订阅，并提供 **WebUI 管理界面**（推荐使用）。

## 功能

- **WebUI 管理面板**（插件详情 → 视图 → dashboard）：
  - 查看应用代理地址、控制器状态和 Mihomo 转发模式
  - 查看所有策略组并直接选择节点（通过 Clash External Controller API）
  - 添加、删除和应用订阅，查看面板最近应用的配置
  - 更新订阅缓存，按需重新应用
  - **粘贴导入 YAML 配置**
  - **将本地 YAML 通过 payload 推送到 Clash 并重载配置**
- 配置 Clash 代理地址和外部控制器
- 订阅 YAML 保存到本地数据目录
- 精简聊天指令（仅状态查询，节点切换请用 WebUI）

## 使用方法

1. 将插件文件夹放到 AstrBot 的 `data/plugins/` 目录下。
2. 在 WebUI 插件页面安装依赖并重载。
3. 选择核心运行方式。
   - 内置 Mihomo。开启 `use_builtin_core`，插件会自动启动核心。默认代理入口为 `http://127.0.0.1:7890`，端口由 `builtin_mixed_port` 配置。
   - 外部 Clash/Mihomo。启动已有核心并启用 External Controller。在插件配置中填写 `proxy_url`（例如 `http://127.0.0.1:7890`）、`controller_url`（例如 `http://127.0.0.1:9090`）和对应的 `controller_secret`。
4. 进入 **插件 → astrbot_plugin_clash_proxy → 视图 → dashboard** 打开管理界面。
5. 添加返回 Clash/Mihomo YAML 的订阅链接，点击对应行的 **应用**，然后在策略组里选节点。首次应用会下载 YAML，后续使用本地缓存。要下载最新内容，先点击 **更新订阅缓存**，再点击该行的 **重新应用**。

外部核心也可由桌面客户端管理。面板显示它通过该控制器最后成功应用的配置，桌面客户端随后切换的订阅需在桌面端查看。删除订阅链接只移除列表项，已加载的配置会持续到下次切换。

## 让 Grok 使用这个代理

在 `astrbot_plugin_xiaobai_grok` 的插件配置中，将“本插件 OAuth 和推理出站代理”（`proxy`）填为面板显示的 **应用代理地址**，保存后再授权或调用模型。默认是 `http://127.0.0.1:7890`。当核心和 Grok 插件处于不同机器或容器时，填写从 Grok 插件运行环境能访问的核心地址。外部核心运行在 Windows 宿主机而 AstrBot 在 Docker 内时，`127.0.0.1` 指向容器自身，代理地址和控制器地址都要填容器可访问的宿主机地址。

代理端口（默认 `7890`）接收应用请求。控制器端口（默认 `9090`）供面板查询状态、应用配置和切换节点。插件本身通过代理入口测试连通性，其他应用通过自己的代理设置接入。Windows 系统代理是 Windows 中由应用读取的代理设置。

Mihomo 的规则模式和全局模式决定进入核心后的流量如何转发。规则模式按照 YAML 的规则选择节点、直连或拒绝，全局模式走 `GLOBAL` 策略组。应用订阅会载入该 YAML 的配置，实际模式可在面板状态区查看。

## 数据存储

- 订阅缓存保存在 `data/plugin_data/astrbot_plugin_clash_proxy/subs/downloads/`
- 内置核心的持久配置是 `data/plugin_data/astrbot_plugin_clash_proxy/core/config.yaml`

控制器确认应用成功后，插件会写入 `core/config.yaml` 和最后应用记录。内置 Mihomo 重启时会读取这份本地配置。外部核心重启后的配置由该核心的启动方式决定。

## 开发参考

基于 AstrBot 官方插件开发规范与插件可视化视图（Plugin Views）。
