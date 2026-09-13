(() => {
  try {
    /* Prompt Lab (dsh-artificial-interlligent-safety-words-study) client half — realtime badge */
    window.__ModuleLoader__.load({
      id: "dsh-artificial-interlligent-safety-words-study",
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var react = require("react");

        var inject = ["slots"];

        /* 版本号唯一来源。改动版本时只需改这一处，同时同步 package.json。
           注意：这三行必须同时存在——BADGE_LABEL 引用前两者，
           任一缺失都会导致插件加载期抛 ReferenceError。 */
        var PLUGIN_NAME = "Prompt Lab";
        var PLUGIN_VERSION = "1.0.0";
        var BADGE_LABEL = PLUGIN_NAME + " v" + PLUGIN_VERSION;

        var ANIM_CSS =
          "@keyframes dshLabPulse{0%,100%{box-shadow:0 0 2px rgba(59,130,246,.5);opacity:1}" +
          "50%{box-shadow:0 0 14px rgba(59,130,246,1);opacity:.6}}";

        var WRAP_STYLE = {
          display: "flex",
          justifyContent: "center",
          width: "100%"
        };
        var BADGE_STYLE = {
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          width: "fit-content",
          padding: "3px 10px",
          borderRadius: "6px",
          border: "1px solid rgba(59, 130, 246, 0.45)",
          background: "rgba(59, 130, 246, 0.12)",
          color: "inherit",
          fontSize: "11px",
          lineHeight: "16px",
          fontFamily: "inherit",
          userSelect: "none",
          whiteSpace: "nowrap"
        };
        var DOT_STYLE = {
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: "#3b82f6",
          flex: "none"
        };

        function LabDock(props) {
          var useProjection = props.useProjection;
          var state = typeof useProjection === "function"
            ? useProjection("promptlab")
            : undefined;

          var running = !!(state && state.running);
          var verdict = state && state.verdict ? state.verdict : null;
          var chars = state && state.chars ? state.chars : 0;

          var text = BADGE_LABEL;
          var dotStyle = Object.assign({}, DOT_STYLE);
          var badgeStyle = Object.assign({}, BADGE_STYLE);

          if (running) {
            dotStyle.animation = "dshLabPulse 1.2s ease-in-out infinite";
            text = BADGE_LABEL + " · 生成中";
          } else if (verdict === "pass") {
            text = BADGE_LABEL + " · 交付物" + (chars ? " " + chars + " 字" : "");
          } else if (verdict === "unstructured") {
            text = BADGE_LABEL + " · 结构待查";
            badgeStyle.borderColor = "rgba(245, 158, 11, 0.5)";
            badgeStyle.background = "rgba(245, 158, 11, 0.12)";
            dotStyle.background = "#f59e0b";
          } else if (verdict === "refusal" || verdict === "fallback") {
            text = BADGE_LABEL + " · " + (verdict === "refusal" ? "未产出" : "已回退");
            badgeStyle.borderColor = "rgba(239, 68, 68, 0.5)";
            badgeStyle.background = "rgba(239, 68, 68, 0.12)";
            dotStyle.background = "#ef4444";
          }

          react.useEffect(function () {
            if (document.getElementById("dsh-promptlab-css")) return;
            var el = document.createElement("style");
            el.id = "dsh-promptlab-css";
            el.textContent = ANIM_CSS;
            document.head.appendChild(el);
          }, []);

          return react.createElement(
            "div",
            { style: WRAP_STYLE },
            react.createElement(
              "div",
              { style: badgeStyle, "data-promptlab": "on", title: BADGE_LABEL },
              react.createElement("span", { style: dotStyle }),
              react.createElement("span", null, text)
            )
          );
        }

        function apply(ctx) {
          ctx.slot({
            type: "input-dock",
            id: "promptlab-status",
            order: 60,
            component: LabDock
          });
        }

        exports.name = "dsh-artificial-interlligent-safety-words-study";
        exports.inject = inject;
        exports.apply = apply;
        exports.LabDock = LabDock;
        return module.exports;
      }
    });
  } catch (e) {
    console.error("[Prompt Lab] client half failed to load:", e);
  }
})();
