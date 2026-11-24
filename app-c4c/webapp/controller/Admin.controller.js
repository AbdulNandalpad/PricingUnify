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
        suppliers: { list: [], doc: null, isNew: false, versionCount: 0 },
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
      this._loadSuppliers();
    },

    // ---- Suppliers: freight / duty / tariff RATES per supplier x destination warehouse ----
    // Shown and typed as percentages (0.6 = 0.6 %), stored as ratios (0.006). Every save is a
    // new effective-dated version (validated server-side, provenance stamped by the server).
    _ratioToPct: function (r) {
      if (r === undefined || r === null || r === "") { return ""; }
      var n = Number(r);
      return Number.isFinite(n) ? String(parseFloat((n * 100).toPrecision(12))) : String(r);
    },
    _pctToRatio: function (p) {
      var t = String(p === undefined || p === null ? "" : p).trim();
      if (t === "") { return null; }
      var n = Number(t);
      return Number.isFinite(n) ? String(parseFloat((n / 100).toPrecision(12))) : t;
    },
    _loadSuppliers: function () {
      var vm = this._vm();
      return this.callRest("/rest/config/listSuppliers").then(function (res) {
        vm.setProperty("/suppliers/list", (res.suppliers || []).map(function (d) {
          return { supplier: d.supplier, supplierCountry: d.supplierCountry || "", warehouseText: Object.keys(d.warehouses || {}).join(", "), version: d.version };
        }));
      }).catch(function () { /* the tab shows its empty state; other tabs are unaffected */ });
    },
    onSupplierSelect: function (oEvent) {
      var item = oEvent.getParameter("listItem");
      var ctx = item && item.getBindingContext("vm");
      if (ctx) { this._openSupplier(ctx.getObject().supplier); }
    },
    _openSupplier: function (id) {
      var that = this;
      var vm = this._vm();
      var today = new Date().toISOString().slice(0, 10);
      return Promise.all([
        this.callRest("/rest/config/getEffectiveSupplierConfig?supplier=" + encodeURIComponent(id)),
        this.callRest("/rest/config/listSupplierConfigVersions?supplier=" + encodeURIComponent(id)).catch(function () { return { versions: [] }; })
      ]).then(function (r) {
        var d = r[0];
        var n = (r[1].versions || []).length + 1;
        vm.setProperty("/suppliers/isNew", false);
        vm.setProperty("/suppliers/doc", {
          supplier: d.supplier, supplierCountry: d.supplierCountry || "", molv: d.molv === null || d.molv === undefined ? "" : String(d.molv),
          currentVersion: d.version, version: today + "-r" + n, validFrom: today,
          warehouses: Object.keys(d.warehouses || {}).map(function (code) {
            var w = d.warehouses[code] || {};
            return { code: code, freightPct: that._ratioToPct(w.freight), dutyPct: that._ratioToPct(w.duty), tariffPct: that._ratioToPct(w.tariff) };
          })
        });
      }).catch(function (err) { that._message(String(err.message || err), "Error"); });
    },
    onNewSupplier: function () {
      var vm = this._vm();
      var today = new Date().toISOString().slice(0, 10);
      vm.setProperty("/suppliers/isNew", true);
      vm.setProperty("/suppliers/doc", { supplier: "", supplierCountry: "", molv: "", currentVersion: "", version: today + "-r1", validFrom: today, warehouses: [{ code: "", freightPct: "", dutyPct: "", tariffPct: "" }] });
    },
    onAddWarehouse: function () {
      var vm = this._vm();
      var rows = vm.getProperty("/suppliers/doc/warehouses");
      rows.push({ code: "", freightPct: "", dutyPct: "", tariffPct: "" });
      vm.setProperty("/suppliers/doc/warehouses", rows);
    },
    onRemoveWarehouse: function (oEvent) {
      var vm = this._vm();
      var idx = Number(oEvent.getSource().getBindingContext("vm").getPath().split("/").pop());
      var rows = vm.getProperty("/suppliers/doc/warehouses");
      rows.splice(idx, 1);
      vm.setProperty("/suppliers/doc/warehouses", rows);
    },
    onSaveSupplier: function () {
      var that = this;
      var vm = this._vm();
      var d = vm.getProperty("/suppliers/doc");
      var id = String(d.supplier || "").trim(); // exact-match key: a stray space would create a ghost supplier
      if (!id) { this._message("Enter a supplier ID first.", "Warning"); return; }
      var warehouses = {};
      d.warehouses.forEach(function (w) {
        var code = String(w.code || "").trim();
        if (!code) { return; }
        warehouses[code] = { freight: that._pctToRatio(w.freightPct), duty: that._pctToRatio(w.dutyPct), tariff: that._pctToRatio(w.tariffPct) };
      });
      var payload = { supplier: id, version: d.version, validFrom: d.validFrom || undefined, supplierCountry: String(d.supplierCountry || "").trim() || null,
        molv: String(d.molv || "").trim() || null, warehouses: warehouses };
      vm.setProperty("/busy", true);
      this.callRest("/rest/config/saveSupplierConfig", { body: { payload: payload } })
        .then(function (saved) {
          that._message(that.getView().getModel("i18n").getResourceBundle().getText("supplierSaved", [id, saved.version]), "Success");
          return that._loadSuppliers().then(function () { return that._openSupplier(id); });
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.setProperty("/busy", false); });
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
          conn.newVersion = "";
          that._vm().setProperty("/connections", conn);
        })
        .catch(function () { /* non-admin or backend down — tab simply stays empty */ });
    },

    /** Endpoints/paths/field names only — the schema server-side rejects anything that
     *  could smuggle a credential into config. A save is a new version, applied to the
     *  very next outbound call (no restart). */
    onSaveConnections: function () {
      var that = this;
      var vm = this._vm();
      var conn = vm.getProperty("/connections");
      if (!conn) { return; }

      var costSourceEndpoints = {};
      (conn.api6.endpointRows || []).forEach(function (row) {
        if ((row.path || "").trim()) { costSourceEndpoints[row.system] = row.path.trim(); }
      });
      var fieldMap = {};
      (conn.c4c.fieldRows || []).forEach(function (row) {
        if ((row.theirs || "").trim()) { fieldMap[row.ours] = row.theirs.trim(); }
      });

      var payload = {
        version: (conn.newVersion || "").trim() || undefined,
        api6: {
          mode: conn.api6.mode || "recorded",
          baseUrl: (conn.api6.baseUrl || "").trim() || null,
          costSourceEndpoints: costSourceEndpoints,
          priceListEndpoint: (conn.api6.priceListEndpoint || "").trim() || null,
          biPriceListEndpoint: (conn.api6.biPriceListEndpoint || "").trim() || null,
          // The rest of the request mapping is not edited here — passed through so a save never drops it;
          // only the default item type is editable (it decides whether the gateway finds a cost).
          requestMapping: Object.assign({}, conn.api6.requestMapping || {}, { defaultItemTypeDesc: String(conn.api6.itemTypeDesc === undefined ? "" : conn.api6.itemTypeDesc).trim() }),
        },
        c4c: {
          url: (conn.c4c.url || "").trim() || null,
          servicePath: (conn.c4c.servicePath || "").trim() || null,
          fieldMap: fieldMap,
        },
      };

      vm.setProperty("/busy", true);
      this.callRest("/rest/config/saveConnections", { body: { payload: payload } })
        .then(function (saved) {
          that._message(that.getView().getModel("i18n").getResourceBundle().getText("connectionsSaved", [saved.version]), "Success");
          that._loadConnections();
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.setProperty("/busy", false); });
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
