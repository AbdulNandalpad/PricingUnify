sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel"
], function (UIComponent, JSONModel) {
  "use strict";

  /**
   * Startup contract (owner spec, Phase 3): read objectType (QUOTE|OPPORTUNITY), objectId and
   * mode from the URL (what C4C passes into the iframe), ask srv who the user is and which of
   * the two roles they hold (/rest/pricing/me), then route to the Viewer or — for
   * mode=admin + PricingAdmin — the Admin view. The roles here only steer navigation and
   * visibility; every endpoint enforces its own @requires server-side.
   */
  return UIComponent.extend("com.tss.pricing.c4c.Component", {
    metadata: { manifest: "json" },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      var params = new URLSearchParams(window.location.search);
      var objectType = (params.get("objectType") || "QUOTE").toUpperCase() === "OPPORTUNITY" ? "OPPORTUNITY" : "QUOTE";
      var session = new JSONModel({
        objectType: objectType,
        objectId: params.get("objectId") || "",
        mode: (params.get("mode") || "").toLowerCase(),
        region: (params.get("region") || "EUROPE").toUpperCase(),
        salesOrg: params.get("salesOrg") || "*",
        user: null,
        roles: { PricingViewer: false, PricingAdmin: false },
        meLoaded: false,
        meError: null
      });
      this.setModel(session, "session");

      this.getRouter().initialize();

      var that = this;
      fetch("/rest/pricing/me", { headers: { Accept: "application/json" } })
        .then(function (res) {
          if (!res.ok) { throw new Error("Not signed in (HTTP " + res.status + ")."); }
          return res.json();
        })
        .then(function (me) {
          session.setProperty("/user", me.id);
          session.setProperty("/roles", me.roles || {});
          session.setProperty("/meLoaded", true);
          if (session.getProperty("/mode") === "admin" && me.roles && me.roles.PricingAdmin) {
            that.getRouter().navTo("admin");
          }
        })
        .catch(function (err) {
          session.setProperty("/meError", String(err.message || err));
          session.setProperty("/meLoaded", true);
        });
    },

    getContentDensityClass: function () {
      return "sapUiSizeCompact";
    }
  });
});
