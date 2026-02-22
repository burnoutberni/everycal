/** @type {import('i18next-scanner').UserConfig} */
module.exports = {
  input: ["src/**/*.{ts,tsx}", "!src/i18n/**"],
  output: "src/i18n",
  options: {
    debug: false,
    func: {
      list: ["t", "i18n.t"],
      extensions: [".ts", ".tsx"],
    },
    // Trans parsing disabled: acorn doesn't support TypeScript; t() extraction works
    lngs: ["en", "de"],
    ns: [
      "common",
      "auth",
      "events",
      "calendar",
      "discover",
      "profile",
      "settings",
      "onboarding",
      "createEvent",
    ],
    defaultLng: "en",
    defaultNs: "common",
    defaultValue: (lng, ns, key) => key,
    resource: {
      loadPath: "src/i18n/locales/{{lng}}/{{ns}}.json",
      savePath: "src/i18n/locales/{{lng}}/{{ns}}.json",
      jsonIndent: 2,
      lineEnding: "\n",
    },
    nsSeparator: ":",
    keySeparator: ".",
    interpolation: {
      prefix: "{{",
      suffix: "}}",
    },
  },
};
