const bridge = window.AstrBotPluginView;
const modeNames = { rule: "规则", global: "全局", direct: "直连" };

async function init() {
  try {
    await bridge.ready();
    console.log("[ClashProxy] Bridge ready", bridge.getContext?.());
    document.title = "Clash Proxy 管理";
    bindEvents();
    await refreshAll();
  } catch (e) {
    console.error("[ClashProxy] Init failed", e);
    document.body.innerHTML = `<div style="padding:20px;color:red">初始化失败: ${e.message || e}</div>`;
  }
}

function bindEvents() {
  document.getElementById("btn-refresh-status")?.addEventListener("click", refreshStatus);
  document.getElementById("btn-refresh-proxies")?.addEventListener("click", refreshProxies);
  document.getElementById("btn-refresh-subs")?.addEventListener("click", refreshSubs);
  document.getElementById("btn-add-sub")?.addEventListener("click", addSub);
  document.getElementById("btn-update-subs")?.addEventListener("click", updateSubs);
  document.getElementById("btn-import-paste")?.addEventListener("click", () => importPaste(true));
  document.getElementById("btn-import-save-only")?.addEventListener("click", () => importPaste(false));
  document.getElementById("btn-refresh-configs")?.addEventListener("click", refreshConfigs);

  // 回车也触发添加
  document.getElementById("sub-url")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSub();
  });
}

async function refreshAll() {
  await Promise.allSettled([refreshStatus(), refreshProxies(), refreshSubs(), refreshConfigs()]);
}

async function refreshStatus() {
  const el = document.getElementById("status");
  if (!el) return;
  el.innerHTML = "加载中...";
  try {
    const data = await bridge.apiGet("status");
    const p = data.proxy || {};
    const c = data.controller || {};
    const persist = data.persist || {};
    const persistClass = persist.has_nodes ? "ok" : "";
    const mode = c.mode ? modeNames[c.mode.toLowerCase()] || c.mode : "未知";
    const modeLine = c.ok ? `<br>转发模式：${escapeHtml(mode)}` : "";
    el.innerHTML = `
      <div class="status-item ${p.ok ? "ok" : "error"}">
        <strong>应用代理地址</strong><br>${escapeHtml(p.url || "-")}<br>${escapeHtml(p.message || (p.ok ? "可用" : "不可用"))}
      </div>
      <div class="status-item ${c.ok ? "ok" : "error"}">
        <strong>控制器</strong><br>${escapeHtml(c.url || "-")}<br>${escapeHtml(c.version || c.message || (c.ok ? "可用" : "不可用"))}${modeLine}
      </div>
      <div class="status-item persist ${persistClass}">
        <strong>本地配置备份</strong><br>${persist.has_nodes ? "已保存节点配置" : "暂无节点配置"}
      </div>
    `;
  } catch (e) {
    console.error("[ClashProxy] status error", e);
    el.innerHTML = `<div class="error">状态获取失败: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

async function refreshProxies() {
  const el = document.getElementById("groups");
  if (!el) return;
  el.innerHTML = "加载中...";
  try {
    const data = await bridge.apiGet("proxies");
    if (!data.ok) {
      el.innerHTML = `<div class="error">无法获取节点: ${escapeHtml(data.message || "控制器不可用")}</div>`;
      return;
    }
    if (!data.groups || data.groups.length === 0) {
      el.innerHTML = `<div class="muted">未找到策略组。请确认 Clash 已运行且控制器可访问。</div>`;
      return;
    }
    el.innerHTML = data.groups.map(g => renderGroup(g)).join("");
    el.querySelectorAll(".node-select").forEach(sel => {
      sel.addEventListener("change", async (ev) => {
        const group = ev.target.dataset.group;
        const node = ev.target.value;
        await selectNode(group, node, ev.target);
      });
    });
  } catch (e) {
    console.error("[ClashProxy] proxies error", e);
    el.innerHTML = `<div class="error">获取节点失败: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

function renderGroup(g) {
  const options = (g.all || []).map(n =>
    `<option value="${escapeHtml(n)}" ${n === g.now ? "selected" : ""}>${escapeHtml(n)}</option>`
  ).join("");
  return `
    <div class="group">
      <div class="group-header">
        <strong>${escapeHtml(g.name)}</strong>
        <span class="badge">${escapeHtml(g.type || "")}</span>
        <span class="now">当前: ${escapeHtml(g.now || "-")}</span>
      </div>
      <select class="node-select" data-group="${escapeHtml(g.name)}">
        ${options}
      </select>
    </div>
  `;
}

async function selectNode(group, node, selectEl) {
  selectEl.disabled = true;
  try {
    const res = await bridge.apiPost("proxies/select", { group, node });
    if (res && res.ok) {
      const nowSpan = selectEl.closest(".group")?.querySelector(".now");
      if (nowSpan) nowSpan.textContent = `当前: ${node}`;
      showMsg(`已切换到 ${node}`);
    } else {
      alert("切换失败: " + (res?.message || "未知错误"));
    }
  } catch (e) {
    console.error("[ClashProxy] select error", e);
    alert("切换失败: " + (e.message || e));
  } finally {
    selectEl.disabled = false;
  }
}

async function refreshSubs() {
  const el = document.getElementById("subs-list");
  const current = document.getElementById("applied-config");
  try {
    const data = await bridge.apiGet("subscriptions");
    const subs = data.subscriptions || [];
    const applied = data.applied;
    const label = !data.builtin ? "面板最后应用" : data.running ? "当前配置" : "内置核心已保存（未运行）";
    const source = applied?.kind === "subscription"
      ? applied.url || "已从列表删除的订阅"
      : applied?.name || "暂无应用记录";
    current.textContent = `${label}：${source}`;
    if (subs.length === 0) {
      el.innerHTML = `<div class="muted">暂无订阅</div>`;
      return;
    }
    el.innerHTML = subs.map((url, i) => {
      const active = url === applied?.url;
      const activeLabel = data.builtin && data.running ? "当前订阅" : "已应用";
      return `
      <div class="sub-item" data-index="${i}">
        <div class="sub-url">
          ${active ? `<strong class="sub-active">${activeLabel}</strong>` : ""}
          <span>${escapeHtml(url)}</span>
        </div>
        <div class="sub-item-actions">
          <button class="btn primary small" data-action="apply">${active ? "重新应用" : "应用"}</button>
          <button class="btn danger small" data-action="remove">删除</button>
        </div>
      </div>
    `;
    }).join("");
    el.querySelectorAll(".sub-item").forEach(row => {
      const url = subs[Number(row.dataset.index)];
      const apply = row.querySelector('[data-action="apply"]');
      const remove = row.querySelector('[data-action="remove"]');
      apply.addEventListener("click", () => applySub(url, apply));
      remove.addEventListener("click", () => {
        if (confirm("确认删除该订阅？")) removeSub(url);
      });
    });
  } catch (e) {
    console.error("[ClashProxy] subs list error", e);
    current.textContent = "";
    el.innerHTML = `<div class="error">加载订阅失败: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

async function applySub(url, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "应用中…";
  showMsg("正在加载订阅并应用到 Mihomo…");
  try {
    const res = await bridge.apiPost("subscriptions/select", { url });
    if (!res?.pushed) throw new Error(res?.message || "应用失败");
    showMsg(res.message || "已应用订阅");
    await Promise.allSettled([refreshSubs(), refreshProxies(), refreshStatus()]);
  } catch (e) {
    showMsg(e.message || String(e), true);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function addSub() {
  const input = document.getElementById("sub-url");
  const url = (input?.value || "").trim();
  if (!url) {
    showMsg("请输入订阅链接", true);
    return;
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    showMsg("链接必须以 http:// 或 https:// 开头", true);
    return;
  }

  const btn = document.getElementById("btn-add-sub");
  const originalText = btn?.textContent || "添加订阅";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "添加中...";
  }
  showMsg("正在添加...");

  try {
    const res = await bridge.apiPost("subscriptions/add", { url });
    console.log("[ClashProxy] Add response", res);
    if (res && res.ok) {
      if (input) input.value = "";
      showMsg("添加成功");
      await refreshSubs();
    } else {
      showMsg(res?.message || res?.error || "添加失败", true);
    }
  } catch (e) {
    console.error("[ClashProxy] add error", e);
    const msg = e.message || e.error || String(e);
    showMsg("添加失败: " + msg, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

async function removeSub(url) {
  try {
    const res = await bridge.apiPost("subscriptions/remove", { url });
    if (res && res.ok) {
      showMsg("已删除");
      await refreshSubs();
    } else {
      showMsg(res?.message || "删除失败", true);
    }
  } catch (e) {
    console.error("[ClashProxy] remove error", e);
    showMsg("删除失败: " + (e.message || e), true);
  }
}

async function updateSubs() {
  showMsg("正在下载订阅配置…");
  const btn = document.getElementById("btn-update-subs");
  if (btn) btn.disabled = true;
  try {
    const res = await bridge.apiPost("subscriptions/update", {});
    if (res && res.ok) {
      const failures = (res.failures || []).map(f => `第 ${f.index} 条：${f.message}`).join("。");
      const summary = `已下载 ${res.success}/${res.total} 条。点击「应用」或「重新应用」加载配置。`;
      showMsg(failures ? `${summary} ${failures}` : summary, Boolean(failures));
    } else {
      showMsg(res?.message || "更新失败", true);
    }
  } catch (e) {
    console.error("[ClashProxy] update error", e);
    showMsg("更新失败: " + (e.message || e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshConfigs() {
  const el = document.getElementById("configs-list");
  if (!el) return;
  try {
    const data = await bridge.apiGet("configs/list");
    const files = data.files || [];
    if (files.length === 0) {
      el.innerHTML = `<div class="muted">暂无本地配置文件</div>`;
      return;
    }
    el.innerHTML = files.map(f => `
      <div class="sub-item">
        <span class="sub-url">${escapeHtml(f.name)} <small>(${(f.size/1024).toFixed(1)} KB)</small></span>
        <button class="btn primary small" data-filename="${escapeHtml(f.name)}">推送到 Clash</button>
      </div>
    `).join("");
    el.querySelectorAll("button[data-filename]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const filename = btn.dataset.filename;
        if (confirm(`确认将 ${filename} 推送到 Clash 并重载？`)) {
          await reloadConfig(filename, btn);
        }
      });
    });
  } catch (e) {
    console.error("[ClashProxy] configs list error", e);
    el.innerHTML = `<div class="error">加载配置列表失败</div>`;
  }
}

async function reloadConfig(filename, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "推送中...";
  showConfigMsg("正在推送（大文件可能需要几秒）...");
  try {
    const res = await bridge.apiPost("configs/reload", { filename });
    console.log("[ClashProxy] reload response", res);
    if (res && res.ok) {
      showConfigMsg(res.message || "已应用配置");
      await Promise.allSettled([refreshSubs(), refreshProxies(), refreshStatus()]);
    } else {
      const msg = res?.message || res?.error || JSON.stringify(res);
      showConfigMsg("推送失败: " + msg, true);
      console.error("[ClashProxy] reload failed", res);
    }
  } catch (e) {
    console.error("[ClashProxy] reload exception", e);
    const msg = e.message || e.error || String(e);
    showConfigMsg("推送失败: " + msg, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function importPaste(autoPush) {
  const textarea = document.getElementById("yaml-paste");
  const content = (textarea && textarea.value ? textarea.value : "").replace(/^\uFEFF/, "");
  if (!content.trim()) {
    showConfigMsg("请先把完整 YAML 粘贴到文本框", true);
    return;
  }
  if (content.trim().length < 50) {
    showConfigMsg("内容过短，请粘贴完整的 Clash YAML", true);
    return;
  }

  const btn = autoPush
    ? document.getElementById("btn-import-paste")
    : document.getElementById("btn-import-save-only");
  const original = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "传输中...";
  }

  const CHUNK = 80000;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const total = Math.ceil(content.length / CHUNK);

  try {
    for (let i = 0; i < total; i++) {
      const part = content.slice(i * CHUNK, (i + 1) * CHUNK);
      showConfigMsg("正在发送 " + (i + 1) + "/" + total + "（" + content.length + " 字符）");
      const chunkRes = await bridge.apiPost("configs/import-paste/chunk", {
        id: id,
        index: i,
        total: total,
        part: part
      });
      if (!chunkRes || chunkRes.ok === false) {
        throw new Error((chunkRes && (chunkRes.message || chunkRes.error)) || "分片发送失败");
      }
    }
    showConfigMsg(autoPush ? "内容已传到服务器，正在保存并推送..." : "内容已传到服务器，正在保存...");
    const res = await bridge.apiPost("configs/import-paste/finish", {
      id: id,
      auto_push: !!autoPush,
      filename: "pasted.yaml"
    });
    console.log("[ClashProxy] paste finish", res);
    if (res && res.ok) {
      let msg = res.message || "操作完成";
      if (res.pushed) {
        msg += "，节点已更新";
        await Promise.allSettled([refreshSubs(), refreshProxies(), refreshStatus()]);
      }
      const failed = msg.indexOf("失败") >= 0 || msg.indexOf("异常") >= 0;
      showConfigMsg(msg, failed);
      if (textarea) textarea.value = "";
      await refreshConfigs();
    } else {
      showConfigMsg((res && (res.message || res.error)) || "导入失败", true);
    }
  } catch (e) {
    console.error("[ClashProxy] paste import error", e);
    showConfigMsg("导入失败: " + (e && e.message ? e.message : e), true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

function showConfigMsg(text, isError = false) {
  const el = document.getElementById("config-message");
  if (!el) return;
  el.textContent = text;
  el.className = "message " + (isError ? "error" : "ok");
}

function showMsg(text, isError = false) {
  const el = document.getElementById("sub-message");
  if (!el) return;
  el.textContent = text;
  el.className = "message " + (isError ? "error" : "ok");
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .split("&").join("&" + "amp;")
    .split("<").join("&" + "lt;")
    .split(">").join("&" + "gt;")
    .split('"').join("&" + "quot;");
}

init();
