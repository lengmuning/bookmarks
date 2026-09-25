"use strict";

// Admin page for the Worker. Plain DOM, no dependencies: the Worker serves this
// file under a CSP that only allows same-origin scripts. All text reaches the
// page through textContent, never as HTML.

(() => {
  const MAX_LIMIT = 50000;
  const LANG_KEY = "sbs-admin-lang";

  const STRINGS = {
    zh: {
      title: "Safari Bookmarks Sync 管理后台",
      area: "管理后台",
      loading: "正在加载…",
      logout: "退出登录",
      loginTitle: "管理员登录",
      loginHint: "输入 Worker 的 ADMIN_KEY。登录状态保持 12 小时。",
      adminKey: "ADMIN_KEY",
      signIn: "登录",
      usersTitle: "用户与 Access Key",
      sumUsers_other: "{n} 个用户",
      sumBookmarks_other: "{n} 条书签",
      sumDevices_other: "{n} 台设备",
      refresh: "刷新",
      newKey: "新建 Access Key",
      colUser: "用户",
      colStatus: "状态",
      colBookmarks: "书签 / 上限",
      colDevices: "设备",
      colLastActive: "最后活动",
      colCreated: "创建时间",
      colActions: "操作",
      empty: "还没有用户。点击“新建 Access Key”给第一个用户发放 Key。",
      footnote: "每个 Access Key 对应一个用户和一个同步组，用户之间的数据互相隔离。Access Key 只在创建或重置时显示一次。",
      masterName: "你的主 Key",
      masterSub: "ACCESS_KEY · Worker Secret",
      masterTag: "主",
      unnamed: "未命名",
      statusActive: "正常",
      statusIdle: "未使用",
      statusRevoked: "已吊销",
      statusDisabled: "已停用",
      none: "—",
      details: "详情",
      manage: "管理",
      edit: "编辑",
      reset: "重置 Key",
      revoke: "吊销",
      deleteData: "删除数据",
      label: "备注名",
      labelPlaceholder: "例如：张三",
      limit: "书签上限",
      limitHint: "1 到 50000 之间。达到上限后新增的书签不再同步，已有书签不受影响。",
      cancel: "取消",
      create: "创建",
      save: "保存",
      done: "完成",
      close: "关闭",
      copy: "复制",
      copied: "已复制",
      copyInstructions: "复制设置说明",
      accessKey: "Access Key",
      instructions: "发给用户的设置说明",
      keyOnce: "这个 Access Key 只显示这一次，关闭后无法再查看。请现在复制并发给用户。",
      keyCreatedTitle: "已创建 Access Key：{name}",
      keyResetTitle: "已重置 Access Key：{name}",
      instructionsText:
        "Safari Bookmarks Sync 设置信息\n\n" +
        "Worker 地址：{url}\nAccess Key：{key}\n\n" +
        "1. 安装并打开 Mac App，填入上面的 Worker 地址和 Access Key，点 Connect。\n" +
        "2. 按提示允许 App 读取 Safari 书签（只需一次）。\n" +
        "3. 在 Chrome 或 Firefox 扩展里填入 Worker 地址，以及 Mac App 显示的配对码。\n\n" +
        "请妥善保管 Access Key，不要转发给别人。",
      editTitle: "编辑：{name}",
      limitBelowUsage: "当前已有 {count} 条书签，超过新上限。已有书签会保留，但新增的书签不再同步，直到数量降到上限以下。",
      resetTitle: "重置 {name} 的 Access Key？",
      resetMessage: "旧 Key 会立即失效。已连接的设备不受影响，继续同步；以后连接新设备要用新 Key。",
      revokeTitle: "吊销 {name} 的 Access Key？",
      revokeMessage: "这个用户的所有设备会立即停止同步，而且无法恢复。服务器上的书签数据会保留，之后可以删除。",
      deleteTitle: "删除 {name} 的全部同步数据？",
      deleteMessage: "服务器上这个用户的书签记录和设备列表会被永久删除，所有设备停止同步。用户电脑和浏览器里的书签不受影响。",
      deleteMessageActive:
        "服务器上这个用户的书签记录和设备列表会被永久删除，所有设备停止同步。用户电脑和浏览器里的书签不受影响。" +
        "Access Key 仍然有效，用户重新连接后会从头开始同步。",
      typeToConfirm: "输入“{word}”确认",
      confirmWord: "删除",
      deleteForever: "永久删除",
      created: "已创建",
      saved: "已保存",
      revoked: "已吊销",
      deleted: "已删除",
      factKeyId: "Key ID",
      factGroup: "同步组 ID",
      factNoGroup: "尚未创建（用户还没有连接过）",
      factRevoked: "吊销时间",
      factCreated: "创建时间",
      factBookmarks: "书签",
      factTombstones: "删除记录",
      factTombstonesValue: "{count} 条（保留 90 天，用于把删除同步到各设备）",
      factStorage: "占用空间",
      factDisabled: "停用时间",
      devices: "设备",
      deviceName: "名称",
      deviceType: "类型",
      lastSeen: "最后在线",
      joined: "加入时间",
      noDevices: "没有已连接的设备。",
      platform_safari: "Safari（Mac）",
      platform_chrome: "Chrome",
      platform_firefox: "Firefox",
      errUnauthorized: "ADMIN_KEY 不正确。",
      errRateLimited: "尝试次数过多，请 1 小时后再试。",
      errSession: "登录已过期，请重新登录。",
      errOrigin: "请求来源不正确，请刷新页面后重试。",
      errLimits: "书签上限必须是 1 到 50000 之间的整数。",
      errRevoked: "这个 Key 已吊销，不能重置。",
      errKeyNotFound: "找不到这个 Key，请刷新页面。",
      errGroupNotFound: "这个同步组已经不存在，请刷新页面。",
      errNetwork: "无法连接服务器，请检查网络。",
      errGeneric: "操作失败（{code}）。",
      errConfirm: "输入的内容不一致。",
      errEmptyKey: "请输入 ADMIN_KEY。",
    },
    en: {
      title: "Safari Bookmarks Sync Admin",
      area: "Admin",
      loading: "Loading…",
      logout: "Sign Out",
      loginTitle: "Admin Sign-In",
      loginHint: "Enter the Worker's ADMIN_KEY. You stay signed in for 12 hours.",
      adminKey: "ADMIN_KEY",
      signIn: "Sign In",
      usersTitle: "Users and Access Keys",
      sumUsers_one: "{n} user",
      sumUsers_other: "{n} users",
      sumBookmarks_one: "{n} bookmark",
      sumBookmarks_other: "{n} bookmarks",
      sumDevices_one: "{n} device",
      sumDevices_other: "{n} devices",
      refresh: "Refresh",
      newKey: "New Access Key",
      colUser: "User",
      colStatus: "Status",
      colBookmarks: "Bookmarks / limit",
      colDevices: "Devices",
      colLastActive: "Last active",
      colCreated: "Created",
      colActions: "Actions",
      empty: "No users yet. Click “New Access Key” to issue the first one.",
      footnote:
        "Each access key belongs to one user and one sync group; users never see each other's data. " +
        "A key is shown only when it is created or reset.",
      masterName: "Your master key",
      masterSub: "ACCESS_KEY · Worker secret",
      masterTag: "Master",
      unnamed: "Unnamed",
      statusActive: "Active",
      statusIdle: "Not used yet",
      statusRevoked: "Revoked",
      statusDisabled: "Disabled",
      none: "—",
      details: "Details",
      manage: "Manage",
      edit: "Edit",
      reset: "Reset Key",
      revoke: "Revoke",
      deleteData: "Delete Data",
      label: "Name",
      labelPlaceholder: "For example: Alex",
      limit: "Bookmark limit",
      limitHint: "1 to 50,000. At the limit, new bookmarks stop syncing; existing ones stay.",
      cancel: "Cancel",
      create: "Create",
      save: "Save",
      done: "Done",
      close: "Close",
      copy: "Copy",
      copied: "Copied",
      copyInstructions: "Copy Setup Instructions",
      accessKey: "Access key",
      instructions: "Setup instructions for the user",
      keyOnce: "This access key is shown only once. Copy it now and send it to the user.",
      keyCreatedTitle: "Access key created: {name}",
      keyResetTitle: "Access key reset: {name}",
      instructionsText:
        "Safari Bookmarks Sync setup\n\n" +
        "Worker URL: {url}\nAccess key: {key}\n\n" +
        "1. Install and open the Mac app, enter the Worker URL and access key above, and click Connect.\n" +
        "2. Allow the app to read Safari's bookmarks when asked (only once).\n" +
        "3. In the Chrome or Firefox extension, enter the Worker URL and the pairing code shown by the Mac app.\n\n" +
        "Keep the access key private and don't forward it.",
      editTitle: "Edit: {name}",
      limitBelowUsage:
        "This user already has {count} bookmarks, more than the new limit. They are kept, " +
        "but new bookmarks stop syncing until the count drops below the limit.",
      resetTitle: "Reset the access key of {name}?",
      resetMessage:
        "The old key stops working right away. Connected devices are not affected and keep syncing; " +
        "connecting a new device needs the new key.",
      revokeTitle: "Revoke the access key of {name}?",
      revokeMessage:
        "All of this user's devices stop syncing immediately, and this cannot be undone. " +
        "Their bookmark data stays on the server until you delete it.",
      deleteTitle: "Delete all sync data of {name}?",
      deleteMessage:
        "This user's bookmark records and device list are permanently deleted from the server, and all devices stop syncing. " +
        "Bookmarks on their computers and browsers are not touched.",
      deleteMessageActive:
        "This user's bookmark records and device list are permanently deleted from the server, and all devices stop syncing. " +
        "Bookmarks on their computers and browsers are not touched. The access key stays valid; connecting again starts from scratch.",
      typeToConfirm: "Type “{word}” to confirm",
      confirmWord: "DELETE",
      deleteForever: "Delete Forever",
      created: "Created",
      saved: "Saved",
      revoked: "Revoked",
      deleted: "Deleted",
      factKeyId: "Key ID",
      factGroup: "Sync group ID",
      factNoGroup: "Not created yet (the user hasn't connected)",
      factRevoked: "Revoked",
      factCreated: "Created",
      factBookmarks: "Bookmarks",
      factTombstones: "Deletion records",
      factTombstonesValue: "{count} (kept 90 days to sync deletions to every device)",
      factStorage: "Storage",
      factDisabled: "Disabled",
      devices: "Devices",
      deviceName: "Name",
      deviceType: "Type",
      lastSeen: "Last seen",
      joined: "Joined",
      noDevices: "No connected devices.",
      platform_safari: "Safari (Mac)",
      platform_chrome: "Chrome",
      platform_firefox: "Firefox",
      errUnauthorized: "Wrong ADMIN_KEY.",
      errRateLimited: "Too many attempts. Try again in an hour.",
      errSession: "Your session expired. Please sign in again.",
      errOrigin: "The request came from an unexpected origin. Reload the page and try again.",
      errLimits: "The bookmark limit must be a whole number from 1 to 50,000.",
      errRevoked: "This key is revoked and cannot be reset.",
      errKeyNotFound: "This key no longer exists. Reload the page.",
      errGroupNotFound: "This sync group no longer exists. Reload the page.",
      errNetwork: "Can't reach the server. Check your connection.",
      errGeneric: "Something went wrong ({code}).",
      errConfirm: "The text doesn't match.",
      errEmptyKey: "Enter the ADMIN_KEY.",
    },
  };

  // ------------------------------------------------------------------ helpers

  const $ = id => document.getElementById(id);

  function readStoredLang() {
    try {
      return localStorage.getItem(LANG_KEY);
    } catch {
      return null;
    }
  }

  function storeLang(value) {
    try {
      localStorage.setItem(LANG_KEY, value);
    } catch {
      // Private windows may refuse storage; the choice then lasts this visit.
    }
  }

  let lang = readStoredLang();
  if (!STRINGS[lang]) lang = (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";

  const locale = () => (lang === "zh" ? "zh-CN" : "en");

  function t(key, vars) {
    const text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;
  }

  // Picks key_one / key_other by the plural rules of the current language.
  function tn(key, n) {
    const rule = new Intl.PluralRules(locale()).select(n);
    const name = STRINGS[lang][`${key}_${rule}`] !== undefined ? `${key}_${rule}` : `${key}_other`;
    return t(name, { n: fmtNumber(n) });
  }

  const fmtNumber = n => new Intl.NumberFormat(locale()).format(n);

  function fmtDay(ms) {
    return ms ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(ms)) : t("none");
  }

  function fmtDate(ms) {
    if (!ms) return t("none");
    return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  }

  function fmtRelative(ms) {
    if (!ms) return t("none");
    const seconds = (ms - Date.now()) / 1000;
    const abs = Math.abs(seconds);
    const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
    if (abs < 60) return rtf.format(0, "second");
    if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
    if (abs < 30 * 86400) return rtf.format(Math.round(seconds / 86400), "day");
    return fmtDate(ms);
  }

  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes)) return t("none");
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (name === "class") node.className = value;
      else if (name === "text") node.textContent = value;
      else if (name === "onclick") node.addEventListener("click", value);
      else node.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  function setError(element, message) {
    element.textContent = message || "";
    element.hidden = !message;
  }

  let toastTimer = 0;
  function toast(message, isError = false) {
    const element = $("toast");
    element.textContent = message;
    element.className = isError ? "toast error" : "toast";
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      element.hidden = true;
    }, isError ? 6000 : 3000);
  }

  function parseLimit(value) {
    const n = Number(String(value).trim());
    return Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : null;
  }

  async function copyText(text, fallbackField) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      fallbackField.select();
      document.execCommand("copy");
    }
    toast(t("copied"));
  }

  // ---------------------------------------------------------------------- api

  class ApiError extends Error {
    constructor(code, status) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }

  async function api(method, path, body) {
    let response;
    try {
      response = await fetch(`/admin/api${path}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError("network", 0);
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // Error pages without a JSON body are reported by status.
    }
    if (!response.ok) {
      const code = (data && data.error) || `http_${response.status}`;
      if (code === "session_expired") showLogin(t("errSession"));
      throw new ApiError(code, response.status);
    }
    return data;
  }

  function errorText(error) {
    const messages = {
      unauthorized: "errUnauthorized",
      rate_limited: "errRateLimited",
      session_expired: "errSession",
      bad_origin: "errOrigin",
      invalid_limits: "errLimits",
      key_revoked: "errRevoked",
      key_not_found: "errKeyNotFound",
      group_not_found: "errGroupNotFound",
      network: "errNetwork",
    };
    const code = (error && error.code) || "unknown";
    return messages[code] ? t(messages[code]) : t("errGeneric", { code });
  }

  async function withBusy(button, task) {
    if (button) button.disabled = true;
    try {
      return await task();
    } finally {
      if (button) button.disabled = false;
    }
  }

  // -------------------------------------------------------------------- views

  let data = { keys: [], master_group: null };

  function closeDialogs() {
    for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  }

  function openDialog(dialog) {
    for (const error of dialog.querySelectorAll(".form-error")) setError(error, "");
    dialog.showModal();
  }

  function showLogin(message) {
    closeDialogs();
    $("booting").hidden = true;
    $("app-view").hidden = true;
    $("logout").hidden = true;
    $("login-view").hidden = false;
    setError($("login-error"), message);
    $("admin-key").focus();
  }

  function showApp() {
    $("booting").hidden = true;
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    $("logout").hidden = false;
    render();
    load();
  }

  async function load() {
    try {
      data = await api("GET", "/keys");
      render();
    } catch (error) {
      if (error.code !== "session_expired") toast(errorText(error), true);
    }
  }

  function entries() {
    const list = [];
    if (data.master_group) {
      const g = data.master_group;
      list.push({ master: true, key: null, group: g, usage: g.usage, createdAt: g.created_at, limit: g.usage ? g.usage.max_bookmarks : MAX_LIMIT });
    }
    const keys = [...data.keys].sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at) || b.created_at - a.created_at);
    for (const key of keys) {
      list.push({ master: false, key, group: key.group, usage: key.usage, createdAt: key.created_at, limit: key.max_bookmarks });
    }
    return list;
  }

  const nameOf = entry => (entry.master ? t("masterName") : entry.key.label || t("unnamed"));

  function statusOf(entry) {
    if (!entry.master && entry.key.revoked_at) return ["revoked", t("statusRevoked")];
    if (entry.group && entry.group.disabled_at) return ["disabled", t("statusDisabled")];
    if (!entry.group) return ["idle", t("statusIdle")];
    return ["ok", t("statusActive")];
  }

  function usageCell(entry) {
    const used = entry.usage ? entry.usage.bookmarks : null;
    const text = `${used === null ? t("none") : fmtNumber(used)} / ${fmtNumber(entry.limit)}`;
    const ratio = used === null ? 0 : Math.min(1, used / entry.limit);
    // CSSOM, not a style attribute: the CSP has no 'unsafe-inline'.
    const fill = h("span");
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    return h(
      "td",
      { class: "usage" },
      h("div", { class: "nowrap", text }),
      h("div", { class: ratio >= 1 ? "usage-bar full" : "usage-bar" }, fill),
    );
  }

  function actionsFor(entry) {
    const text = entry.master ? t("details") : t("manage");
    return h("button", { type: "button", class: "link-btn", text, onclick: () => openManage(entry) });
  }

  function render() {
    const list = entries();
    const rows = list.map(entry => {
      const [statusClass, statusText] = statusOf(entry);
      const sub = entry.master ? t("masterSub") : `ID ${entry.key.id.slice(0, 8)}`;
      const lastSeen = entry.usage ? entry.usage.last_seen_at : null;
      return h(
        "tr",
        { class: statusClass === "revoked" ? "inactive" : null },
        h(
          "td",
          { class: "user-cell" },
          h("div", { class: "user-name" }, nameOf(entry), entry.master ? h("span", { class: "badge master", text: t("masterTag") }) : null),
          h("div", { class: "user-sub", text: sub }),
        ),
        h("td", null, h("span", { class: `badge ${statusClass}`, text: statusText })),
        usageCell(entry),
        h("td", { text: entry.usage ? fmtNumber(entry.usage.devices) : t("none") }),
        h("td", { class: "nowrap", title: lastSeen ? fmtDate(lastSeen) : null, text: fmtRelative(lastSeen) }),
        h("td", { class: "nowrap", title: fmtDate(entry.createdAt), text: fmtDay(entry.createdAt) }),
        h("td", { class: "col-actions" }, actionsFor(entry)),
      );
    });
    $("rows").replaceChildren(...rows);
    $("empty").hidden = list.length > 0;

    const bookmarks = list.reduce((sum, e) => sum + (e.usage ? e.usage.bookmarks : 0), 0);
    const devices = list.reduce((sum, e) => sum + (e.usage ? e.usage.devices : 0), 0);
    $("summary").textContent = [tn("sumUsers", list.length), tn("sumBookmarks", bookmarks), tn("sumDevices", devices)].join(" · ");
  }

  function applyLang() {
    document.documentElement.lang = locale();
    document.title = t("title");
    for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const node of document.querySelectorAll("[data-i18n-placeholder]")) node.placeholder = t(node.dataset.i18nPlaceholder);
    for (const button of document.querySelectorAll("[data-lang]")) button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
    if (!$("app-view").hidden) render();
    if (shownKey && $("dlg-key").open) fillKeyDialog();
  }

  // -------------------------------------------------------------- key dialog

  let shownKey = null;

  function fillKeyDialog() {
    $("dlg-key-title").textContent = t(shownKey.titleKey, { name: shownKey.name });
    $("key-value").value = shownKey.key;
    $("key-instructions").value = t("instructionsText", { url: location.origin, key: shownKey.key });
  }

  function showKey(titleKey, name, key) {
    shownKey = { titleKey, name, key };
    fillKeyDialog();
    openDialog($("dlg-key"));
    $("copy-key").focus();
    $("key-value").scrollLeft = 0;
  }

  $("dlg-key").addEventListener("close", () => {
    shownKey = null;
    $("key-value").value = "";
    $("key-instructions").value = "";
  });
  $("copy-key").addEventListener("click", () => copyText($("key-value").value, $("key-value")));
  $("copy-instructions").addEventListener("click", () => copyText($("key-instructions").value, $("key-instructions")));

  // ------------------------------------------------------------------ create

  $("new-key").addEventListener("click", () => {
    $("create-label").value = "";
    $("create-limit").value = String(MAX_LIMIT);
    openDialog($("dlg-create"));
    $("create-label").focus();
  });

  $("create-form").addEventListener("submit", async event => {
    event.preventDefault();
    const dialog = $("dlg-create");
    const error = dialog.querySelector(".form-error");
    const limit = parseLimit($("create-limit").value);
    if (limit === null) return setError(error, t("errLimits"));
    const label = $("create-label").value.trim();
    await withBusy(event.submitter, async () => {
      try {
        const created = await api("POST", "/keys", { label: label || null, max_bookmarks: limit });
        dialog.close();
        showKey("keyCreatedTitle", created.label || t("unnamed"), created.key);
        load();
      } catch (err) {
        setError(error, errorText(err));
      }
    });
  });

  // -------------------------------------------------------------------- edit

  let editing = null;

  function updateEditWarning() {
    const limit = parseLimit($("edit-limit").value);
    const count = editing && editing.usage ? editing.usage.bookmarks : 0;
    const warning = $("edit-warning");
    if (limit !== null && limit < count) {
      warning.textContent = t("limitBelowUsage", { count: fmtNumber(count) });
      warning.hidden = false;
    } else {
      warning.hidden = true;
    }
  }

  function openEdit(entry) {
    editing = entry;
    $("dlg-edit-title").textContent = t("editTitle", { name: nameOf(entry) });
    $("edit-label").value = entry.key.label || "";
    $("edit-limit").value = String(entry.key.max_bookmarks);
    updateEditWarning();
    openDialog($("dlg-edit"));
    $("edit-label").focus();
  }

  $("edit-limit").addEventListener("input", updateEditWarning);

  $("edit-form").addEventListener("submit", async event => {
    event.preventDefault();
    const dialog = $("dlg-edit");
    const error = dialog.querySelector(".form-error");
    const limit = parseLimit($("edit-limit").value);
    if (limit === null) return setError(error, t("errLimits"));
    await withBusy(event.submitter, async () => {
      try {
        await api("PATCH", `/keys/${editing.key.id}`, { label: $("edit-label").value.trim() || null, max_bookmarks: limit });
        dialog.close();
        toast(t("saved"));
        load();
      } catch (err) {
        setError(error, errorText(err));
      }
    });
  });

  // ---------------------------------------------------------------- confirm

  let pending = null;

  function confirmAction({ title, message, okText, danger = true, typed = null, run }) {
    pending = { typed, run };
    $("dlg-confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    const ok = $("confirm-ok");
    ok.textContent = okText;
    ok.className = danger ? "btn btn-danger" : "btn btn-primary";
    $("confirm-typed").hidden = !typed;
    $("confirm-input").value = "";
    if (typed) $("confirm-typed-label").textContent = t("typeToConfirm", { word: typed });
    openDialog($("dlg-confirm"));
    (typed ? $("confirm-input") : $("dlg-confirm").querySelector("[data-close]")).focus();
  }

  $("confirm-form").addEventListener("submit", async event => {
    event.preventDefault();
    const dialog = $("dlg-confirm");
    const error = dialog.querySelector(".form-error");
    if (!pending) return;
    if (pending.typed && $("confirm-input").value.trim() !== pending.typed) return setError(error, t("errConfirm"));
    await withBusy(event.submitter, async () => {
      try {
        const after = await pending.run();
        dialog.close();
        if (typeof after === "function") after();
      } catch (err) {
        setError(error, errorText(err));
      }
    });
  });

  function confirmReset(entry) {
    const name = nameOf(entry);
    confirmAction({
      title: t("resetTitle", { name }),
      message: t("resetMessage"),
      okText: t("reset"),
      danger: false,
      run: async () => {
        const reset = await api("POST", `/keys/${entry.key.id}/reset`);
        load();
        return () => showKey("keyResetTitle", name, reset.key);
      },
    });
  }

  function confirmRevoke(entry) {
    confirmAction({
      title: t("revokeTitle", { name: nameOf(entry) }),
      message: t("revokeMessage"),
      okText: t("revoke"),
      run: async () => {
        await api("DELETE", `/keys/${entry.key.id}`);
        toast(t("revoked"));
        load();
      },
    });
  }

  function confirmDelete(entry) {
    const active = !entry.key.revoked_at;
    confirmAction({
      title: t("deleteTitle", { name: nameOf(entry) }),
      message: t(active ? "deleteMessageActive" : "deleteMessage"),
      okText: t("deleteForever"),
      typed: t("confirmWord"),
      run: async () => {
        await api("DELETE", `/groups/${entry.group.pair_id}`);
        toast(t("deleted"));
        load();
      },
    });
  }

  // ----------------------------------------------------------------- details

  async function openManage(entry) {
    let stats = null;
    if (entry.group) {
      try {
        stats = await api("GET", `/groups/${entry.group.pair_id}`);
      } catch (err) {
        if (err.code === "session_expired") return;
        if (err.code !== "group_not_found") return toast(errorText(err), true);
      }
    }

    const [statusClass, statusText] = statusOf(entry);
    $("dlg-details-title").textContent = nameOf(entry);
    $("details-status").className = `badge ${statusClass}`;
    $("details-status").textContent = statusText;

    const mono = text => h("span", { class: "mono", text });
    const facts = [];
    if (!entry.master) facts.push([t("factKeyId"), mono(entry.key.id)]);
    facts.push([t("factCreated"), fmtDate(entry.createdAt)]);
    const used = stats ? fmtNumber(stats.bookmarks) : t("none");
    facts.push([t("factBookmarks"), `${used} / ${fmtNumber(stats ? stats.max_bookmarks : entry.limit)}`]);
    if (stats) {
      facts.push([t("factTombstones"), t("factTombstonesValue", { count: fmtNumber(stats.tombstones) })]);
      facts.push([t("factStorage"), fmtBytes(stats.storage_bytes)]);
    }
    facts.push([t("factGroup"), entry.group ? mono(entry.group.pair_id) : t("factNoGroup")]);
    if (!entry.master && entry.key.revoked_at) facts.push([t("factRevoked"), fmtDate(entry.key.revoked_at)]);
    if (stats && stats.disabled_at) facts.push([t("factDisabled"), fmtDate(stats.disabled_at)]);
    $("details-facts").replaceChildren(...facts.flatMap(([label, value]) => [h("dt", { text: label }), h("dd", null, value)]));

    const devices = stats && Array.isArray(stats.devices) ? stats.devices : [];
    $("details-devices-section").hidden = !stats;
    $("details-devices").replaceChildren(
      ...devices.map(device =>
        h(
          "tr",
          null,
          h("td", { text: device.name || t("none") }),
          h("td", { text: t(`platform_${device.platform}`) }),
          h("td", { class: "nowrap", title: device.last_seen_at ? fmtDate(device.last_seen_at) : null, text: fmtRelative(device.last_seen_at) }),
          h("td", { class: "nowrap", text: fmtDate(device.created_at) }),
        ),
      ),
    );
    $("details-no-devices").hidden = devices.length > 0;
    $("details-devices").closest(".table-wrap").hidden = devices.length === 0;

    // Each action closes this panel and opens its own dialog.
    const action = (key, className, open) =>
      h("button", {
        type: "button",
        class: className,
        text: t(key),
        onclick: () => {
          $("dlg-details").close();
          open(entry);
        },
      });
    const danger = [];
    const safe = [];
    if (!entry.master) {
      const revoked = !!entry.key.revoked_at;
      if (!revoked) danger.push(action("revoke", "btn btn-danger-quiet", confirmRevoke));
      if (entry.group) danger.push(action("deleteData", "btn btn-danger-quiet", confirmDelete));
      if (!revoked) safe.push(action("reset", "btn", confirmReset));
      safe.push(action("edit", "btn", openEdit));
    }
    $("details-danger").replaceChildren(...danger);
    $("details-safe").replaceChildren(...safe);
    openDialog($("dlg-details"));
  }

  // ------------------------------------------------------------ page events

  for (const button of document.querySelectorAll("dialog [data-close]")) {
    button.addEventListener("click", () => button.closest("dialog").close());
  }

  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => {
      lang = button.dataset.lang;
      storeLang(lang);
      applyLang();
    });
  }

  $("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const key = $("admin-key").value.trim();
    if (!key) return setError($("login-error"), t("errEmptyKey"));
    await withBusy(event.submitter, async () => {
      try {
        await api("POST", "/login", { key });
        $("admin-key").value = "";
        setError($("login-error"), "");
        showApp();
      } catch (err) {
        setError($("login-error"), errorText(err));
      }
    });
  });

  $("logout").addEventListener("click", async () => {
    try {
      await api("POST", "/logout");
    } catch {
      // Signed out locally either way.
    }
    data = { keys: [], master_group: null };
    showLogin();
  });

  $("refresh").addEventListener("click", event => withBusy(event.currentTarget, load));

  async function boot() {
    applyLang();
    try {
      const session = await api("GET", "/session");
      if (session.signed_in) showApp();
      else showLogin();
    } catch (err) {
      showLogin(errorText(err));
    }
  }

  boot();
})();
