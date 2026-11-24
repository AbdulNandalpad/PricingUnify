sap.ui.define([
  "./BaseController",
  "sap/ui/model/json/JSONModel"
], function (BaseController, JSONModel) {
  "use strict";

  var REGIONS = ["EUROPE", "CHINA", "INDIA", "AMERICAS"];

  function joinSeq(arr) { return Array.isArray(arr) ? arr.join(", ") : ""; }
  function parseSeq(text) {
    var parts = String(text || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    return parts.length ? parts : null;
  }
  function whenToText(when) {
    if (!when) { return ""; }
    return Array.isArray(when) ? when.join(" && ") : String(when);
  }
  function textToWhen(text) {
    var trimmed = String(text || "").trim();
    if (!trimmed) { return undefined; }
    var parts = trimmed.split("&&").map(function (s) { return s.trim(); }).filter(Boolean);
    return parts.length > 1 ? parts : parts[0];
  }

  /**
   * PricingAdmin's workspace. Every edit goes through srv's saveRegionConfig, which re-runs
   * the config-model validator (schema + business rules like FACTOR-needs-basis) — a 422
   * surfaces inline, the store stays untouched, and a successful save IS the activate step
   * (new effective-dated version, old one superseded; there is no separate draft stage yet).
   * Price Lists is a read-only browser over the WSO2 lookup (owner decision 2026-11-24).
   */
  return BaseController.extend("com.tss.pricing.c4c.controller.Admin", {

    onInit: function () {
      var today = new Date().toISOString().slice(0, 10);
      var vm = new JSONModel({
        busy: false, message: "", messageType: "Information",
        selectedRegion: "EUROPE",
        regions: [],
        sheet: { seqDefault: "", seqMTS: "", seqNonMTS: "", buildUp: [], constraintCount: 0, version: "", validFrom: today, loaded: null },
        versions: [],
        priceList: { supplier: "", productCategory: "", partNumber: "", quantity: "1", asOf: "", looked: false, entry: null, matchedBy: "", triedText: "" },
        connections: null,
        sim: { partNumber: "EU-T100", quantity: "10", supplier: "", productCategory: "", pricingType: "COST_PLUS", objectType: "QUOTE", line: null, resultText: "", resultState: "None" }
      });
      this.getView().setModel(vm, "vm");

      this.getRouter().getRoute("admin").attachPatternMatched(this._onShown, this);
      this._reloadAll();
    },

    _vm: function () { return this.getView().getModel("vm"); },

    _onShown: function () { this._reloadAll(); },

    _message: function (text, type) {
      this._vm().setProperty("/message", text);
      this._vm().setProperty("/messageType", type || "Information");
    },
    onCloseMessage: function () { this._message(""); },

    _reloadAll: function () {
      this._loadRegions();
      this._loadSheet();
      this._loadVersions();
      this._loadConnections();
    },

    _loadConnections: function () {
      var that = this;
      this.callRest("/rest/config/getConnections")
        .then(function (conn) {
          conn.api6.endpointRows = Object.keys(conn.api6.costSourceEndpoints || {}).map(function (system) {
            return { system: system, path: conn.api6.costSourceEndpoints[system] };
          });
          conn.c4c.fieldRows = Object.keys(conn.c4c.fieldMap || {})
            .filter(function (key) { return typeof conn.c4c.fieldMap[key] === "string"; })
            .map(function (key) { return { ours: key, theirs: conn.c4c.fieldMap[key] }; });
          that._vm().setProperty("/connections", conn);
        })
        .catch(function () { /* non-admin or backend down — tab simply stays empty */ });
    },

    onRegionSelect: function () {
      this._loadSheet();
      this._loadVersions();
    },

    onRegionRowPress: function (oEvent) {
      var item = oEvent.getParameter("listItem") || oEvent.getSource();
      var ctx = item.getBindingContext("vm");
      if (!ctx) { return; }
      this._vm().setProperty("/selectedRegion", ctx.getObject().region);
      this.onRegionSelect();
      this.byId("adminTabs").setSelectedKey("costRules");
    },

    _loadRegions: function () {
      var that = this;
      Promise.all(REGIONS.map(function (region) {
        return that.callRest("/rest/config/getEffectiveConfig?region=" + region + "&salesOrg=*")
          .then(function (config) {
            var seq = config.costAccessSequence;
            var seqText = Array.isArray(seq) ? joinSeq(seq)
              : seq ? Object.keys(seq).map(function (k) { return k + ": " + joinSeq(seq[k]); }).join(" | ")
              : "—";
            return {
              region: region, version: config.version, validFrom: config.validFrom || "",
              stepCount: (config.buildUp || []).length, sequence: seqText
            };
          })
          .catch(function () { return { region: region, version: "— none —", validFrom: "", stepCount: 0, sequence: "" }; });
      })).then(function (rows) {
        that._vm().setProperty("/regions", rows);
      });
    },

    _loadSheet: function () {
      var that = this;
      var vm = this._vm();
      var region = vm.getProperty("/selectedRegion");
      vm.setProperty("/busy", true);
      this.callRest("/rest/config/getEffectiveConfig?region=" + region + "&salesOrg=*")
        .then(function (config) {
          var seq = config.costAccessSequence;
          var isObj = seq && !Array.isArray(seq);
          var today = new Date().toISOString().slice(0, 10);
          vm.setProperty("/sheet", {
            loaded: config,
            seqDefault: isObj ? joinSeq(seq["*"]) : joinSeq(seq),
            seqMTS: isObj ? joinSeq(seq.MTS) : "",
            seqNonMTS: isObj ? joinSeq(seq.NonMTS) : "",
            buildUp: (config.buildUp || []).map(function (el) {
              return {
                id: el.id, type: el.type,
                rate: el.rate !== undefined ? String(el.rate) : "",
                rateRef: el.rateRef || "",
                amount: el.amount !== undefined ? String(el.amount) : "",
                amountRef: el.amountRef || "",
                basisText: Array.isArray(el.basis) ? el.basis.join(", ") : (el.basis || ""),
                whenText: whenToText(el.when),
                _orig: el
              };
            }),
            constraintCount: (config.constraints || []).length,
            version: today + "-r1",
            validFrom: today
          });
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.setProperty("/busy", false); });
    },

    _loadVersions: function () {
      var that = this;
      var region = this._vm().getProperty("/selectedRegion");
      this.callRest("/rest/config/listVersions?region=" + region + "&salesOrg=*")
        .then(function (res) {
          that._vm().setProperty("/versions", (res.versions || []).map(function (v) {
            var p = v.provenance || {};
            return {
              version: v.version, status: v.status, validFrom: v.validFrom || "", validTo: v.validTo,
              authoredBy: p.authoredBy || p.approvedBy || "", authoredAt: (p.authoredAt || "").slice(0, 19).replace("T", " "),
              source: p.source || ""
            };
          }));
        })
        .catch(function () { that._vm().setProperty("/versions", []); });
    },

    onAddStep: function () {
      var buildUp = this._vm().getProperty("/sheet/buildUp");
      buildUp.push({ id: "", type: "ADDER", rate: "", rateRef: "", amount: "", amountRef: "", basisText: "", whenText: "", _orig: null });
      this._vm().setProperty("/sheet/buildUp", buildUp);
    },

    onRemoveStep: function (oEvent) {
      var ctx = oEvent.getSource().getBindingContext("vm");
      var index = Number(ctx.getPath().split("/").pop());
      var buildUp = this._vm().getProperty("/sheet/buildUp");
      buildUp.splice(index, 1);
      this._vm().setProperty("/sheet/buildUp", buildUp);
    },

    onSaveSheet: function () {
      var that = this;
      var vm = this._vm();
      var sheet = vm.getProperty("/sheet");
      var loaded = sheet.loaded;
      if (!loaded) { return; }

      // Copy-forward: start from the loaded config, replace what the sheet edits. A save is
      // always a brand-new effective-dated version — never an in-place mutation.
      var seqDefault = parseSeq(sheet.seqDefault);
      var seqMTS = parseSeq(sheet.seqMTS);
      var seqNonMTS = parseSeq(sheet.seqNonMTS);
      var costAccessSequence;
      if (seqMTS || seqNonMTS) {
        costAccessSequence = {};
        if (seqMTS) { costAccessSequence.MTS = seqMTS; }
        if (seqNonMTS) { costAccessSequence.NonMTS = seqNonMTS; }
        if (seqDefault) { costAccessSequence["*"] = seqDefault; }
      } else if (seqDefault) {
        costAccessSequence = seqDefault;
      }

      var doc = Object.assign({}, loaded, {
        version: (sheet.version || "").trim(),
        validFrom: (sheet.validFrom || "").trim() || undefined,
        validTo: null,
        buildUp: sheet.buildUp.map(function (row) {
          var el = Object.assign({}, row._orig || {});
          el.id = (row.id || "").trim();
          el.type = row.type;
          ["rate", "rateRef", "amount", "amountRef"].forEach(function (key) {
            var value = (row[key] || "").trim();
            if (value) { el[key] = value; } else { delete el[key]; }
          });
          var basis = parseSeq(row.basisText);
          if (basis) { el.basis = basis; } else { delete el.basis; }
          var when = textToWhen(row.whenText);
          if (when !== undefined) { el.when = when; } else { delete el.when; }
          return el;
        })
      });
      if (costAccessSequence) { doc.costAccessSequence = costAccessSequence; } else { delete doc.costAccessSequence; }
      delete doc.provenance; // server stamps HUMAN/<user> itself — never trusted from the payload

      vm.setProperty("/busy", true);
      this.callRest("/rest/config/saveRegionConfig", { body: { payload: doc } })
        .then(function (saved) {
          that._message(that.getView().getModel("i18n").getResourceBundle().getText("savedAsVersion", [saved.version]), "Success");
          that._reloadAll();
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.setProperty("/busy", false); });
    },

    onLookupPriceList: function () {
      var that = this;
      var vm = this._vm();
      var pl = vm.getProperty("/priceList");
      var params = new URLSearchParams({ region: vm.getProperty("/selectedRegion"), partNumber: pl.partNumber, quantity: pl.quantity || "1" });
      if (pl.supplier) { params.set("supplier", pl.supplier); }
      if (pl.productCategory) { params.set("productCategory", pl.productCategory); }
      if (pl.asOf) { params.set("asOf", pl.asOf); }

      vm.setProperty("/busy", true);
      this.callRest("/rest/config/lookupPriceList?" + params.toString())
        .then(function (res) {
          vm.setProperty("/priceList/looked", true);
          vm.setProperty("/priceList/entry", res.entry || null);
          vm.setProperty("/priceList/matchedBy", res.matchedBy || "");
          vm.setProperty("/priceList/triedText", (res.tried || []).join(", ") || "—");
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.setProperty("/busy", false); });
    },

    onSimulate: function () {
      var that = this;
      var vm = this._vm();
      var sim = vm.getProperty("/sim");
      var item = { partNumber: (sim.partNumber || "").trim(), quantity: Number(sim.quantity) || 1, pricingType: sim.pricingType };
      if ((sim.supplier || "").trim()) { item.supplier = sim.supplier.trim(); }
      if ((sim.productCategory || "").trim()) { item.productCategory = sim.productCategory.trim(); }

      vm.setProperty("/busy", true);
      this.callRest("/rest/pricing/price", {
        body: { payload: { region: vm.getProperty("/selectedRegion"), salesOrg: "*", hostSystem: "C4C", hostObjectType: sim.objectType, items: [item] } }
      })
        .then(function (res) {
          var line = res.items[0];
          vm.setProperty("/sim/line", line);
          if (line.status === "PRICED") {
            var amount = line.result.landedCost !== undefined ? line.result.landedCost : line.result.unitPrice;
            var label = line.result.landedCost !== undefined ? "landed cost" : "unit price";
            vm.setProperty("/sim/resultText", line.partNumber + ": " + label + " " + that.formatter.fmt2(amount) + " " + line.result.currency);
            vm.setProperty("/sim/resultState", "Success");
          } else {
            vm.setProperty("/sim/resultText", line.status + " — " + (line.missing ? line.missing.reason : ""));
            vm.setProperty("/sim/resultState", "Error");
          }
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.setProperty("/busy", false); });
    },

    onShowSimTrace: function () {
      var line = this._vm().getProperty("/sim/line");
      if (line) { this.openTraceDialog(this.getView(), line); }
    },

    onOpenPricing: function () {
      this.getRouter().navTo("pricing");
    }
  });
});
