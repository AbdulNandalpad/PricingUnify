sap.ui.define([
  "./BaseController",
  "sap/ui/model/json/JSONModel"
], function (BaseController, JSONModel) {
  "use strict";

  /**
   * The Viewer screen: pricing only, no config anywhere. Items are entered manually until the
   * Phase 5 C4C adapter auto-fills them from the host object (the table and actions stay the
   * same then). "Fetch Costs" resolves item attributes + costs; "Calculate Prices" (QUOTE
   * only) additionally fills Price and Margin %. An OPPORTUNITY is cost-only end to end —
   * srv already refuses to return a price for it, the UI just mirrors that.
   */
  return BaseController.extend("com.tss.pricing.c4c.controller.Pricing", {

    onInit: function () {
      var vm = new JSONModel({
        header: { account: "", currency: "" },
        items: [],
        busy: false,
        hasResults: false,
        showAdvanced: false,
        itemCount: 0,
        orderTotal: "",
        message: "",
        messageType: "Information"
      });
      this.getView().setModel(vm, "vm");
      this._addRow();
    },

    _newRow: function () {
      return {
        itemNo: 0, partNumber: "", description: "", quantity: "1", uom: "PC",
        stockClassSel: "", supplier: "", productCategory: "", pricingType: "COST_PLUS",
        sourceErp: "", cost: "", landedCost: "", price: "", marginPct: "",
        status: "", confidence: "", line: null
      };
    },

    _vm: function () { return this.getView().getModel("vm"); },

    _renumber: function (items) {
      items.forEach(function (row, i) { row.itemNo = i + 1; });
      this._vm().setProperty("/itemCount", items.length);
      return items;
    },

    _addRow: function () {
      var items = this._vm().getProperty("/items");
      items.push(this._newRow());
      this._vm().setProperty("/items", this._renumber(items));
    },

    onAddRow: function () { this._addRow(); },

    onRemoveRow: function (oEvent) {
      var ctx = oEvent.getSource().getBindingContext("vm");
      var index = Number(ctx.getPath().split("/").pop());
      var items = this._vm().getProperty("/items");
      items.splice(index, 1);
      if (items.length === 0) { items.push(this._newRow()); }
      this._vm().setProperty("/items", this._renumber(items));
    },

    _message: function (text, type) {
      this._vm().setProperty("/message", text);
      this._vm().setProperty("/messageType", type || "Information");
    },

    onCloseMessage: function () { this._message(""); },

    /** Rows with a part number, in table order, plus the row indexes they came from — results
     *  zip back by position, never by guessing (blank rows are skipped, order is preserved). */
    _payloadItems: function () {
      var rows = this._vm().getProperty("/items");
      var payloadItems = [];
      var rowIndexes = [];
      rows.forEach(function (row, i) {
        var part = (row.partNumber || "").trim();
        if (!part) { return; }
        var item = { partNumber: part, quantity: Number(row.quantity) || 1, pricingType: row.pricingType || "COST_PLUS" };
        if (row.stockClassSel) { item.stockClass = row.stockClassSel; }
        if ((row.supplier || "").trim()) { item.supplier = row.supplier.trim(); }
        if ((row.productCategory || "").trim()) { item.productCategory = row.productCategory.trim(); }
        payloadItems.push(item);
        rowIndexes.push(i);
      });
      return { payloadItems: payloadItems, rowIndexes: rowIndexes };
    },

    onFetchCosts: function () { this._runPricing(false); },
    onCalculatePrices: function () { this._runPricing(true); },

    /** Display-only order summary (sum of (price||landed cost) x rule-adjusted qty, per
     *  currency) — plain Number math, deliberately: the engine owns all real pricing math. */
    _orderTotal: function (rows) {
      var totals = {};
      rows.forEach(function (row) {
        if (!row.line || row.line.status !== "PRICED") { return; }
        var unit = Number(row.price || row.landedCost);
        var qty = Number(row.line.result.quantity);
        var currency = row.line.result.currency;
        if (!Number.isFinite(unit) || !Number.isFinite(qty) || !currency) { return; }
        totals[currency] = (totals[currency] || 0) + unit * qty;
      });
      var parts = Object.keys(totals).map(function (currency) {
        return totals[currency].toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + currency;
      });
      if (parts.length === 0) { return ""; }
      return this.getView().getModel("i18n").getResourceBundle().getText("orderTotal", [parts.join(" · ")]);
    },

    _runPricing: function (fillPrices) {
      var that = this;
      var session = this.getSession();
      var vm = this._vm();
      var built = this._payloadItems();
      if (built.payloadItems.length === 0) {
        this._message(this.getView().getModel("i18n").getResourceBundle().getText("noItemsToPrice"), "Warning");
        return;
      }

      var payload = {
        region: session.getProperty("/region"),
        salesOrg: session.getProperty("/salesOrg"),
        hostSystem: "C4C",
        hostObjectType: session.getProperty("/objectType"),
        hostObjectId: session.getProperty("/objectId") || undefined,
        items: built.payloadItems
      };

      vm.setProperty("/busy", true);
      this._message("");

      // Two-call contract (same as production C4C integration): resolve item attributes first,
      // then price with them visible. The attributes call only fills what the user left unset.
      this.callRest("/rest/pricing/fetchItemAttributes", { body: { payload: payload } })
        .then(function (attrRes) {
          var rows = vm.getProperty("/items");
          built.rowIndexes.forEach(function (rowIndex, j) {
            var row = rows[rowIndex];
            var attrs = (attrRes.attributes || {})[built.payloadItems[j].partNumber];
            if (!attrs) { return; }
            if (!row.supplier && attrs.supplier) { row.supplier = attrs.supplier; }
            if (!row.stockClassSel && attrs.stockClass) { row.stockClassSel = attrs.stockClass; }
          });
          vm.setProperty("/items", rows);
          // Re-build the payload so freshly resolved attributes flow into pricing too.
          var rebuilt = that._payloadItems();
          return that.callRest("/rest/pricing/price", { body: { payload: Object.assign({}, payload, { items: rebuilt.payloadItems }) } })
            .then(function (res) { return { res: res, rowIndexes: rebuilt.rowIndexes }; });
        })
        .then(function (zip) {
          var res = zip.res;
          var rows = vm.getProperty("/items");
          var priced = 0;
          (res.items || []).forEach(function (line, j) {
            var row = rows[zip.rowIndexes[j]];
            if (!row) { return; }
            row.line = line;
            row.status = line.status;
            var cc = (line.trace && line.trace.costCandidate) || null;
            row.confidence = cc ? cc.confidence : "";
            row.sourceErp = cc && cc.source ? cc.source.system : "";
            row.cost = cc ? cc.value : "";
            if (line.trace && line.trace.stockClass && !row.stockClassSel) { row.stockClassSel = line.trace.stockClass; }
            if (line.status === "PRICED") {
              priced++;
              var amount = line.result.landedCost !== undefined ? line.result.landedCost : line.result.unitPrice;
              row.landedCost = amount;
              if (fillPrices && line.result.unitPrice !== undefined) {
                row.price = line.result.unitPrice;
                var p = Number(line.result.unitPrice);
                var c = Number(row.cost);
                row.marginPct = (Number.isFinite(p) && Number.isFinite(c) && p > 0) ? (((p - c) / p) * 100).toFixed(1) + " %" : "";
              } else if (!fillPrices) {
                row.price = "";
                row.marginPct = "";
              }
            } else {
              row.landedCost = "";
              row.price = "";
              row.marginPct = "";
            }
          });
          vm.setProperty("/items", rows);
          vm.setProperty("/hasResults", priced > 0);
          vm.setProperty("/orderTotal", that._orderTotal(rows));
          if (res.region && res.region.value) { that.getSession().setProperty("/region", res.region.value); }
          var bundle = that.getView().getModel("i18n").getResourceBundle();
          that._message(bundle.getText(fillPrices ? "pricedSummary" : "costedSummary", [priced, (res.items || []).length]),
            priced === (res.items || []).length ? "Success" : "Warning");
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.setProperty("/busy", false); });
    },

    /** Phase 5 wires this to the real C4C adapter; the endpoint answers with a typed
     *  C4C_NOT_CONFIGURED until a destination exists, which is shown honestly. */
    onWriteBack: function () {
      var that = this;
      var session = this.getSession();
      var vm = this._vm();
      var lines = vm.getProperty("/items").filter(function (row) { return row.line && row.line.status === "PRICED"; });
      if (lines.length === 0) { return; }

      vm.setProperty("/busy", true);
      this.callRest("/rest/pricing/writeBackToC4C", {
        body: {
          payload: {
            objectType: session.getProperty("/objectType"),
            objectId: session.getProperty("/objectId") || "",
            items: lines.map(function (row) {
              return {
                partNumber: row.line.partNumber,
                cost: row.cost,
                landedCost: row.landedCost,
                price: row.price || undefined,
                marginPct: row.marginPct || undefined,
                pricingType: row.pricingType,
                currency: row.line.result ? row.line.result.currency : undefined
              };
            })
          }
        }
      })
        .then(function (res) {
          var bundle = that.getView().getModel("i18n").getResourceBundle();
          if (res && res.status === "C4C_NOT_CONFIGURED") {
            that._message(res.message, "Warning");
          } else if (res && res.status === "C4C_CONFLICT") {
            that._message(bundle.getText("writeBackConflict"), "Error");
          } else if (res && res.status === "C4C_ERROR") {
            that._message(res.message, "Error");
          } else {
            that._message(bundle.getText("writeBackDone", [res.written]), "Success");
          }
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.setProperty("/busy", false); });
    },

    onLoadObject: function () {
      var value = (this.byId("objectSearch").getValue() || "").trim();
      if (!value) { return; }
      this.getSession().setProperty("/objectId", value);
      this._message(this.getView().getModel("i18n").getResourceBundle().getText("standaloneLoadedHint", [value]), "Information");
    },

    onRegionChange: function () {
      this._vm().setProperty("/hasResults", false);
    },

    onOpenAdmin: function () {
      this.getRouter().navTo("admin");
    },

    onCellClick: function () { /* row press handled via the trace button/status */ },

    onShowTrace: function (oEvent) {
      var ctx = oEvent.getSource().getBindingContext("vm");
      var row = ctx.getObject();
      if (!row.line) { return; }
      this.openTraceDialog(this.getView(), row.line);
    },

    onExit: function () { /* trace dialog lifecycle handled in BaseController */ }
  });
});
