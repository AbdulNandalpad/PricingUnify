sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel"
], function (Controller, MessageToast, Fragment, JSONModel) {
  "use strict";

  /** Shared plumbing: a fetch wrapper that speaks CAP's REST protocol (and digs the real
   *  message out of a CAP error body), plus the display formatters both views use. All
   *  numbers shown are display-rounded to 2 decimals — the engine's decimal math and the
   *  trace keep full precision. */
  return Controller.extend("com.tss.pricing.c4c.controller.BaseController", {

    getSession: function () {
      return this.getOwnerComponent().getModel("session");
    },

    getRouter: function () {
      return this.getOwnerComponent().getRouter();
    },

    callRest: function (path, options) {
      options = options || {};
      var init = {
        method: options.method || (options.body ? "POST" : "GET"),
        headers: { Accept: "application/json" }
      };
      if (options.body) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      return fetch(path, init).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error body */ }
          if (!res.ok) {
            var message = (data && data.error && data.error.message) || text || ("HTTP " + res.status);
            var err = new Error(message);
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
    },

    toast: function (text) {
      MessageToast.show(text);
    },

    /** Opens the shared calculation-trace dialog for one priced/failed line — used by the
     *  Viewer's row press and the Admin Simulate tab alike. Everything shown is read straight
     *  off the engine trace; nothing is recomputed in the UI. */
    openTraceDialog: function (view, line) {
      var that = this;
      var trace = line.trace || {};
      var cc = trace.costCandidate || null;
      var steps = (trace.steps || []).map(function (s) {
        return {
          id: s.id, type: s.type,
          delta: (s.note && s.note.skipped) ? "" : s.delta,
          running: s.runningTotal !== undefined ? s.runningTotal : "",
          note: (s.note && s.note.skipped) ? ("not applied — when: " + JSON.stringify(s.note.when)) : ""
        };
      });
      var routing = trace.costRouting ? [].concat(trace.costRouting) : [];
      var routingCalls = routing.length && routing[0].calls ? routing[0].calls : [];
      var model = new JSONModel({
        partNumber: line.partNumber,
        status: line.status,
        stockClass: trace.stockClass || "",
        missing: line.missing ? (line.missing.reason + (line.missing.detail ? " — " + line.missing.detail : "")) : "",
        candidate: cc ? {
          value: cc.value, currency: cc.currency, basis: cc.basis,
          system: cc.source ? cc.source.system : "", key: cc.source ? cc.source.key : "",
          field: cc.source ? cc.source.field : "", selectedBy: cc.selectedBy || ""
        } : null,
        routingCalls: routingCalls,
        biPayload: (routingCalls.length && routingCalls[0].payload) ? JSON.stringify(routingCalls[0].payload, null, 2) : "",
        steps: steps,
        constraints: trace.constraintPasses || [],
        configVersion: trace.configVersion || ""
      });

      if (!this._traceDialogPromise) {
        this._traceDialogPromise = Fragment.load({
          id: view.getId(), name: "com.tss.pricing.c4c.view.TraceDialog", controller: this
        }).then(function (dialog) {
          view.addDependent(dialog);
          return dialog;
        });
      }
      this._traceDialogPromise.then(function (dialog) {
        dialog.setModel(model, "trace");
        dialog.open();
        that._traceDialog = dialog;
      });
    },

    onCloseTrace: function () {
      if (this._traceDialog) { this._traceDialog.close(); }
    },

    formatter: {
      fmt2: function (value) {
        if (value === null || value === undefined || value === "") { return ""; }
        var n = Number(value);
        return Number.isFinite(n) ? n.toFixed(2) : String(value);
      },

      /** Status contract from the owner spec: OK (Success) / FALLBACK (Warning) / MISSING (Error). */
      statusText: function (status, confidence) {
        if (!status) { return ""; }
        if (status === "PRICED") {
          return (confidence === "FALLBACK" || confidence === "STALE") ? "FALLBACK" : "OK";
        }
        if (status === "BLOCKED") { return "FALLBACK"; }
        return "MISSING";
      },

      statusState: function (status, confidence) {
        if (!status) { return "None"; }
        if (status === "PRICED") {
          return (confidence === "FALLBACK" || confidence === "STALE") ? "Warning" : "Success";
        }
        if (status === "BLOCKED") { return "Warning"; }
        return "Error";
      },

      /** "0.047" -> "= 4.70 %" — the live hint next to an editable FACTOR rate. */
      ratePct: function (rate) {
        var n = Number(rate);
        return Number.isFinite(n) && rate !== "" && rate !== null ? "= " + (n * 100).toFixed(2) + " %" : "";
      }
    }
  });
});
