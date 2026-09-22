(function () {
  "use strict";

  var CONFIG = {
    releaseApi: "/terminal/version/get_last",
    betaApi: "/terminal/version/get_last?channel=beta",
    noticeApi: "/terminal/announcement/get_list?from=-1",
    healthApi: "/healthz",
    manifestApi: "/terminal/update/manifest",
    downloadApi: "/terminal/version/get_download_url?version_code=",
    requestTimeout: 12000,
    fallbackDownload: "/download/BiliTerminal-1.1.8-2026092102-release.apk"
  };

  var state = {
    services: {
      health: null,
      api: null,
      download: null,
      notice: null
    },
    serviceLatencies: {},
    announcements: [],
    announcementsExpanded: false,
    release: null
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var node = byId(id);
    if (node) node.textContent = value;
  }

  function setHref(id, value) {
    var node = byId(id);
    if (node && value) node.setAttribute("href", value);
  }

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function formatDate(seconds, withTime) {
    var date = new Date(Number(seconds) * 1000);
    if (!seconds || isNaN(date.getTime())) return "发布时间未知";
    var text = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
    if (withTime) text += " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    return text;
  }

  function formatBytes(bytes) {
    var value = Number(bytes);
    if (!value || value < 0) return "大小未知";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    return (value / 1024 / 1024).toFixed(2) + " MB";
  }

  function compactText(value, maxLength) {
    var text = String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").replace(/^[-•]\s*/, "").trim();
    if (text.length > maxLength) return text.slice(0, maxLength - 1) + "…";
    return text;
  }

  function request(method, url, callback) {
    var xhr = new XMLHttpRequest();
    var startedAt = Date.now ? Date.now() : new Date().getTime();
    var finished = false;

    function finish(error, data) {
      if (finished) return;
      finished = true;
      var endedAt = Date.now ? Date.now() : new Date().getTime();
      callback(error, data, Math.max(0, endedAt - startedAt), xhr);
    }

    xhr.open(method, url, true);
    xhr.timeout = CONFIG.requestTimeout;
    xhr.setRequestHeader("Cache-Control", "no-cache");
    xhr.onreadystatechange = function () {
      var payload;
      if (xhr.readyState !== 4) return;
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(new Error(xhr.status ? "HTTP " + xhr.status : "网络连接失败"));
        return;
      }
      if (method === "HEAD") {
        finish(null, null);
        return;
      }
      try {
        payload = JSON.parse(xhr.responseText);
      } catch (error) {
        finish(new Error("数据解析失败"));
        return;
      }
      finish(null, payload);
    };
    xhr.onerror = function () { finish(new Error("网络连接失败")); };
    xhr.ontimeout = function () { finish(new Error("请求超时")); };
    xhr.send(null);
  }

  function updateService(name, ok, latency) {
    var row = document.querySelector('[data-service="' + name + '"]');
    state.services[name] = ok;
    if (typeof latency === "number") state.serviceLatencies[name] = latency;
    if (row) {
      row.className = ok ? "is-ok" : "is-error";
      row.getElementsByTagName("strong")[0].textContent = ok ? "正常" : "异常";
      row.getElementsByTagName("small")[0].textContent = typeof latency === "number" ? latency + " ms" : "-- ms";
    }
    updateOverallStatus();
  }

  function updateOverallStatus() {
    var names = ["health", "api", "download", "notice"];
    var completed = 0;
    var errors = 0;
    var latencyTotal = 0;
    var latencyCount = 0;
    var i;
    var global = byId("global-status");
    var summary = byId("system-summary");

    for (i = 0; i < names.length; i += 1) {
      if (state.services[names[i]] !== null) completed += 1;
      if (state.services[names[i]] === false) errors += 1;
      if (typeof state.serviceLatencies[names[i]] === "number") {
        latencyTotal += state.serviceLatencies[names[i]];
        latencyCount += 1;
      }
    }

    if (completed < names.length) {
      setText("global-status-text", "正在检测");
      setText("overview-status", "检测中");
      setText("system-summary-text", "正在检查服务");
      return;
    }

    if (errors > 0) {
      if (global) global.className = "global-status status-error";
      if (summary) summary.className = "system-summary status-error";
      setText("global-status-text", "部分异常");
      setText("overview-status", "部分异常");
      setText("system-summary-text", "部分服务暂时不可用");
    } else {
      if (global) global.className = "global-status status-ok";
      if (summary) summary.className = "system-summary status-ok";
      setText("global-status-text", "服务正常");
      setText("overview-status", "全部正常");
      setText("system-summary-text", "全部系统运行正常");
    }
    setText("overview-latency", latencyCount ? Math.round(latencyTotal / latencyCount) + " ms" : "-- ms");
    setText("last-checked", "最后检测：" + pad(new Date().getHours()) + ":" + pad(new Date().getMinutes()) + ":" + pad(new Date().getSeconds()));
  }

  function resetServices() {
    var names = ["health", "api", "download", "notice"];
    var i;
    var row;
    state.services = { health: null, api: null, download: null, notice: null };
    state.serviceLatencies = {};
    for (i = 0; i < names.length; i += 1) {
      row = document.querySelector('[data-service="' + names[i] + '"]');
      if (row) {
        row.className = "";
        row.getElementsByTagName("strong")[0].textContent = names[i] === "download" ? "等待中" : "检测中";
        row.getElementsByTagName("small")[0].textContent = "-- ms";
      }
    }
    if (byId("global-status")) byId("global-status").className = "global-status status-checking";
    if (byId("system-summary")) byId("system-summary").className = "system-summary status-checking";
    updateOverallStatus();
  }

  function loadHealth() {
    request("GET", CONFIG.healthApi, function (error, response, latency) {
      updateService("health", !error && response && response.ok === true, latency);
    });
  }

  function applyRelease(data) {
    var versionName = data.version_name || "未知版本";
    var versionCode = data.version_code || "";
    var date = formatDate(data.ctime, false);
    var summary = compactText(data.update_log, 64) || "稳定版，推荐所有用户使用。";
    var versionText = "v" + versionName;

    state.release = data;
    setText("hero-version", versionText);
    setText("hero-version-state", versionText);
    setText("hero-release-date", date + " 发布");
    setText("release-version", versionText);
    setText("release-date", date);
    setText("release-summary", summary);

    if (versionCode) loadDownload(versionCode);
  }

  function applyDownloadUrl(url) {
    var checkUrl = url;
    var linkParser;
    setHref("hero-download", url);
    setHref("release-download", url);
    setHref("main-download", url);
    if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
      updateService("download", true, 0);
      return;
    }

    try {
      linkParser = document.createElement("a");
      linkParser.href = url;
      if (linkParser.hostname === "jp.031030.xyz" && window.location.hostname !== "jp.031030.xyz") {
        checkUrl = linkParser.pathname + linkParser.search;
      }
    } catch (parseError) {
      checkUrl = url;
    }

    request("HEAD", checkUrl, function (error, response, latency, xhr) {
      var size;
      updateService("download", !error, latency);
      if (!error && xhr) {
        size = xhr.getResponseHeader("Content-Length");
        if (size) {
          setText("release-size", formatBytes(size));
          setText("download-size", formatBytes(size));
        }
      }
    });
  }

  function loadDownload(versionCode) {
    request("GET", CONFIG.downloadApi + encodeURIComponent(versionCode), function (error, response) {
      if (!error && response && response.code === 0 && response.data) {
        applyDownloadUrl(response.data);
      } else {
        updateService("download", false, null);
      }
    });
  }

  function loadRelease() {
    request("GET", CONFIG.releaseApi, function (error, response, latency) {
      var data = response && response.data;
      if (!error && response && response.code === 0 && data && data.version_code) {
        updateService("api", true, latency);
        setText("hero-api-state", "正常");
        applyRelease(data);
      } else {
        updateService("api", false, latency);
        setText("hero-api-state", "暂不可用");
        setText("release-summary", "暂时无法获取版本信息，请稍后重试。");
        applyDownloadUrl(CONFIG.fallbackDownload);
      }
    });
  }

  function loadManifest() {
    request("GET", CONFIG.manifestApi, function (error, response) {
      var payload;
      var manifest;
      if (error || !response || !response.data || !response.data.payload) return;
      try {
        payload = decodeURIComponent(escape(window.atob(response.data.payload)));
        manifest = JSON.parse(payload);
      } catch (parseError) {
        return;
      }
      if (manifest.full) {
        if (manifest.full.size) {
          setText("release-size", formatBytes(manifest.full.size));
          setText("download-size", formatBytes(manifest.full.size));
        }
      }
    });
  }

  function loadBeta() {
    request("GET", CONFIG.betaApi, function (error, response) {
      var data = response && response.data;
      var panel = byId("beta");
      var heroButton = byId("hero-beta");
      var overview = document.querySelector(".overview");
      if (error || !data || !data.version_code || Number(data.is_release) !== 0) {
        if (panel) panel.hidden = true;
        if (heroButton) heroButton.hidden = true;
        if (overview) overview.className = "overview overview-no-beta section-shell";
        return;
      }
      if (panel) panel.hidden = false;
      if (heroButton) heroButton.hidden = false;
      if (overview) overview.className = "overview section-shell";
      setText("beta-version", "v" + (data.version_name || "Beta"));
      setText("beta-date", formatDate(data.ctime, false));
      setText("beta-summary", compactText(data.update_log, 72) || "用于提前验证新功能。可能存在不稳定情况。");
      request("GET", CONFIG.downloadApi + encodeURIComponent(data.version_code), function (downloadError, download) {
        if (!downloadError && download && download.code === 0 && download.data) {
          setHref("beta-download", download.data);
          setHref("hero-beta", download.data);
        }
      });
    });
  }

  function announcementType(title) {
    if (/维护|故障|重要|恢复/.test(title || "")) return "重要";
    if (/测试|Beta/i.test(title || "")) return "测试";
    return "更新";
  }

  function clearChildren(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function renderAnnouncements() {
    var list = byId("announcement-list");
    var toggle = byId("notice-toggle");
    var items = state.announcements.slice(0);
    var count;
    var i;
    var item;
    var article;
    var top;
    var tag;
    var time;
    var title;
    var content;

    if (!list) return;
    items.sort(function (a, b) {
      return Number(b.ctime || b.id || 0) - Number(a.ctime || a.id || 0);
    });
    count = state.announcementsExpanded ? items.length : Math.min(items.length, 3);
    clearChildren(list);
    list.className = state.announcementsExpanded ? "announcement-list is-expanded" : "announcement-list";

    for (i = 0; i < count; i += 1) {
      item = items[i] || {};
      article = document.createElement("article");
      article.className = "announcement-item";
      top = document.createElement("div");
      top.className = "announcement-top";
      tag = document.createElement("span");
      tag.className = "tag " + (/测试|Beta/i.test(item.title || "") ? "tag-beta" : "tag-stable");
      tag.textContent = announcementType(item.title);
      time = document.createElement("time");
      time.setAttribute("datetime", formatDate(item.ctime, false));
      time.textContent = formatDate(item.ctime, false);
      title = document.createElement("h3");
      title.textContent = item.title || "终端公告";
      content = document.createElement("p");
      content.textContent = item.content || "暂无详细内容";
      top.appendChild(tag);
      top.appendChild(time);
      article.appendChild(top);
      article.appendChild(title);
      article.appendChild(content);
      list.appendChild(article);
    }

    if (toggle) {
      toggle.hidden = items.length <= 3;
      toggle.textContent = state.announcementsExpanded ? "收起公告" : "查看全部";
    }
  }

  function loadAnnouncements() {
    var retry = byId("notice-retry");
    request("GET", CONFIG.noticeApi, function (error, response, latency) {
      var items = response && response.data;
      if (!error && response && response.code === 0 && items && typeof items.length === "number") {
        state.announcements = items;
        updateService("notice", true, latency);
        setText("hero-notice-state", "正常");
        if (retry) retry.hidden = true;
        renderAnnouncements();
      } else {
        updateService("notice", false, latency);
        setText("hero-notice-state", "暂不可用");
        if (retry) retry.hidden = false;
      }
    });
  }

  function runChecks() {
    resetServices();
    loadHealth();
    loadRelease();
    loadAnnouncements();
    loadManifest();
    loadBeta();
  }

  function initMenu() {
    var button = byId("menu-button");
    var nav = byId("site-nav");
    var links;
    var i;
    if (!button || !nav) return;
    button.onclick = function () {
      var open = nav.className.indexOf("is-open") === -1;
      nav.className = open ? "nav is-open" : "nav";
      button.setAttribute("aria-expanded", open ? "true" : "false");
      button.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
    };
    links = nav.getElementsByTagName("a");
    for (i = 0; i < links.length; i += 1) {
      links[i].onclick = function () {
        nav.className = "nav";
        button.setAttribute("aria-expanded", "false");
      };
    }
  }

  function initHomeLinks() {
    var brand = byId("home-brand");
    var home = byId("home-nav");

    function goHome(event) {
      var nav = byId("site-nav");
      var menu = byId("menu-button");
      if (event && event.preventDefault) event.preventDefault();
      if (event) event.returnValue = false;
      if (nav) nav.className = "nav";
      if (menu) menu.setAttribute("aria-expanded", "false");
      window.scrollTo(0, 0);
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
      }
      return false;
    }

    if (brand) brand.onclick = goHome;
    if (home) home.onclick = goHome;
  }

  function initReveal() {
    var nodes = document.querySelectorAll(".reveal");
    var i;
    var observer;
    if (!("IntersectionObserver" in window)) {
      for (i = 0; i < nodes.length; i += 1) nodes[i].className += " is-visible";
      return;
    }
    observer = new IntersectionObserver(function (entries) {
      var j;
      for (j = 0; j < entries.length; j += 1) {
        if (entries[j].isIntersecting) {
          entries[j].target.className += " is-visible";
          observer.unobserve(entries[j].target);
        }
      }
    }, { rootMargin: "0px 0px -30px", threshold: 0.08 });
    for (i = 0; i < nodes.length; i += 1) observer.observe(nodes[i]);
  }

  function initLowPowerMode() {
    var cores = navigator.hardwareConcurrency;
    if ((cores && cores <= 2) || window.innerWidth <= 340) {
      document.documentElement.className += " low-power";
    }
  }

  function init() {
    var noticeToggle = byId("notice-toggle");
    var statusRetry = byId("status-retry");
    var noticeRetry = byId("notice-retry");
    initLowPowerMode();
    initMenu();
    initHomeLinks();
    initReveal();
    setText("copyright-year", new Date().getFullYear());
    if (noticeToggle) noticeToggle.onclick = function () {
      state.announcementsExpanded = !state.announcementsExpanded;
      renderAnnouncements();
    };
    if (statusRetry) statusRetry.onclick = runChecks;
    if (noticeRetry) noticeRetry.onclick = loadAnnouncements;
    runChecks();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}());
