// dsh-ponytail-v6 — browser half.
//
// Registers one settings section: the level switch and the master switch. It talks
// to the host half through `/ponytail/*` on the same origin. Everything is wrapped
// in try/catch: the plugin is fully usable from the host side (command + skills)
// even if this panel cannot mount on a given DSH build.
window.__ModuleLoader__.load({
  id: "dsh-ponytail-v6",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var MODES = [
      { id: "off", label: "Off", hint: "No ruleset injected." },
      { id: "lite", label: "Lite", hint: "Do what was asked; name a smaller option in one line." },
      { id: "full", label: "Full", hint: "The whole ruleset. Default." },
      { id: "ultra", label: "Ultra", hint: "Also questions whether the request is needed." }
    ];

    var styles = {
      root: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 0", fontSize: "13px" },
      row: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      badge: { display: "inline-flex", alignItems: "center", gap: "6px", padding: "2px 8px", borderRadius: "8px", border: "1px solid rgba(79,214,232,0.5)", color: "rgb(79,214,232)", fontSize: "12px" },
      button: { padding: "5px 12px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.18)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12px", lineHeight: "1.6" },
      buttonActive: { padding: "5px 12px", borderRadius: "8px", border: "1px solid rgba(79,214,232,0.75)", background: "rgba(79,214,232,0.12)", color: "rgb(79,214,232)", cursor: "pointer", fontSize: "12px", lineHeight: "1.6" },
      hint: { opacity: 0.65, fontSize: "12px", margin: 0 },
      error: { color: "#ff7b72", fontSize: "12px", margin: 0 },
      ok: { color: "#4fd6e8", fontSize: "12px", margin: 0 }
    };

    function readState() {
      return fetch("/ponytail/state", { headers: { accept: "application/json" } }).then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      });
    }

    function post(path, body) {
      return fetch("/ponytail/" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok || data.ok !== true) {
            throw new Error(data && data.error ? data.error : "HTTP " + response.status);
          }
          return data;
        });
      });
    }

    function PonytailPanel() {
      var stateHook = React.useState({ loading: true, enabled: true, mode: "full", source: "default" });
      var snap = stateHook[0];
      var setSnap = stateHook[1];
      var messageHook = React.useState({ kind: "", text: "" });
      var message = messageHook[0];
      var setMessage = messageHook[1];

      var apply = React.useCallback(function (data) {
        setSnap({ loading: false, enabled: data.enabled, mode: data.mode, source: data.source });
      }, []);

      React.useEffect(function () {
        var live = true;
        readState()
          .then(function (data) {
            if (live) apply(data);
          })
          .catch(function (error) {
            if (live) setMessage({ kind: "error", text: "Cannot read state: " + error.message });
          });
        return function () {
          live = false;
        };
      }, [apply]);

      var switchMode = React.useCallback(function (mode) {
        post("mode", { mode: mode })
          .then(function (data) {
            apply(data);
            setMessage({ kind: "ok", text: "Level " + data.mode + ", effective from the next step." });
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: error.message });
          });
      }, [apply]);

      var toggleEnabled = React.useCallback(function () {
        var next = !snap.enabled;
        post("enabled", { enabled: next })
          .then(function (data) {
            apply(data);
            setMessage({ kind: "ok", text: data.enabled ? "Enabled." : "Disabled: no ruleset is injected." });
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: error.message });
          });
      }, [apply, snap.enabled]);

      var activeIndex = 0;
      for (var i = 0; i < MODES.length; i += 1) if (MODES[i].id === snap.mode) activeIndex = i;
      var active = MODES[activeIndex];

      return React.createElement(
        "div",
        { style: styles.root },
        React.createElement(
          "div",
          { style: styles.row },
          React.createElement("strong", null, "Ponytail"),
          React.createElement("span", { style: styles.badge }, snap.loading ? "loading…" : "level " + snap.mode),
          React.createElement(
            "button",
            { type: "button", style: styles.button, onClick: toggleEnabled, disabled: snap.loading },
            snap.enabled ? "Disable" : "Enable"
          )
        ),
        React.createElement(
          "p",
          { style: styles.hint },
          "Upstream v5.3.3 ruleset, injected as a prompt section. Level switches never reach the model, so they cost no tokens."
        ),
        React.createElement(
          "div",
          { style: styles.row },
          MODES.map(function (mode) {
            return React.createElement(
              "button",
              {
                key: mode.id,
                type: "button",
                style: mode.id === snap.mode ? styles.buttonActive : styles.button,
                onClick: function () {
                  switchMode(mode.id);
                },
                disabled: snap.loading
              },
              mode.label
            );
          })
        ),
        React.createElement("p", { style: styles.hint }, active ? active.hint : ""),
        message.kind === "error"
          ? React.createElement("p", { style: styles.error }, message.text)
          : message.kind === "ok"
            ? React.createElement("p", { style: styles.ok }, message.text)
            : null,
        React.createElement(
          "p",
          { style: styles.hint },
          "Default level comes from PONYTAIL_DEFAULT_MODE, then ~/.dsh/ponytail/config.json, then full. Source: " + snap.source + "."
        )
      );
    }

    var inject = ["slots"];

    function apply(ctx) {
      try {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            { name: "settings.section", id: "ponytail-v6", order: 640, label: function () { return "Ponytail"; } },
            PonytailPanel
          );
        });
      } catch (error) {
        console.warn("[dsh-ponytail-v6] settings panel registration failed:", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
