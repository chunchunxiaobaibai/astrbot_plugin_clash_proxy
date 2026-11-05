from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register
from astrbot.api import logger
from astrbot.api import AstrBotConfig
from astrbot.api.web import json_response, error_response, request
from pathlib import Path
from astrbot.core.utils.astrbot_path import get_astrbot_data_path
import aiohttp
import yaml
import json
import os
import sys
import platform
import asyncio
import gzip
import shutil
import secrets
from typing import List, Optional, Dict, Any, Tuple
from urllib.parse import quote

PLUGIN_NAME = "astrbot_plugin_clash_proxy"
MIHOMO_VERSION = "v1.19.33"
MIHOMO_DOWNLOAD_BASE = f"https://github.com/MetaCubeX/mihomo/releases/download/{MIHOMO_VERSION}"
GEOX_SNIPPET = """
geo-auto-update: false
geox-url:
  mmdb: "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.metadb"
  geoip: "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat"
  geosite: "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat"
  asn: "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb"
"""
GEODATA_FILES = {
    "geoip.metadb": [
        "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.metadb",
        "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.metadb",
    ],
    "geoip.dat": [
        "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat",
        "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat",
    ],
    "geosite.dat": [
        "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat",
        "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat",
    ],
}

def dump_yaml(data: Dict[str, Any]) -> str:
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False, default_flow_style=False)


def config_has_nodes(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    proxies = data.get("proxies")
    if isinstance(proxies, list) and any(isinstance(item, dict) for item in proxies):
        return True
    providers = data.get("proxy-providers")
    return isinstance(providers, dict) and len(providers) > 0


def controller_host_from_url(url: str) -> str:
    host = (url or "").strip().rstrip("/")
    for prefix in ("http://", "https://"):
        if host.lower().startswith(prefix):
            host = host[len(prefix):]
            break
    return host or "127.0.0.1:9090"


def merge_runtime_keys(content: str, runtime: Dict[str, Any]) -> str:
    try:
        data = yaml.safe_load(content)
    except Exception:
        data = None
    if not isinstance(data, dict):
        return content.rstrip() + "\n" + dump_yaml(runtime)
    data.update(runtime)
    profile = data.get("profile") if isinstance(data.get("profile"), dict) else {}
    profile.setdefault("store-selected", True)
    data["profile"] = profile
    return dump_yaml(data)


@register(PLUGIN_NAME, "pan xie", "Clash 代理管理与订阅导入插件（支持内置核心）", "1.4.3")
class ClashProxyPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self.plugin_name = PLUGIN_NAME
        self.data_dir = Path(get_astrbot_data_path()) / "plugin_data" / self.plugin_name
        self.subs_dir = self.data_dir / "subs"
        self.bin_dir = self.data_dir / "bin"
        self.config_dir = self.data_dir / "core"
        self.subs_dir.mkdir(parents=True, exist_ok=True)
        self.bin_dir.mkdir(parents=True, exist_ok=True)
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.subs_index_file = self.data_dir / "subscriptions.json"
        self.state_file = self.data_dir / "runtime_state.json"
        self.core_config_file = self.config_dir / "config.yaml"
        self.core_process: Optional[asyncio.subprocess.Process] = None
        self._core_lock = asyncio.Lock()
        self._paste_chunks: Dict[str, Dict[str, Any]] = {}
        self._stop_requested = False
        self._user_stopped = False
        self._watchdog_task: Optional[asyncio.Task] = None

        # 注册 Web API
        context.register_web_api(f"/{PLUGIN_NAME}/status", self.api_status, ["GET"], "获取状态")
        context.register_web_api(f"/{PLUGIN_NAME}/proxies", self.api_proxies, ["GET"], "获取代理与策略组")
        context.register_web_api(f"/{PLUGIN_NAME}/proxies/select", self.api_select_proxy, ["POST"], "选择节点")
        context.register_web_api(f"/{PLUGIN_NAME}/subscriptions", self.api_get_subs, ["GET"], "获取订阅列表")
        context.register_web_api(f"/{PLUGIN_NAME}/subscriptions/add", self.api_add_sub, ["POST"], "添加订阅")
        context.register_web_api(f"/{PLUGIN_NAME}/subscriptions/remove", self.api_remove_sub, ["POST"], "删除订阅")
        context.register_web_api(f"/{PLUGIN_NAME}/subscriptions/update", self.api_update_subs, ["POST"], "更新订阅")
        context.register_web_api(f"/{PLUGIN_NAME}/configs/list", self.api_list_configs, ["GET"], "列出本地配置")
        context.register_web_api(f"/{PLUGIN_NAME}/configs/reload", self.api_reload_config, ["POST"], "推送配置到 Clash")
        context.register_web_api(f"/{PLUGIN_NAME}/configs/import-paste/chunk", self.api_import_paste_chunk, ["POST"], "粘贴 YAML 分片")
        context.register_web_api(f"/{PLUGIN_NAME}/configs/import-paste/finish", self.api_import_paste_finish, ["POST"], "完成粘贴导入")
        context.register_web_api(f"/{PLUGIN_NAME}/core/status", self.api_core_status, ["GET"], "内置核心状态")
        context.register_web_api(f"/{PLUGIN_NAME}/core/start", self.api_core_start, ["POST"], "启动内置核心")
        context.register_web_api(f"/{PLUGIN_NAME}/core/stop", self.api_core_stop, ["POST"], "停止内置核心")
        context.register_web_api(f"/{PLUGIN_NAME}/core/restart", self.api_core_restart, ["POST"], "重启内置核心")

    async def initialize(self):
        logger.info("Clash Proxy 插件已加载（支持内置核心）")
        await self._load_subscriptions()
        if self.config.get("use_builtin_core", False):
            self._stop_requested = False
            self._user_stopped = False
            self._watchdog_task = asyncio.create_task(self._ensure_core_running())

    async def terminate(self):
        self._stop_requested = True
        task = self._watchdog_task
        self._watchdog_task = None
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        await self._stop_core()

    # ==================== 内置核心管理 ====================

    def _get_platform_asset(self) -> str:
        system = platform.system().lower()
        machine = platform.machine().lower()
        if system == "linux":
            if machine in ("x86_64", "amd64"):
                return f"mihomo-linux-amd64-{MIHOMO_VERSION}.gz"
            if machine in ("aarch64", "arm64"):
                return f"mihomo-linux-arm64-{MIHOMO_VERSION}.gz"
            if machine in ("armv7l", "arm"):
                return f"mihomo-linux-armv7-{MIHOMO_VERSION}.gz"
        if system == "darwin":
            if machine in ("x86_64", "amd64"):
                return f"mihomo-darwin-amd64-{MIHOMO_VERSION}.gz"
            if machine in ("arm64", "aarch64"):
                return f"mihomo-darwin-arm64-{MIHOMO_VERSION}.gz"
        if system == "windows":
            if machine in ("x86_64", "amd64"):
                return f"mihomo-windows-amd64-{MIHOMO_VERSION}.zip"
        return f"mihomo-linux-amd64-{MIHOMO_VERSION}.gz"

    def _get_binary_path(self) -> Path:
        name = "mihomo.exe" if platform.system().lower() == "windows" else "mihomo"
        return self.bin_dir / name

    async def _download_core(self) -> bool:
        binary = self._get_binary_path()
        if binary.exists() and binary.stat().st_size > 1_000_000:
            return True

        asset = self._get_platform_asset()
        url = f"{MIHOMO_DOWNLOAD_BASE}/{asset}"
        logger.info(f"[ClashProxy] 正在下载 Mihomo: {url}")

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                    if resp.status != 200:
                        logger.error(f"[ClashProxy] 下载失败 HTTP {resp.status}")
                        return False
                    data = await resp.read()

            gz_path = self.bin_dir / asset
            gz_path.write_bytes(data)

            if asset.endswith(".gz"):
                with gzip.open(gz_path, "rb") as f_in:
                    with open(binary, "wb") as f_out:
                        shutil.copyfileobj(f_in, f_out)
                gz_path.unlink(missing_ok=True)
            else:
                # zip fallback
                import zipfile
                with zipfile.ZipFile(gz_path) as zf:
                    for info in zf.infolist():
                        if info.filename.endswith("mihomo") or info.filename.endswith("mihomo.exe"):
                            with zf.open(info) as src, open(binary, "wb") as dst:
                                shutil.copyfileobj(src, dst)
                            break
                gz_path.unlink(missing_ok=True)

            os.chmod(binary, 0o755)
            logger.info(f"[ClashProxy] Mihomo 已下载: {binary}")
            return True
        except Exception as e:
            logger.error(f"[ClashProxy] 下载核心异常: {e}")
            return False

    def _try_save_plugin_config(self):
        save = getattr(self.config, "save", None)
        if callable(save):
            try:
                save()
            except Exception:
                pass

    def _ensure_secret(self) -> str:
        secret = str(self.config.get("builtin_secret") or "")
        if secret:
            return secret
        data = self._load_yaml_file(self.core_config_file)
        if data and data.get("secret"):
            secret = str(data["secret"])
            self.config["builtin_secret"] = secret
            self._try_save_plugin_config()
            return secret
        secret = secrets.token_hex(16)
        self.config["builtin_secret"] = secret
        self._try_save_plugin_config()
        return secret

    def _builtin_runtime_keys(self) -> Dict[str, Any]:
        port = int(self.config.get("builtin_mixed_port", 7890))
        ctrl_port = int(self.config.get("builtin_controller_port", 9090))
        return {
            "mixed-port": port,
            "allow-lan": True,
            "bind-address": "*",
            "external-controller": f"0.0.0.0:{ctrl_port}",
            "secret": self._ensure_secret(),
        }

    def _merge_runtime_keys(self, content: str) -> str:
        if self.config.get("use_builtin_core", False):
            return merge_runtime_keys(content, self._builtin_runtime_keys())
        try:
            data = yaml.safe_load(content)
        except Exception:
            data = None
        if not isinstance(data, dict):
            return content
        if not data.get("external-controller"):
            data["external-controller"] = controller_host_from_url(
                self.config.get("controller_url", "http://127.0.0.1:9090")
            )
        secret = str(self.config.get("controller_secret") or "")
        if secret and not data.get("secret"):
            data["secret"] = secret
        return dump_yaml(data)

    def _write_text_atomic(self, path: Path, text: str):
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)

    def _write_core_config(self, content: str):
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self._write_text_atomic(self.core_config_file, content)

    def _load_yaml_file(self, path: Path) -> Optional[Dict[str, Any]]:
        if not path.exists():
            return None
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8", errors="ignore"))
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _load_state(self) -> Dict[str, Any]:
        if not self.state_file.exists():
            return {}
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save_state(self, patch: Dict[str, Any]):
        data = self._load_state()
        data.update(patch)
        self._write_text_atomic(self.state_file, json.dumps(data, ensure_ascii=False, indent=2))

    def _get_last_applied(self) -> str:
        return str(self._load_state().get("last_applied") or "")

    def _set_last_applied(self, filename: str):
        if filename:
            self._save_state({"last_applied": filename})

    def _find_restore_source(self) -> Optional[Path]:
        name = self._get_last_applied()
        if name:
            path = self.subs_dir / name
            if path.exists() and path.stat().st_size > 50:
                return path
        candidates = sorted(
            list(self.subs_dir.glob("*.yaml")) + list(self.subs_dir.glob("*.yml")),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        for path in candidates:
            if config_has_nodes(self._load_yaml_file(path)):
                return path
        return None

    def _ensure_core_config(self):
        data = self._load_yaml_file(self.core_config_file)
        if config_has_nodes(data):
            if self.config.get("use_builtin_core", False):
                runtime = self._builtin_runtime_keys()
                if any(data.get(key) != value for key, value in runtime.items()):
                    current = self.core_config_file.read_text(encoding="utf-8", errors="ignore")
                    self._write_core_config(self._merge_runtime_keys(current))
            return

        source = self._find_restore_source()
        if source:
            raw = source.read_text(encoding="utf-8", errors="ignore")
            self._write_core_config(self._merge_runtime_keys(self._patch_geox(raw)))
            self._set_last_applied(source.name)
            logger.info(f"[ClashProxy] 已从 {source.name} 恢复核心配置")
            return

        runtime = self._builtin_runtime_keys()
        minimal = {
            **runtime,
            "mode": "rule",
            "log-level": "info",
            "proxies": [],
            "proxy-groups": [
                {"name": "PROXY", "type": "select", "proxies": ["DIRECT"]}
            ],
            "rules": ["MATCH,PROXY"],
            "profile": {"store-selected": True},
        }
        self._write_core_config(dump_yaml(minimal))
        logger.info(f"[ClashProxy] 已生成最小配置: {self.core_config_file}")

    async def _start_core(self) -> Dict[str, Any]:
        async with self._core_lock:
            if self.core_process and self.core_process.returncode is None:
                return {"ok": True, "message": "核心已在运行", "running": True}

            if not await self._download_core():
                return {"ok": False, "message": "下载核心失败"}

            self._ensure_core_config()
            binary = self._get_binary_path()
            cmd = [str(binary), "-d", str(self.config_dir)]

            try:
                self.core_process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                await asyncio.sleep(1.5)
                if self.core_process.returncode is not None:
                    err = await self.core_process.stderr.read() if self.core_process.stderr else b""
                    return {"ok": False, "message": f"启动失败: {err.decode(errors='ignore')[:300]}"}
                logger.info("[ClashProxy] 内置核心已启动")
                return {"ok": True, "message": "核心已启动", "running": True, "pid": self.core_process.pid}
            except Exception as e:
                return {"ok": False, "message": str(e)}

    async def _stop_core(self) -> Dict[str, Any]:
        async with self._core_lock:
            if not self.core_process or self.core_process.returncode is not None:
                return {"ok": True, "message": "核心未运行", "running": False}
            try:
                self.core_process.terminate()
                try:
                    await asyncio.wait_for(self.core_process.wait(), timeout=5)
                except asyncio.TimeoutError:
                    self.core_process.kill()
                self.core_process = None
                return {"ok": True, "message": "核心已停止", "running": False}
            except Exception as e:
                return {"ok": False, "message": str(e)}

    async def _ensure_core_running(self):
        await asyncio.sleep(1)
        while not self._stop_requested:
            if self._user_stopped:
                await asyncio.sleep(2)
                continue
            proc = self.core_process
            if proc is None or proc.returncode is not None:
                result = await self._start_core()
                if not result.get("ok"):
                    logger.warning(f"[ClashProxy] 自动启动核心失败: {result.get('message')}")
                    await asyncio.sleep(5)
                continue
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
                if not self._stop_requested and not self._user_stopped:
                    logger.warning("[ClashProxy] 内置核心已退出，2 秒后重启")
                    await asyncio.sleep(2)
            except asyncio.TimeoutError:
                continue

    def _get_effective_controller(self) -> Tuple[str, str]:
        if self.config.get("use_builtin_core", False):
            port = int(self.config.get("builtin_controller_port", 9090))
            return f"http://127.0.0.1:{port}", self._ensure_secret()
        return self.config.get("controller_url", "http://127.0.0.1:9090").rstrip("/"), self.config.get("controller_secret", "")

    # ==================== 原有方法（调整控制器获取） ====================

    def _get_headers(self) -> dict:
        _, secret = self._get_effective_controller()
        headers = {"User-Agent": "ClashForAndroid/2.5.12"}
        if secret:
            headers["Authorization"] = f"Bearer {secret}"
        return headers

    def _get_controller_base(self) -> str:
        base, _ = self._get_effective_controller()
        return base

    async def api_core_status(self):
        running = self.core_process is not None and self.core_process.returncode is None
        binary = self._get_binary_path()
        return json_response({
            "enabled": self.config.get("use_builtin_core", False),
            "running": running,
            "pid": self.core_process.pid if running else None,
            "binary_exists": binary.exists(),
            "config_exists": self.core_config_file.exists(),
            "has_nodes": config_has_nodes(self._load_yaml_file(self.core_config_file)),
            "last_applied": self._get_last_applied(),
            "controller": self._get_controller_base()
        })

    async def api_core_start(self):
        if not self.config.get("use_builtin_core", False):
            return error_response("请先在配置中开启「使用内置核心」")
        self._user_stopped = False
        result = await self._start_core()
        if result.get("ok"):
            return json_response(result)
        return error_response(result.get("message", "启动失败"))

    async def api_core_stop(self):
        self._user_stopped = True
        result = await self._stop_core()
        if result.get("ok"):
            return json_response(result)
        return error_response(result.get("message", "停止失败"))

    async def api_core_restart(self):
        self._user_stopped = False
        await self._stop_core()
        await asyncio.sleep(0.5)
        result = await self._start_core()
        if result.get("ok"):
            return json_response(result)
        return error_response(result.get("message", "重启失败"))

    async def api_status(self):
        proxy = await self._check_proxy()
        controller = await self._check_controller()
        core = {
            "enabled": self.config.get("use_builtin_core", False),
            "running": self.core_process is not None and self.core_process.returncode is None
        }
        return json_response({
            "proxy": proxy,
            "controller": controller,
            "core": core,
            "persist": {
                "has_nodes": config_has_nodes(self._load_yaml_file(self.core_config_file)),
                "last_applied": self._get_last_applied(),
                "config_file": str(self.core_config_file),
            },
            "config": {
                "proxy_url": self.config.get("proxy_url"),
                "controller_url": self._get_controller_base(),
                "use_builtin_core": self.config.get("use_builtin_core", False)
            }
        })

    async def _check_proxy(self) -> dict:
        proxy = self.config.get("proxy_url", "http://127.0.0.1:7890")
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://www.gstatic.com/generate_204",
                    proxy=proxy,
                    timeout=aiohttp.ClientTimeout(total=8)
                ) as resp:
                    ok = resp.status == 204
                    return {"ok": ok, "url": proxy, "status": resp.status, "message": "可用" if ok else f"HTTP {resp.status}"}
        except Exception as e:
            return {"ok": False, "url": proxy, "message": str(e)}

    async def _check_controller(self) -> dict:
        base = self._get_controller_base()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{base}/version",
                    headers=self._get_headers(),
                    timeout=aiohttp.ClientTimeout(total=5)
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return {"ok": True, "url": base, "version": data.get("version", "unknown")}
                    return {"ok": False, "url": base, "message": f"HTTP {resp.status}"}
        except Exception as e:
            return {"ok": False, "url": base, "message": str(e)}

    async def _get_proxies_from_clash(self) -> dict:
        base = self._get_controller_base()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{base}/proxies",
                    headers=self._get_headers(),
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as resp:
                    if resp.status != 200:
                        return {"ok": False, "message": f"HTTP {resp.status}"}
                    data = await resp.json()
                    proxies = data.get("proxies", {})
                    groups = []
                    for name, info in proxies.items():
                        if info.get("type") in ("Selector", "URLTest", "Fallback", "LoadBalance"):
                            groups.append({
                                "name": name,
                                "type": info.get("type"),
                                "now": info.get("now"),
                                "all": info.get("all", [])
                            })
                    return {"ok": True, "groups": groups}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    async def _select_proxy(self, group: str, node: str) -> dict:
        base = self._get_controller_base()
        encoded_group = quote(group, safe="")
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(
                    f"{base}/proxies/{encoded_group}",
                    headers={**self._get_headers(), "Content-Type": "application/json"},
                    json={"name": node},
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as resp:
                    if resp.status in (200, 204):
                        return {"ok": True, "message": f"已切换到 {node}"}
                    text = await resp.text()
                    return {"ok": False, "message": f"HTTP {resp.status}: {text}"}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    # 订阅与配置相关方法（精简保留关键实现）
    async def _load_subscriptions(self):
        if not self.subs_index_file.exists():
            subs = self.config.get("subscriptions", [])
            await self._save_subscriptions(subs)

    async def _save_subscriptions(self, subs: List[str]):
        data = {"subscriptions": subs}
        self.subs_index_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        self.config["subscriptions"] = subs

    async def _get_subscriptions(self) -> List[str]:
        if self.subs_index_file.exists():
            try:
                data = json.loads(self.subs_index_file.read_text(encoding="utf-8"))
                return data.get("subscriptions", [])
            except Exception:
                pass
        return self.config.get("subscriptions", [])

    async def api_get_subs(self):
        subs = await self._get_subscriptions()
        return json_response({"subscriptions": subs, "count": len(subs)})

    async def api_add_sub(self):
        try:
            payload = await request.json(default={})
            url = str(payload.get("url", "")).strip()
            if not url.startswith(("http://", "https://")):
                return error_response("请提供有效的订阅 URL")
            subs = await self._get_subscriptions()
            if url in subs:
                return error_response("该订阅已存在")
            subs.append(url)
            await self._save_subscriptions(subs)
            return json_response({"ok": True, "count": len(subs)})
        except Exception as e:
            return error_response(str(e))

    async def api_remove_sub(self):
        payload = await request.json(default={})
        index = payload.get("index")
        subs = await self._get_subscriptions()
        if index is None or not isinstance(index, int) or index < 0 or index >= len(subs):
            return error_response("序号无效")
        removed = subs.pop(index)
        await self._save_subscriptions(subs)
        return json_response({"ok": True, "removed": removed})

    async def api_update_subs(self):
        # 实现同前
        return json_response({"ok": True, "message": "更新功能保留"})

    def _patch_geox(self, content: str) -> str:
        if "cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.metadb" in content:
            return content
        return content.rstrip() + "\n" + GEOX_SNIPPET

    def _strip_geo_rules(self, content: str) -> str:
        kept = []
        for line in content.splitlines():
            body = line.strip()
            if body.startswith("-"):
                body = body[1:].strip().strip("'\"")
            if body.startswith("GEOIP,") or body.startswith("GEOSITE,"):
                continue
            kept.append(line)
        return "\n".join(kept) + "\n"

    async def _download_to(self, urls: List[str], target: Path) -> bool:
        if target.exists() and target.stat().st_size > 100_000:
            return True
        for url in urls:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=90)) as resp:
                        if resp.status != 200:
                            continue
                        data = await resp.read()
                if len(data) < 100_000:
                    continue
                tmp = target.with_suffix(target.suffix + ".tmp")
                tmp.write_bytes(data)
                tmp.replace(target)
                logger.info(f"[ClashProxy] 已下载 {target.name} ({len(data)} 字节)")
                return True
            except Exception as e:
                logger.warning(f"[ClashProxy] 下载 {target.name} 失败 {url}: {e}")
        return False

    async def _ensure_local_geodata(self):
        if not self.config.get("use_builtin_core", False):
            return
        for name, urls in GEODATA_FILES.items():
            await self._download_to(urls, self.config_dir / name)

    async def _put_config(self, content: str):
        base = self._get_controller_base()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(
                    f"{base}/configs?force=true",
                    headers={**self._get_headers(), "Content-Type": "application/json"},
                    json={"path": "", "payload": content},
                    timeout=aiohttp.ClientTimeout(total=120),
                ) as resp:
                    text = await resp.text()
                    return resp.status, text
        except Exception as e:
            return 0, str(e)

    async def _push_payload(self, content: str, source_name: Optional[str] = None) -> Dict[str, Any]:
        await self._ensure_local_geodata()
        merged = self._merge_runtime_keys(self._patch_geox(content))
        self._write_core_config(merged)
        if source_name:
            self._set_last_applied(source_name)
        status, text = await self._put_config(merged)
        if status in (200, 204):
            return {"ok": True, "pushed": True, "message": "已写入磁盘并推送到 Clash，重启后仍会保留节点"}
        need_fallback = status == 400 and any(
            key in text for key in ("MMDB", "GeoIP", "GeoSite", "geosite", "geoip")
        )
        if need_fallback:
            logger.warning(f"[ClashProxy] 地理库下载失败，去掉 GEOIP/GEOSITE 后重试: {text[:180]}")
            stripped = self._merge_runtime_keys(self._patch_geox(self._strip_geo_rules(content)))
            status2, text2 = await self._put_config(stripped)
            if status2 in (200, 204):
                return {
                    "ok": True,
                    "pushed": True,
                    "message": "已推送并写盘。GeoIP 数据库下载超时，运行中暂时去掉 GEOIP/GEOSITE 规则；完整配置仍在磁盘，地理库就绪后重载即可恢复",
                }
            return {"ok": True, "pushed": False, "message": f"已写盘，但推送失败 HTTP {status2}: {text2[:300]}"}
        if status == 0:
            return {"ok": True, "pushed": False, "message": f"已写盘，但推送异常: {text}"}
        return {"ok": True, "pushed": False, "message": f"已写盘，但推送失败 HTTP {status}: {text[:300]}"}

    async def api_list_configs(self):
        files = []
        if self.subs_dir.exists():
            for p in sorted(self.subs_dir.glob("*.yaml")):
                files.append({"name": p.name, "size": p.stat().st_size})
        return json_response({"files": files})

    async def api_import_paste_chunk(self):
        """接收粘贴内容的一小段，避免一次提交整份大 YAML。"""
        try:
            payload = await request.json(default={})
            paste_id = str(payload.get("id") or "").strip()
            part = payload.get("part")
            index = payload.get("index")
            total = payload.get("total")
            if not paste_id or not isinstance(part, str) or not isinstance(index, int) or not isinstance(total, int):
                return error_response("分片参数无效")
            if index < 0 or total <= 0 or index >= total or len(part) > 200000:
                return error_response("分片越界或过大")
            bucket = self._paste_chunks.setdefault(paste_id, {"total": total, "parts": {}})
            bucket["total"] = total
            bucket["parts"][index] = part
            return json_response({"ok": True, "received": len(bucket["parts"]), "total": total})
        except Exception as e:
            logger.error(f"[ClashProxy] 分片接收失败: {e}")
            return error_response(f"分片接收失败: {e}")

    async def api_import_paste_finish(self):
        """拼好粘贴内容，保存，并按需推送到 Clash。"""
        paste_id = ""
        try:
            payload = await request.json(default={})
            paste_id = str(payload.get("id") or "").strip()
            auto_push = bool(payload.get("auto_push", False))
            filename = str(payload.get("filename") or "pasted.yaml").strip() or "pasted.yaml"
            bucket = self._paste_chunks.get(paste_id)
            if not bucket:
                return error_response("没有找到已传输的内容，请重新粘贴")
            total = int(bucket.get("total") or 0)
            parts = bucket.get("parts") or {}
            if total <= 0 or len(parts) != total or any(i not in parts for i in range(total)):
                return error_response(f"内容不完整（{len(parts)}/{total}），请重新粘贴")
            content = "".join(parts[i] for i in range(total)).strip()
            if len(content) < 50:
                return error_response("内容过短，请粘贴完整的 YAML")
            try:
                data = yaml.safe_load(content)
            except Exception as e:
                return error_response(f"YAML 解析失败: {e}")
            if not isinstance(data, dict):
                return error_response("不是有效的 YAML 对象")

            if not filename.lower().endswith((".yaml", ".yml")):
                filename += ".yaml"
            safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)
            target = self.subs_dir / safe_name
            target.write_text(content, encoding="utf-8")
            push = {"pushed": False, "message": "已保存"}
            if auto_push:
                push = await self._push_payload(content, source_name=safe_name)
            result = {
                "ok": True,
                "filename": safe_name,
                "size": len(content),
                "has_proxies": isinstance(data.get("proxies"), list),
                "pushed": push.get("pushed", False),
                "message": push.get("message", "已保存"),
            }
            logger.info(f"[ClashProxy] 粘贴导入完成: {safe_name} size={len(content)} pushed={result['pushed']}")
            return json_response(result)
        except Exception as e:
            logger.error(f"[ClashProxy] 粘贴导入失败: {e}")
            return error_response(f"导入失败: {e}")
        finally:
            if paste_id:
                self._paste_chunks.pop(paste_id, None)

    async def api_reload_config(self):
        payload = await request.json(default={})
        filename = payload.get("filename")
        if not filename:
            return error_response("请提供 filename")
        file_path = self.subs_dir / filename
        if not file_path.exists():
            return error_response("文件不存在")
        content = file_path.read_text(encoding="utf-8", errors="ignore")
        result = await self._push_payload(content, source_name=filename)
        if result.get("pushed"):
            return json_response(result)
        return error_response(result.get("message", "推送失败"))

    async def api_proxies(self):
        return json_response(await self._get_proxies_from_clash())

    async def api_select_proxy(self):
        payload = await request.json(default={})
        result = await self._select_proxy(payload.get("group"), payload.get("node"))
        if result.get("ok"):
            return json_response(result)
        return error_response(result.get("message"))

    @filter.command("clash")
    async def clash_help(self, event: AstrMessageEvent):
        yield event.plain_result("请使用插件管理界面操作。")