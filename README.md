# Clash Proxy Plugin for AstrBot

使用 Clash 进行代理管理，支持通过订阅链接导入订阅，并提供 **WebUI 管理界面**（推荐使用）。

## 功能

- **WebUI 管理面板**（插件详情 → 视图 → dashboard）：
  - 查看代理与控制器状态
  - 查看所有策略组并直接选择节点（通过 Clash External Controller API）
  - 添加 / 删除 / 更新订阅
  - **导入本地 YAML 文件**
  - **将本地 YAML 通过 payload 推送到 Clash 并重载配置**
- 配置 Clash 代理地址和外部控制器
- 订阅文件自动下载并保存到本地数据目录
- 精简聊天指令（仅状态查询，节点切换请用 WebUI）

## 使用方法

1. 将插件文件夹放到 AstrBot 的 `data/plugins/` 目录下。
2. 在 WebUI 插件页面安装依赖并重载。
3. 在插件配置中设置：
   - `proxy_url`：例如 `http://127.0.0.1:7890`
   - `controller_url`：例如 `http://127.0.0.1:9090`
   - `controller_secret`：如有则填写
4. 进入 **插件 → astrbot_plugin_clash_proxy → 视图 → dashboard** 打开管理界面。

## 前置条件

- Clash / Mihomo 已运行，并开启 External Controller（默认 `127.0.0.1:9090`）。
- 控制器需要能访问（本地或允许的网络）。
- 订阅链接推荐使用 Clash/Mihomo YAML 格式。

## 数据存储

- 订阅原文保存在 `data/plugin_data/astrbot_plugin_clash_proxy/subs/`
- 内置核心的持久配置是 `data/plugin_data/astrbot_plugin_clash_proxy/core/config.yaml`

推送到 Clash 时会同时写入 `core/config.yaml`（并保留 mixed-port / external-controller / secret）。AstrBot 或插件重启后，内置 Mihomo 会读这份文件，节点不会丢。

## 开发参考

基于 AstrBot 官方插件开发规范与插件可视化视图（Plugin Views）。
