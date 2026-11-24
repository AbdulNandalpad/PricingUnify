sap.ui.define([
  "./BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/core/Fragment"
], function (BaseController, JSONModel, Fragment) {
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
        selectedCount: 0,
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
        customerPartNumber: "", ood: "", warehouse: "", picks: "", leadTime: "", additionalCost: "",
        priceBreak: false, alternativeToLine: "",
        sourceErp: "", cost: "", landedCost: "", price: "", marginPct: "", lineValue: "",
        status: "", confidence: "", line: null
      };
    },

    _vm: function () { return this.getView().getModel("vm"); },

    /** C4C line numbering: 10, 20, 30, … starting at 10. Lines that already carry a number
     *  (loaded from C4C with its own ItemID, or numbered earlier) KEEP it — removing a line
     *  never renumbers the rest, so "Alt. line" links and C4C's own IDs stay valid. Only
     *  lines without a number get the next free multiple of 10. */
    _renumber: function (items) {
      var max = 0;
      items.forEach(function (row) {
        var n = parseInt(row.itemNo, 10);
        if (n > max) { max = n; }
      });
      items.forEach(function (row) {
        if (!(parseInt(row.itemNo, 10) > 0)) {
          max = Math.floor(max / 10) * 10 + 10;
          row.itemNo = String(max);
        }
      });
      this._vm().setProperty("/itemCount", items.length);
      // Any change to the line list invalidates index-based row selection — reset it so
      // "Remove selected" never acts on lines the user didn't tick.
      var table = this.byId("itemTable");
      if (table) { table.clearSelection(); }
      this._vm().setProperty("/selectedCount", 0);
      return items;
    },

    /** Row selectors / the header checkbox -> drives the visibility of "Remove selected". */
    onSelectionChange: function () {
      this._vm().setProperty("/selectedCount", this.byId("itemTable").getSelectedIndices().length);
    },

    _addRow: function () {
      var items = this._vm().getProperty("/items");
      items.push(this._newRow());
      this._vm().setProperty("/items", this._renumber(items));
    },

    onAddRow: function () { this._addRow(); },

    // ---- Add-item dialog: type-ahead against C4C's product master (local recorded catalog
    // until a C4C connection exists — the dialog says which answered), optional quantity
    // breaks generating extra lines with Price break + Alternative line set by default,
    // mirroring how the C4C Products tab models them. ----

    onOpenAddItem: function () {
      var that = this;
      var view = this.getView();
      this._vm().setProperty("/addItem", {
        partNumber: "", description: "", quantity: "1",
        withBreaks: false, breakQtys: "10, 25, 50",
        suggestions: [], sourceNote: "", searching: false
      });
      if (!this._addItemDialogPromise) {
        this._addItemDialogPromise = Fragment.load({
          id: view.getId(), name: "com.tss.pricing.c4c.view.AddItemDialog", controller: this
        }).then(function (dialog) { view.addDependent(dialog); return dialog; });
      }
      this._addItemDialogPromise.then(function (dialog) { that._addItemDialog = dialog; dialog.open(); });
    },

    onCloseAddItem: function () {
      if (this._addItemDialog) { this._addItemDialog.close(); }
    },

    onAddItemSuggest: function (oEvent) {
      var that = this;
      // The server already filters (C4C startswith / local-catalog substring) — the Input's
      // own client-side starts-with filter would hide substring matches, so disable it.
      var input = oEvent.getSource();
      input.setFilterFunction(function () { return true; });
      var value = (oEvent.getParameter("suggestValue") || "").trim();
      if (this._suggestTimer) { clearTimeout(this._suggestTimer); }
      if (value.length < 2) { this._vm().setProperty("/addItem/suggestions", []); return; }
      this._suggestTimer = setTimeout(function () {
        that._vm().setProperty("/addItem/searching", true);
        that.callRest("/rest/pricing/searchC4cProducts", {
          body: { payload: { query: value, region: that.getSession().getProperty("/region") } }
        })
          .then(function (res) {
            var bundle = that.getView().getModel("i18n").getResourceBundle();
            if (res.status !== "OK") {
              // A failed search is said, not silent — the dialog's note line shows why.
              that._vm().setProperty("/addItem/suggestions", []);
              that._vm().setProperty("/addItem/sourceNote", res.message || res.status || "");
              return;
            }
            that._vm().setProperty("/addItem/suggestions", res.products || []);
            that._vm().setProperty("/addItem/sourceNote",
              (res.note ? res.note + " " : "") +
              (res.source === "C4C" ? bundle.getText("addItemSourceC4c")
                : res.source === "LOCAL_CATALOG" ? bundle.getText("addItemSourceLocal") : ""));
            // The popup only opens on its own if items exist when the suggest event fires;
            // ours arrive asynchronously, so open it explicitly once they're in.
            if ((res.products || []).length > 0) {
              setTimeout(function () { input.showItems(function () { return true; }); }, 0);
            }
          })
          .catch(function () { /* suggestions are a convenience — typing stays possible */ })
          .finally(function () { that._vm().setProperty("/addItem/searching", false); });
      }, 300);
    },

    onAddItemSuggestionPicked: function (oEvent) {
      var item = oEvent.getParameter("selectedItem");
      if (!item) { return; }
      this._vm().setProperty("/addItem/partNumber", item.getKey());
      if (item.getAdditionalText()) { this._vm().setProperty("/addItem/description", item.getAdditionalText()); }
    },

    onConfirmAddItem: function () {
      var vm = this._vm();
      var add = vm.getProperty("/addItem");
      var part = (add.partNumber || "").trim();
      if (!part) { return; }

      var items = vm.getProperty("/items").filter(function (row) { return (row.partNumber || "").trim() !== "" || row.line; });
      var main = this._newRow();
      main.partNumber = part;
      main.description = add.description || "";
      main.quantity = String(Number(add.quantity) || 1);
      items.push(main);
      this._renumber(items);
      var mainLineNo = main.itemNo; // C4C-style number (10, 20, …) the break lines point back at

      var breakCount = 0;
      if (add.withBreaks) {
        var mainQty = Number(main.quantity);
        String(add.breakQtys || "").split(",")
          .map(function (s) { return Number(s.trim()); })
          .filter(function (n) { return Number.isFinite(n) && n > 0 && n !== mainQty; })
          .forEach(function (qty) {
            var breakRow = Object.assign({}, main);
            breakRow.quantity = String(qty);
            // C4C's own modeling of a quantity break: an extra line flagged Price break,
            // pointing back at the main line — both set by default, per the owner.
            breakRow.priceBreak = true;
            breakRow.alternativeToLine = String(mainLineNo);
            breakRow.line = null;
            breakRow.itemNo = 0; // gets its own next number (not a copy of the main line's)
            items.push(breakRow);
            breakCount++;
          });
      }

      vm.setProperty("/items", this._renumber(items));
      vm.setProperty("/hasResults", false);
      vm.setProperty("/orderTotal", "");
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      this._message(breakCount > 0 ? bundle.getText("addItemDoneBreaks", [part, breakCount]) : bundle.getText("addItemDone", [part]), "Success");
      this.onCloseAddItem();
    },

    onRemoveRow: function (oEvent) {
      var ctx = oEvent.getSource().getBindingContext("vm");
      var index = Number(ctx.getPath().split("/").pop());
      var items = this._vm().getProperty("/items");
      items.splice(index, 1);
      if (items.length === 0) { items.push(this._newRow()); }
      this.byId("itemTable").clearSelection();
      this._vm().setProperty("/items", this._renumber(items));
    },

    /** Remove every selected line at once — the table's row selectors (and the select-all
     *  checkbox in its header) feed this, so "select all + Remove selected" clears the grid. */
    onRemoveSelected: function () {
      var table = this.byId("itemTable");
      var selected = table.getSelectedIndices();
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      if (selected.length === 0) { return; }
      var items = this._vm().getProperty("/items");
      selected.slice().sort(function (a, b) { return b - a; }).forEach(function (i) {
        if (i >= 0 && i < items.length) { items.splice(i, 1); }
      });
      var removed = selected.length;
      if (items.length === 0) { items.push(this._newRow()); }
      table.clearSelection();
      this._vm().setProperty("/items", this._renumber(items));
      this._vm().setProperty("/hasResults", false);
      this._vm().setProperty("/orderTotal", "");
      this._message(bundle.getText("removedLines", [removed]), "Success");
    },

    /** Fill blank Description / UoM / Stock class from the C4C product master — a convenience
     *  pass after a quote load or an import. Only ever fills blanks (never overwrites a value
     *  already there). Stock class arrives as a raw ERP code resolved by srv through the
     *  region's own stock-class map; anything unresolved is reported, never guessed. A typed
     *  non-OK outcome (C4C not connected, lookup error) just skips it. Returns a promise so a
     *  caller keeps the grid busy until it's done. */
    _enrichFromProductMaster: function () {
      var that = this;
      var vm = this._vm();
      var parts = vm.getProperty("/items")
        .filter(function (r) {
          return (r.partNumber || "").trim() &&
            (!(r.description || "").trim() || !(r.uom || "").trim() || !r.stockClassSel);
        })
        .map(function (r) { return r.partNumber.trim(); });
      if (parts.length === 0) { return Promise.resolve(); }
      var session = this.getSession();
      vm.setProperty("/busy", true);
      return this.callRest("/rest/pricing/fetchC4cProductDetails", {
        body: { payload: { partNumbers: parts, region: session.getProperty("/region"), salesOrg: session.getProperty("/salesOrg") } }
      })
        .then(function (res) {
          if (res.status !== "OK") { return; }
          var items = vm.getProperty("/items");
          var notes = {};
          items.forEach(function (r) {
            var p = res.products[(r.partNumber || "").trim()];
            if (!p) { return; }
            if (!(r.description || "").trim() && p.description) { r.description = p.description; }
            if (!(r.uom || "").trim() && p.uom) { r.uom = p.uom; }
            if (!r.stockClassSel) {
              if (p.stockClass) { r.stockClassSel = p.stockClass; }
              else if (p.stockClassNote && p.stockClassNote !== "NO_STOCK_CLASS_IN_C4C") { notes[p.stockClassNote] = true; }
            }
          });
          vm.setProperty("/items", items);
          var keys = Object.keys(notes);
          if (keys.length > 0) {
            var bundle = that.getView().getModel("i18n").getResourceBundle();
            that._message(bundle.getText("stockClassUnresolved", [keys.join(", ")]), "Warning");
          }
        })
        .catch(function () { /* enrichment is a convenience — the grid stays usable without it */ })
        .finally(function () { vm.setProperty("/busy", false); });
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
        if ((row.ood || "").trim()) { item.ood = row.ood.trim(); }
        if ((row.warehouse || "").trim()) { item.warehouse = row.warehouse.trim(); }
        if ((row.additionalCost || "").trim() !== "") { item.additionalCost = String(row.additionalCost).trim(); }
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
              var lv = Number(amount) * Number(line.result.quantity);
              row.lineValue = Number.isFinite(lv)
                ? lv.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : "";
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
              row.lineValue = "";
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
          if (res && (res.status === "C4C_NOT_CONFIGURED" || res.status === "C4C_CREDENTIALS_MISSING")) {
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

    /** Load a quote/opportunity's items straight from C4C (fetchC4cObject) — the
     *  "replace the C4C Products tab" flow. Typed non-OK outcomes show honestly: not
     *  configured / credentials missing / object not found — items are never invented. */
    onLoadObject: function () {
      var that = this;
      var value = (this.byId("objectSearch").getValue() || "").trim();
      if (!value) { return; }
      var vm = this._vm();
      vm.setProperty("/busy", true);
      this.callRest("/rest/pricing/fetchC4cObject", {
        body: { payload: { objectType: this.getSession().getProperty("/objectType"), objectId: value } }
      })
        .then(function (res) {
          var bundle = that.getView().getModel("i18n").getResourceBundle();
          if (res.status === "OK") {
            that.getSession().setProperty("/objectId", value);
            vm.setProperty("/header", { account: res.header.account || "", currency: res.header.currency || "" });
            var rows = (res.items || []).map(function (it) {
              var row = that._newRow();
              row.itemNo = (it.itemId || "").trim(); // keep C4C's own item number (blank -> auto)
              row.partNumber = it.partNumber || "";
              row.description = it.description || "";
              // OData decimals come as '50000.00000000000000' — normalize for the grid.
              row.quantity = Number.isFinite(Number(it.quantity)) && Number(it.quantity) > 0 ? String(Number(it.quantity)) : "1";
              row.uom = it.uom || row.uom;
              row.customerPartNumber = (it.customerPartNumber || "").trim();
              row.ood = (it.ood || "").trim();
              row.warehouse = (it.warehouse || "").trim();
              row.picks = Number.isFinite(Number(it.picks)) && it.picks !== "" ? String(Number(it.picks)) : (it.picks || "");
              row.leadTime = (it.leadTime || "").trim();
              row.additionalCost = (it.additionalCost || "").trim();
              row.supplier = (it.supplier || "").trim();
              row.productCategory = (it.productCategory || "").trim();
              row.priceBreak = !!it.priceBreak;
              row.alternativeToLine = (it.alternativeToLine || "").trim();
              return row;
            });
            if (rows.length === 0) { rows.push(that._newRow()); }
            vm.setProperty("/items", that._renumber(rows));
            vm.setProperty("/hasResults", false);
            vm.setProperty("/orderTotal", "");
            // The items' Origin of Data resolves the pricing region via region-route (e.g.
            // SMA -> AMERICAS) — set it so the right region config prices this quote.
            if (res.region && res.region.value) { that.getSession().setProperty("/region", res.region.value); }
            that._message(bundle.getText("c4cLoaded", [res.items.length, value]) +
              (res.region && res.region.value ? " " + bundle.getText("c4cRegionSet", [res.region.value]) : ""), "Success");
            return that._enrichFromProductMaster();
          } else if (res.status === "C4C_NOT_CONFIGURED" || res.status === "C4C_CREDENTIALS_MISSING") {
            that._message(res.message, "Warning");
          } else {
            that._message(res.message || res.status, "Error");
          }
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.setProperty("/busy", false); });
    },

    // ---- Excel/CSV import: paste from Excel (tab-separated) or upload a CSV export of the
    // C4C Products tab — columns are matched by the C4C screen's own header names, extra
    // columns are ignored, so the original list is usable as-is. ----

    onOpenImport: function () {
      var that = this;
      var view = this.getView();
      this._vm().setProperty("/importText", "");
      if (!this._importDialogPromise) {
        this._importDialogPromise = Fragment.load({
          id: view.getId(), name: "com.tss.pricing.c4c.view.ImportDialog", controller: this
        }).then(function (dialog) { view.addDependent(dialog); return dialog; });
      }
      this._importDialogPromise.then(function (dialog) { that._importDialog = dialog; dialog.open(); });
    },

    onCloseImport: function () {
      if (this._importDialog) { this._importDialog.close(); }
    },

    onPickImportFile: function () {
      var that = this;
      var input = document.createElement("input");
      input.type = "file";
      input.accept = ".csv,.txt,.tsv";
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        if (!file) { return; }
        var reader = new FileReader();
        reader.onload = function () { that._vm().setProperty("/importText", String(reader.result || "")); };
        reader.readAsText(file);
      });
      input.click();
    },

    onRunImport: function () {
      var count = this._importRows(this._vm().getProperty("/importText") || "");
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      this._message(count > 0 ? bundle.getText("importDone", [count]) : bundle.getText("importNone"), count > 0 ? "Success" : "Warning");
      if (count > 0) { this.onCloseImport(); this._enrichFromProductMaster(); }
    },

    _importRows: function (text) {
      var that = this;
      var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
      if (lines.length === 0) { return 0; }
      var delim = lines[0].indexOf("\t") >= 0 ? "\t" : (lines[0].indexOf(";") >= 0 && lines[0].indexOf(",") < 0 ? ";" : ",");

      function parseLine(line) {
        if (delim === "\t") { return line.split("\t").map(function (s) { return s.trim(); }); }
        var out = [], cur = "", quoted = false;
        for (var i = 0; i < line.length; i++) {
          var ch = line[i];
          if (ch === '"') { quoted = !quoted; }
          else if (ch === delim && !quoted) { out.push(cur.trim()); cur = ""; }
          else { cur += ch; }
        }
        out.push(cur.trim());
        return out;
      }

      // Header names as the C4C Products tab (and our own grid) spell them.
      var HEADER_MAP = {
        "product id": "partNumber", "product": "partNumber", "part number": "partNumber", "partnumber": "partNumber",
        "product description": "description", "description": "description",
        "quantity": "quantity", "qty": "quantity",
        "uom": "uom", "unit": "uom", "quantity uom": "uom",
        "customer part number": "customerPartNumber", "customer part no": "customerPartNumber",
        "origin of data": "ood", "data origin": "ood", "ood": "ood",
        "warehouse id": "warehouse", "warehouse": "warehouse",
        "no. of picks": "picks", "no of picks": "picks", "picks": "picks",
        "lead time (weeks)": "leadTime", "quoted lead time (weeks)": "leadTime", "lead time": "leadTime",
        "additional cost": "additionalCost", "addl cost": "additionalCost", "add cost": "additionalCost",
        "supplier": "supplier", "supplier external id": "supplier",
        "supplier country": "supplierCountry",
        "product category": "productCategory", "category": "productCategory",
        "stock class": "stockClassSel", "mts/mtc": "stockClassSel",
        "pricing type": "pricingType",
        "price break": "priceBreak", "alternative to line": "alternativeToLine", "alternative line": "alternativeToLine"
      };
      var firstCells = parseLine(lines[0]).map(function (h) { return HEADER_MAP[h.toLowerCase().replace(/:$/, "").trim()]; });
      var hasHeader = firstCells.some(Boolean);
      var fields = hasHeader ? firstCells : ["partNumber", "quantity"];
      var rows = [];
      for (var i = hasHeader ? 1 : 0; i < lines.length; i++) {
        var vals = parseLine(lines[i]);
        var row = that._newRow();
        fields.forEach(function (field, j) {
          if (!field || vals[j] === undefined || vals[j] === "") { return; }
          var value = vals[j];
          if (field === "stockClassSel") {
            value = value === "MTS" ? "MTS" : (/^non.?mts$/i.test(value) ? "NonMTS" : "");
            if (!value) { return; } // raw ERP codes stay auto — the backend normalizes via config
          }
          if (field === "pricingType") { value = /price.?list/i.test(value) ? "PRICE_LIST" : "COST_PLUS"; }
          if (field === "priceBreak") { value = /^(x|true|yes|✓|1)$/i.test(String(value).trim()); }
          row[field] = value;
        });
        if ((row.partNumber || "").trim()) { rows.push(row); }
      }
      if (rows.length > 0) {
        var vm = this._vm();
        vm.setProperty("/items", this._renumber(rows));
        vm.setProperty("/hasResults", false);
        vm.setProperty("/orderTotal", "");
      }
      return rows.length;
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
