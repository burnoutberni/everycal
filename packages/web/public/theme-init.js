(function() {
  try {
    var key = "everycal-theme-preference";
    var pref = localStorage.getItem(key);
    var valid = pref === "light" || pref === "dark" || pref === "system";
    var preference = valid ? pref : "system";
    var systemDark = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
    var root = document.documentElement;
    if (preference === "light" || preference === "dark") root.setAttribute("data-theme", preference);
    else root.removeAttribute("data-theme");
    root.style.colorScheme = resolved;
  } catch (_err) {}
})();
