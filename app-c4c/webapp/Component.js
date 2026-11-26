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
      var REGIONS = ["EUROPE", "CHINA", "INDIA", "AMERICAS"];
      var problems = [];

      // What C4C passes into the iframe. Unknown values are SAID, never silently turned into a
      // default that would show a quote's prices on what was meant to be a cost-only opportunity.
      var rawType = (params.get("objectType") || "QUOTE").toUpperCase();
      var objectType = rawType === "OPPORTUNITY" ? "OPPORTUNITY" : "QUOTE";
      if (rawType !== "QUOTE" && rawType !== "OPPORTUNITY") {
        problems.push("objectType \"" + params.get("objectType") + "\" is not supported (QUOTE or OPPORTUNITY) — showing QUOTE.");
      }
      var rawRegion = (params.get("region") || "EUROPE").toUpperCase();
      var region = REGIONS.indexOf(rawRegion) >= 0 ? rawRegion : "EUROPE";
      if (REGIONS.indexOf(rawRegion) < 0) {
        problems.push("region \"" + params.get("region") + "\" is not known (" + REGIONS.join(", ") + ") — using EUROPE.");
      }
      var objectId = (params.get("objectId") || "").trim();
      var mode = (params.get("mode") || "").toLowerCase();

      var session = new JSONModel({
        objectType: objectType,
        objectId: objectId,
        hostContext: objectId !== "", // opened by a host (C4C) for ONE object: region/search stay locked to it
        mode: mode,
        region: region,
        salesOrg: params.get("salesOrg") || "*",
        paramError: problems.join(" "),
        sessionExpired: false,
        user: null,
        roles: { PricingViewer: false, PricingAdmin: false },
        meLoaded: false,
        meError: null
      });
      this.setModel(session, "session");

      this.getRouter().initialize();

      var that = this;
      // X-Requested-With makes the approuter answer an expired session with 401 instead of a
      // cross-origin redirect to the login page (which fetch() cannot follow inside an iframe).
      fetch("/rest/pricing/me", { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } })
        .then(function (res) {
          if (res.status === 401) { session.setProperty("/sessionExpired", true); throw new Error("Not signed in."); }
          if (!res.ok) { throw new Error("Not signed in (HTTP " + res.status + ")."); }
          return res.json();
        })
        .then(function (me) {
          session.setProperty("/user", me.id);
          session.setProperty("/roles", me.roles || {});
          session.setProperty("/meLoaded", true);
          if (mode === "admin") {
            if (me.roles && me.roles.PricingAdmin) { that.getRouter().navTo("admin"); }
            else { session.setProperty("/paramError", (session.getProperty("/paramError") + " mode=admin needs the PricingAdmin role — showing pricing.").trim()); }
          }
        })
        .catch(function (err) {
          session.setProperty("/meError", String(err.message || err));
          session.setProperty("/meLoaded", true);
        });
    }
  });
});
