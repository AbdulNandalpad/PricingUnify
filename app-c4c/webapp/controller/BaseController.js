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
      // Price/cost unit: step amounts are per piece at full precision (0.02295 ...); shown per
      // price unit (x100) they are readable (2.295 ...). Display-only scaling.
      var unit = Number(line.result && line.result.priceUnit) || 1;
      var show = function (v) {
        if (v === "" || v === undefined || v === null || !Number.isFinite(Number(v))) { return ""; }
        var x = Number(v) * unit;
        var t = x.toFixed(4).replace(/0+$/, "");
        var dec = (t.split(".")[1] || "").length;
        return x.toFixed(Math.max(2, dec));
      };
      var qty = (line.result && line.result.quantity) || 1;
      var steps = (trace.steps || []).map(function (s) {
        var note = "";
        if (s.note && s.note.skipped) {
          note = "not applied — when: " + JSON.stringify(s.note.when);
        } else if (s.type === "FACTOR" && s.note && s.note.rate !== undefined && s.note.rate !== null) {
          note = (Number(s.note.rate) * 100).toFixed(2).replace(/\.?0+$/, "") + " % of " + show(s.note.basisAmount);
        } else if (s.type === "PER_LINE" && s.note && s.note.perQuantity) {
          note = "per order, ÷ quantity " + s.note.perQuantity;
        }
        return {
          id: s.id, type: s.type,
          delta: (s.note && s.note.skipped) ? "" : show(s.delta),
          running: s.runningTotal !== undefined ? show(s.runningTotal) : "",
          note: note
        };
      });
      var finalRow = (line.result && line.result.unitPrice !== undefined)
        ? { id: "= Unit price", type: "per " + unit + " pc", delta: "", running: show(Number(line.result.unitPrice) / unit), note: "after the declared rounding" }
        : null;
      if (finalRow && unit !== 1) { steps.push(finalRow); }
      var routing = trace.costRouting ? [].concat(trace.costRouting) : [];
      var routingCalls = routing.length && routing[0].calls ? routing[0].calls : [];
      var model = new JSONModel({
        partNumber: line.partNumber,
        status: line.status,
        stockClass: trace.stockClass || "",
        missing: line.missing ? (line.missing.reason
          + (line.missing.element ? " — step " + line.missing.element + (line.missing.from ? " needs the value \"" + line.missing.from + "\"" : "") : "")
          + (line.missing.detail ? " — " + line.missing.detail : "")) : "",
        candidate: cc ? {
          value: unit !== 1 ? (cc.value + " per piece = " + show(cc.value) + " per " + unit) : cc.value, currency: cc.currency, basis: cc.basis,
          system: cc.source ? cc.source.system : "", key: cc.source ? cc.source.key : "",
          field: cc.source ? cc.source.field : "", selectedBy: cc.selectedBy || ""
        } : null,
        unitNote: (line.result && line.result.priceUnit) ? ("All amounts are per " + line.result.priceUnit + " pieces (price/cost unit " + line.result.priceUnit + "). The calculation runs per piece at full precision, is multiplied by the unit, then rounded. Pick charge is per order ÷ quantity (" + qty + ").") : "",
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
