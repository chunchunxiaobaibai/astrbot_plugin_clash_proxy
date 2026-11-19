const bridge = window.AstrBotPluginView;
const modeNames = { rule: "规则", global: "全局", direct: "直连" };
const yamlStatus = {
  running: "当前 YAML",
  saved: "已保存到内置核心（未运行）",
  last_applied: "面板最后推送的 YAML",
  legacy: "上次记录的 YAML（旧版记录）",
};

async function init() {
  try {
    const context = await bridge.ready();
    setTheme(context || bridge.getContext?.());
    bridge.onContext?.(setTheme);
    bindNavigation();
    bindEvents();
    await refreshAll();
  } catch (e) {
    console.error("[ClashProxy] Init failed", e);
    document.getElementById("status").textContent = `初始化失败：${e.message || e}`;
  }
}

function setTheme(context) {
  document.documentElement.dataset.theme = context?.isDark ? "dark" : "light";
}

function bindNavigation() {
  const navigation = document.querySelector(".navigation");
  const tabs = [...navigation.querySelectorAll('[role="tab"]')];

  function activateTab(active) {
    for (const tab of tabs) {
      const selected = tab === active;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
    }
    window.scrollTo(0, 0);
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab));
  }
  navigation.addEventListener("keydown", event => {
    const current = tabs.indexOf(event.target);
    const steps = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (current === -1) return;
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if (steps[event.key]) next = (current + steps[event.key] + tabs.length) % tabs.length;
    else return;
    event.preventDefault();
    activateTab(tabs[next]);
    tabs[next].focus();
  });
}

function bindEvents() {
  document.getElementById("btn-refresh-status")?.addEventListener("click", () =>
    Promise.allSettled([refreshStatus(), refreshConfigs()])
  );
  document.getElementById("btn-refresh-proxies")?.addEventListener("click", refreshProxies);
  document.getElementById("btn-refresh-subs")?.addEventListener("click", refreshSubs);
  document.getElementById("btn-add-sub")?.addEventListener("click", addSub);
  document.getElementById("btn-update-subs")?.addEventListener("click", updateSubs);
  document.getElementById("btn-import-paste")?.addEventListener("click", () => importPaste(true));
  document.getElementById("btn-import-save-only")?.addEventListener("click", () => importPaste(false));
  document.getElementById("btn-refresh-configs")?.addEventListener("click", refreshConfigs);
  document.getElementById("group-filter").addEventListener("input", filterGroups);

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
    const mode = modeNames[c.mode] || c.mode || "未知";
    const controllerDetail = c.ok ? `转发模式：${mode}` : c.message;
    el.innerHTML = `
      <div class="status-item">
        <div class="status-heading">
          <strong>应用代理地址</strong>
          <span class="badge ${p.ok ? "ok" : "error"}">${p.ok ? "可用" : "不可用"}</span>
        </div>
        <code class="status-address">${escapeHtml(p.url || "—")}</code>
        ${!p.ok && p.message ? `<div class="status-meta error">${escapeHtml(p.message)}</div>` : ""}
      </div>
      <div class="status-item">
        <div class="status-heading">
          <strong>控制器</strong>
          <span class="badge ${c.ok ? "ok" : "error"}">${c.ok ? "在线" : "不可用"}</span>
        </div>
        <code class="status-address">${escapeHtml(c.url || "—")}</code>
        ${controllerDetail ? `<div class="status-meta ${c.ok ? "muted" : "error"}">${escapeHtml(controllerDetail)}</div>` : ""}
        ${c.ok && c.version ? `<div class="status-meta muted">${escapeHtml(c.version)}</div>` : ""}
      </div>
      <div class="status-item">
        <div class="status-heading"><strong>本地配置备份</strong></div>
        <div class="status-meta muted">${persist.has_nodes ? "已保存节点配置" : "暂无节点配置"}</div>
      </div>
    `;
  } catch (e) {
    console.error("[ClashProxy] status error", e);
    el.innerHTML = `<div class="error">状态获取失败: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

async function refreshProxies() {
  const el = document.getElementById("groups");
  const overview = document.getElementById("route-overview");
  el.innerHTML = "加载中...";
  filterGroups();
  try {
    const data = await bridge.apiGet("proxies");
    if (!data.ok) throw new Error(data.message || "控制器不可用");
    const groups = new Map((data.groups || []).map(group => [group.name, group]));
    if (data.mode === "global") {
      overview.textContent = groups.has("GLOBAL")
        ? `全局线路：${groupPath("GLOBAL", groups).join(" → ")}`
        : "全局模式，控制器未返回 GLOBAL 策略组";
    } else if (data.mode === "rule") {
      overview.textContent = "规则模式：不同目标按 YAML 规则选择策略组，下面显示各组的当前选择。";
    } else {
      overview.textContent = data.mode === "direct" ? "直连模式：DIRECT" : "转发模式未知";
    }
    el.innerHTML = groups.size
      ? [...groups.values()].map(g => renderGroup(g, groups)).join("")
      : '<div class="muted">控制器未返回策略组。</div>';
    el.querySelectorAll(".node-select").forEach(sel => {
      sel.addEventListener("change", () => selectNode(sel));
    });
    filterGroups();
    return data.groups || [];
  } catch (e) {
    console.error("[ClashProxy] proxies error", e);
    overview.textContent = "暂时无法读取转发线路";
    el.innerHTML = `<div class="error">获取节点失败: ${escapeHtml(e.message || String(e))}</div>`;
    return null;
  }
}

function groupPath(name, groups) {
  const path = [];
  const seen = new Set();
  while (name) {
    if (seen.has(name)) return [...path, "循环引用"];
    seen.add(name);
    path.push(name);
    const group = groups.get(name);
    if (group?.type === "LoadBalance") return [...path, "按连接分配"];
    if (group && !group.now) return [...path, "当前节点未知"];
    name = group?.now;
  }
  return path;
}

function renderGroup(g, groups) {
  const current = g.type === "LoadBalance"
    ? "按连接分配"
    : groupPath(g.name, groups).slice(1).join(" → ");
  const selectionLabel = g.type === "Selector" ? "已选" : g.fixed ? "固定后当前线路" : "自动选路";
  const members = g.all || [];
  const options = members.map(n =>
    `<option value="${escapeHtml(n)}" ${n === g.now ? "selected" : ""}>${escapeHtml(n)}</option>`
  ).join("");
  const placeholder = members.includes(g.now) ? "" : '<option value="" disabled selected>请选择节点</option>';
  const control = g.type !== "LoadBalance" && options
    ? `<select class="node-select" aria-label="${escapeHtml(g.name)}的节点"
               data-group="${escapeHtml(g.name)}" data-current="${escapeHtml(members.includes(g.now) ? g.now : "")}">
         ${placeholder}${options}
       </select>`
    : "";
  return `
    <div class="group" data-search="${escapeHtml(`${g.name} ${current}`)}">
      <div class="group-header">
        <strong>${escapeHtml(g.name)}</strong>
        <span class="badge">${escapeHtml(g.type || "")}</span>
      </div>
      <div class="group-current">${selectionLabel} <strong>${escapeHtml(current)}</strong></div>
      ${control}
    </div>
  `;
}

function filterGroups() {
  const query = document.getElementById("group-filter").value.trim().toLowerCase();
  const rows = [...document.querySelectorAll("#groups .group")];
  rows.forEach(row => { row.hidden = !row.dataset.search.toLowerCase().includes(query); });
  document.getElementById("no-matching-groups").hidden = !rows.length || rows.some(row => !row.hidden);
}

async function selectNode(selectEl) {
  const { group, current } = selectEl.dataset;
  const node = selectEl.value;
  const controls = document.querySelectorAll("#groups .node-select, #btn-refresh-proxies");
  controls.forEach(control => { control.disabled = true; });
  showNodeMsg(`正在更新「${group}」的选择…`);
  try {
    const res = await bridge.apiPost("proxies/select", { group, node });
    if (!res?.ok) throw new Error(res?.message || "切换失败");
    const groups = await refreshProxies();
    const confirmed = groups?.find(entry => entry.name === group)?.now;
    showNodeMsg(confirmed
      ? `「${group}」当前选择：${confirmed}`
      : "控制器已接收切换，请刷新节点列表确认当前选择。", !confirmed);
  } catch (e) {
    selectEl.value = current;
    showNodeMsg(`「${group}」切换失败：${e.message || e}`, true);
  } finally {
    controls.forEach(control => { control.disabled = false; });
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
    const source = applied?.kind === "subscription" ? applied.url || "已从列表删除的订阅" : "暂无链接订阅记录";
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
    await refreshAll();
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
  const active = document.getElementById("yaml-active");
  const overview = document.getElementById("overview-yaml");
  try {
    const data = await bridge.apiGet("configs/list");
    const files = data.files || [];
    const applied = data.applied;
    const label = applied ? yamlStatus[applied.status] || "应用记录" : "";
    const summary = applied ? `${label}：${applied.filename}` : "暂无本地 YAML 应用记录";
    active.textContent = summary;
    overview.textContent = summary;
    if (files.length === 0) {
      el.innerHTML = `<div class="muted">暂无本地配置文件</div>`;
      return;
    }
    el.innerHTML = files.map(f => `
      <div class="sub-item${f.name === applied?.filename ? " active-config" : ""}">
        <div class="sub-url">
          ${f.name === applied?.filename ? `<strong class="sub-active">${escapeHtml(label)}</strong>` : ""}
          <span>${escapeHtml(f.name)} <small>(${(f.size / 1024).toFixed(1)} KB)</small></span>
        </div>
        <button class="btn primary small" data-filename="${escapeHtml(f.name)}">
          ${f.name === applied?.filename ? "重新推送" : "推送到 Clash"}
        </button>
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
    active.textContent = "暂时无法读取 YAML 应用记录";
    overview.textContent = active.textContent;
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
      await refreshAll();
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
  const content = textarea.value.replace(/^\uFEFF/, "");
  if (content.trim().length < 50) {
    showConfigMsg("请粘贴完整的 Clash/Mihomo YAML 配置", true);
    textarea.focus();
    return;
  }
  const nameInput = document.getElementById("yaml-name");
  const filename = nameInput.value.trim() || "pasted.yaml";
  const pushButton = document.getElementById("btn-import-paste");
  const saveButton = document.getElementById("btn-import-save-only");
  const btn = autoPush ? pushButton : saveButton;
  const original = btn.textContent;

  pushButton.disabled = true;
  saveButton.disabled = true;
  btn.textContent = "传输中…";

  try {
    const CHUNK = 80000;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const total = Math.ceil(content.length / CHUNK);

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
      filename
    });
    console.log("[ClashProxy] paste finish", res);
    if (res && res.ok) {
      showConfigMsg(`${res.filename || filename} · ${res.message || "已保存"}`, autoPush && !res.pushed);
      textarea.value = "";
      nameInput.value = "pasted.yaml";
      if (res.pushed) await refreshAll();
      else await refreshConfigs();
    } else {
      showConfigMsg((res && (res.message || res.error)) || "导入失败", true);
    }
  } catch (e) {
    console.error("[ClashProxy] paste import error", e);
    showConfigMsg("导入失败: " + (e && e.message ? e.message : e), true);
  } finally {
    pushButton.disabled = false;
    saveButton.disabled = false;
    btn.textContent = original;
  }
}

function showNodeMsg(text, isError = false) {
  const el = document.getElementById("node-message");
  el.textContent = text;
  el.className = "message " + (isError ? "error" : "ok");
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
