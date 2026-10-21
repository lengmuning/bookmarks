// Language switch and the "Worker address" boxes of the home page. Loaded in
// <head> without defer so the language is set before the page is drawn.
(function () {
  "use strict";

  var KEY = "sbs-site-lang";
  var root = document.documentElement;

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function remember(lang) {
    try {
      localStorage.setItem(KEY, lang);
    } catch (e) {
      // Private mode or storage blocked: the choice lasts for this visit.
    }
  }

  function preferred() {
    var saved = stored();
    if (saved === "zh" || saved === "en") return saved;
    var languages = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
    for (var i = 0; i < languages.length; i++) {
      if (/^zh\b/i.test(languages[i])) return "zh";
      if (/^en\b/i.test(languages[i])) return "en";
    }
    return "zh";
  }

  function apply(lang) {
    root.lang = lang === "en" ? "en" : "zh-CN";
    var title = root.getAttribute("data-title-" + lang);
    if (title) document.title = title;
    var description = document.querySelector('meta[name="description"]');
    var text = root.getAttribute("data-description-" + lang);
    if (description && text) description.setAttribute("content", text);
    var buttons = document.querySelectorAll("[data-set-lang]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-set-lang") === lang));
    }
  }

  function current() {
    return root.lang === "en" ? "en" : "zh";
  }

  apply(preferred());

  document.addEventListener("DOMContentLoaded", function () {
    apply(current());

    var buttons = document.querySelectorAll("[data-set-lang]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function (event) {
        var lang = event.currentTarget.getAttribute("data-set-lang");
        remember(lang);
        apply(lang);
      });
    }

    // This page is served by the Worker itself, so its own address is the
    // one to enter in the app and the extensions.
    var origins = document.querySelectorAll("[data-origin]");
    for (var j = 0; j < origins.length; j++) origins[j].textContent = location.origin;

    var copies = document.querySelectorAll("[data-copy]");
    for (var k = 0; k < copies.length; k++) {
      copies[k].addEventListener("click", function (event) {
        var button = event.currentTarget;
        var target = document.getElementById(button.getAttribute("data-copy"));
        if (!target || !navigator.clipboard) return;
        navigator.clipboard.writeText(target.textContent.trim()).then(function () {
          var labels = button.querySelectorAll("[data-l]");
          var previous = [];
          for (var n = 0; n < labels.length; n++) {
            previous.push(labels[n].textContent);
            labels[n].textContent = labels[n].getAttribute("data-l") === "en" ? "Copied" : "已复制";
          }
          setTimeout(function () {
            for (var n = 0; n < labels.length; n++) labels[n].textContent = previous[n];
          }, 1500);
        });
      });
    }
  });
})();
