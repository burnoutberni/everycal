(function() {
  try {
    var root = document.documentElement;
    var key = (root && root.getAttribute("data-theme-storage-key")) || "everycal-theme-preference";
    var preference = "system";
    var bootstrap = null;
    var bootstrapEl = document.getElementById("everycal-bootstrap");
    if (bootstrapEl && bootstrapEl.textContent) {
      bootstrap = JSON.parse(bootstrapEl.textContent);
    }
    if (bootstrap && bootstrap.isAuthenticated === true) {
      var viewerTheme = bootstrap.viewer && bootstrap.viewer.themePreference;
      if (viewerTheme === "light" || viewerTheme === "dark" || viewerTheme === "system") {
        preference = viewerTheme;
      } else {
        var pref = localStorage.getItem(key);
        var valid = pref === "light" || pref === "dark" || pref === "system";
        preference = valid ? pref : "system";
      }
    } else if (bootstrap && bootstrap.isAuthenticated === false) {
      localStorage.removeItem(key);
    } else {
      var cachedPref = localStorage.getItem(key);
      var cachedValid = cachedPref === "light" || cachedPref === "dark" || cachedPref === "system";
      preference = cachedValid ? cachedPref : "system";
    }
    var systemDark = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
    if (preference === "light" || preference === "dark") root.setAttribute("data-theme", preference);
    else root.removeAttribute("data-theme");
    root.style.colorScheme = resolved;
  } catch (_err) {}
})();
