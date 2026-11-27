sap.ui.define([
  "./BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/core/Fragment",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageBox",
  "sap/m/Menu",
  "sap/m/MenuItem"
], function (BaseController, JSONModel, Fragment, Filter, FilterOperator, MessageBox, Menu, MenuItem) {
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
        customer: null,
        items: [],
        busy: false,
        hasResults: false,
        showAdvanced: false, detailIndex: 0,
        itemCount: 0, search: "", shownCount: 0, writableCount: 0,
        // C4C's own item (processing) types — the code is what the gateway receives, the label is what the user reads.
        itemTypes: [
          { key: "AGN", text: "AGN - Product" }, { key: "ZCOM", text: "ZCOM - Kit Components" }, { key: "ZKIT", text: "ZKIT - Kit" },
          { key: "ZPRB", text: "ZPRB - Price Break" }, { key: "ZSMP", text: "ZSMP - Sample" }, { key: "ZSRV", text: "ZSRV - Service" }, { key: "ZTOL", text: "ZTOL - Tool" }
        ],
        selectedCount: 0,
        orderTotal: "",
        message: "",
        messageType: "Information"
      });
      vm.setProperty("/itemTypes", vm.getProperty("/itemTypes").map(function (t) { return Object.assign({}, t, { label: t.text.replace(/^\w+ - /, "") }); }));
      // Overlapping async calls (load -> enrich -> enrich) each hold the grid busy; it only
      // frees when the LAST one finishes — a plain boolean cleared early under a running call.
      vm.busyStart = function () { this._busyN = (this._busyN || 0) + 1; this.setProperty("/busy", true); };
      vm.busyEnd = function () { this._busyN = Math.max(0, (this._busyN || 1) - 1); this.setProperty("/busy", this._busyN > 0); };
      this.getView().setModel(vm, "vm");
      this._addRow();

      // Opened from C4C with a quote/opportunity: load it straight away (no extra click) — the
      // host already told us which object this is. Standalone (no objectId) waits for a search.
      var session = this.getSession();
      if (session.getProperty("/hostContext") && session.getProperty("/objectId")) {
        this._loadObject(session.getProperty("/objectId"));
      }
    },

    _newRow: function () {
      return {
        itemNo: 0, partNumber: "", description: "", quantity: "1", uom: "", itemType: "AGN", priceUnit: "100", // C4C item types: default AGN (Product), the user can choose // C4C's own default: prices and costs are per 100 pieces
        stockClassSel: "", stockClassHow: "", supplier: "", productCategory: "", pricingType: "COST_PLUS",
        customerPartNumber: "", customItemId: "", ood: "", warehouse: "", picks: "1", leadTime: "", additionalCost: "1", // C4C's own defaults on a new line: 1 pick, Additional Cost 1

        priceBreak: false, alternativeToLine: "", parentItemNo: "", perKitQty: "", fromC4c: false, stale: false, // parentItemNo/perKitQty: a kit COMPONENT row (ZCOM) points at its header (ZKIT) and holds the quantity in ONE kit; // fromC4c: itemNo is C4C's own ItemID; stale: inputs changed after the last calculation
        supplierExternalId: "", supplierName: "",
        sourceErp: "", cost: "", landedCost: "", price: "", marginPct: "", lineValue: "",
        priceBy: "", marginNote: "", costManual: false, currency: "", // priceBy: "MARGIN" | "PRICE" = what the user typed last; costManual = a typed cost replaces the fetched one
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
      this._vm().setProperty("/itemCount", items.length);
      var that = this;
      this._vm().setProperty("/writableCount", items.filter(function (r) { return r.line && r.line.status === "PRICED" && !r.stale && !that._isKitRow(r); }).length);
      return items;
    },

    /** Row selectors / the header checkbox -> drives the visibility of "Remove selected". */
    /** Search over the lines already in the grid (product, description, supplier, customer part, item no.). */
    onSearchItems: function (oEvent) {
      var q = String(oEvent.getParameter("newValue") !== undefined ? oEvent.getParameter("newValue") : oEvent.getParameter("query") || "").trim();
      this._vm().setProperty("/search", q);
      var binding = this.byId("itemTable").getBinding("rows");
      if (!q) { binding.filter([]); return; }
      var contains = function (path) { return new Filter(path, FilterOperator.Contains, q); };
      binding.filter([new Filter({
        filters: [contains("partNumber"), contains("description"), contains("supplier"), contains("supplierName"), contains("customerPartNumber"), contains("productCategory"),
          new Filter({ path: "itemNo", test: function (v) { return String(v).indexOf(q) !== -1; } })],
        and: false
      })]);
    },
    onRowsUpdated: function () {
      var binding = this.byId("itemTable").getBinding("rows");
      this._vm().setProperty("/shownCount", binding ? binding.getLength() : 0);
    },

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
        withBreaks: false, breakQtys: "10, 25, 50", isKit: false,
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
      if (this._suggestTimer) { clearTimeout(this._suggestTimer); this._suggestTimer = null; } // a pending search must not reopen the popup on a closed dialog
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
            if ((res.products || []).length > 0 && that._addItemDialog && that._addItemDialog.isOpen()) {
              setTimeout(function () { if (that._addItemDialog.isOpen()) { input.showItems(function () { return true; }); } }, 0);
            }
          })
          .catch(function (err) { that._vm().setProperty("/addItem/sourceNote", String((err && err.message) || err)); }) // typing stays possible
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
      if (add.isKit) { main.itemType = "ZKIT"; }
      if (add.withBreaks && !add.isKit) {
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
      if (add.isKit) { this._explodeKit(main); return; } // fetches the components, then enriches them
      this._enrichFromProductMaster(); // stock type, supplier, description — filled as soon as the line is added
    },

    /** A priced line whose inputs changed no longer matches its result: mark it outdated so it
     *  is neither shown as current nor written back until it is calculated again. */
    onRowEdited: function (oEvent) {
      var ctx = oEvent.getSource().getBindingContext("vm");
      if (!ctx) { return; }
      var row = ctx.getObject();
      if (row.line && !row.stale) { this._vm().setProperty(ctx.getPath() + "/stale", true); }
      if (row.itemType === "ZKIT") { this._staleKitComponents(row); }
      this._updateWritable();
    },

    _staleKitComponents: function (header) {
      var vm = this._vm();
      var items = vm.getProperty("/items");
      items.forEach(function (r, i) { if (r.parentItemNo && r.parentItemNo === header.itemNo && r.line) { vm.setProperty("/items/" + i + "/stale", true); } });
    },

    /** Quantity edited: on a kit header the components follow (component quantity = kit quantity x quantity per kit, as SAP's BOM explosion does). */
    onQtyChange: function (oEvent) {
      var ctx = oEvent.getSource().getBindingContext("vm");
      var row = ctx.getObject();
      if (row.itemType === "ZKIT") { this._syncKitQuantities(row); }
      this.onRowEdited(oEvent);
    },

    _syncKitQuantities: function (header) {
      var vm = this._vm();
      var items = vm.getProperty("/items");
      var headerQty = Number(header.quantity);
      items.forEach(function (r, i) {
        if (r.parentItemNo && r.parentItemNo === header.itemNo) {
          var total = Number(r.perKitQty) * headerQty;
          vm.setProperty("/items/" + i + "/quantity", Number.isFinite(total) && total > 0 ? String(parseFloat(total.toPrecision(12))) : r.quantity);
        }
      });
    },

    /** Kit headers and components are not written back yet: how C4C stores a priced kit (ZKIT + ZCOM items) is not mapped. */
    _isKitRow: function (row) { return row.itemType === "ZKIT" || !!row.parentItemNo; },

    /** Lines that can be written back: priced, still matching their inputs, and not part of a kit. */
    _writableRows: function () {
      var that = this;
      return this._vm().getProperty("/items").filter(function (row) {
        return row.line && row.line.status === "PRICED" && !row.stale && !that._isKitRow(row);
      });
    },
    _updateWritable: function () {
      this._vm().setProperty("/writableCount", this._writableRows().length);
    },

    /** Item type changed. Choosing ZKIT (a kit header) fetches its components from the ERP behind the
     *  line's Origin of Data and lists them under it, numbered 11, 12, 13 …; choosing anything else
     *  removes components a header no longer owns. */
    onItemTypeChange: function (oEvent) {
      var ctx = oEvent.getSource().getBindingContext("vm");
      var row = ctx.getObject();
      if (row.itemType === "ZKIT") {
        if ((row.partNumber || "").trim()) { this._explodeKit(row); }
      } else {
        var items = this._vm().getProperty("/items");
        var kept = items.filter(function (r) { return !(r.parentItemNo && r.parentItemNo === row.itemNo); });
        if (kept.length !== items.length) { this._vm().setProperty("/items", this._renumber(kept)); }
      }
      this.onRowEdited(oEvent);
    },

    onRefetchKit: function (oEvent) {
      this._explodeKit(oEvent.getSource().getBindingContext("vm").getObject());
    },

    /** Fetch one kit header's components (OOD-routed endpoint, srv) and list them under it. Typed outcomes
     *  are shown as they are — a kit with no endpoint answer is never given invented components. */
    _explodeKit: function (header) {
      var that = this;
      var vm = this._vm();
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      var part = (header.partNumber || "").trim();
      if (!part) { return Promise.resolve(); }
      // Numbers used by every OTHER line (the header's current components are about to be replaced, so they do not count).
      var used = vm.getProperty("/items")
        .filter(function (r) { return !(r.parentItemNo && r.parentItemNo === header.itemNo); })
        .map(function (r) { return r.itemNo; });
      vm.busyStart();
      return this.callRest("/rest/pricing/fetchKitComponents", {
        body: { payload: { region: this.getSession().getProperty("/region"), usedItemNos: used,
          kits: [{ partNumber: part, ood: (header.ood || "").trim() || undefined, itemNo: header.itemNo }] } }
      })
        .then(function (res) {
          var kit = (res.kits || [])[0] || {};
          if (kit.status !== "OK") {
            that._message(bundle.getText("kitExplodeFailed", [part, kit.message || kit.status || "?"]), "Warning");
            return;
          }
          var items = vm.getProperty("/items").filter(function (r) { return !(r.parentItemNo && r.parentItemNo === header.itemNo); });
          var at = items.indexOf(header);
          if (at < 0) { return; }
          var headerQty = Number(header.quantity) || 1;
          if (!(header.ood || "").trim() && kit.ood) { header.ood = kit.ood; }
          var parts = kit.components.map(function (c) {
            var row = that._newRow();
            row.itemType = "ZCOM";
            row.parentItemNo = header.itemNo;
            row.itemNo = c.itemNo === null || c.itemNo === undefined ? "" : String(c.itemNo);
            row.partNumber = c.partNumber;
            row.description = c.description || "";
            row.uom = c.uom || "";
            row.perKitQty = String(c.quantity);
            row.quantity = String(parseFloat((Number(c.quantity) * headerQty).toPrecision(12)));
            row.priceUnit = header.priceUnit;
            row.ood = (header.ood || "").trim();
            return row;
          });
          items.splice.apply(items, [at + 1, 0].concat(parts));
          vm.setProperty("/items", that._renumber(items));
          vm.setProperty("/orderTotal", "");
          that._message(bundle.getText("kitExploded", [part, parts.length, kit.ood]), "Success");
          return that._enrichFromProductMaster(); // description, supplier, stock type, warehouse for the components
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.busyEnd(); });
    },

    /** The user picks the stock class by hand — it always wins over any automatic value. */
    onStockClassChange: function (oEvent) {
      var ctx = oEvent.getSource().getBindingContext("vm");
      var row = this._vm().getProperty(ctx.getPath());
      this._vm().setProperty(ctx.getPath() + "/stockClassHow", row.stockClassSel ? "Chosen by you" : "");
      this.onRowEdited(oEvent);
    },

    onRemoveRow: function (oEvent) {
      this._removeRowAt(oEvent.getSource().getBindingContext("vm").getPath());
    },

    _removeRowAt: function (path) {
      var index = Number(path.split("/").pop());
      var items = this._vm().getProperty("/items");
      var gone = items[index];
      if (gone && gone.parentItemNo) { return; } // a component belongs to its kit — remove the kit instead
      items.splice(index, 1);
      if (gone && gone.itemType === "ZKIT") { items = items.filter(function (r) { return r.parentItemNo !== gone.itemNo; }); }
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
      // Selected indices are positions in the (possibly search-FILTERED) table, not in the array:
      // resolve each to the row it shows and remove that row by identity.
      var before = items.length;
      var doomed = selected.map(function (i) { var c = table.getContextByIndex(i); return c ? c.getObject() : null; }).filter(Boolean);
      // A kit header takes its components with it; a component selected without its header stays (it belongs to its kit).
      var headerNos = doomed.filter(function (r) { return r.itemType === "ZKIT"; }).map(function (r) { return r.itemNo; });
      doomed = doomed.filter(function (r) { return !r.parentItemNo || headerNos.indexOf(r.parentItemNo) >= 0; });
      items = items.filter(function (row) { return doomed.indexOf(row) === -1 && !(row.parentItemNo && headerNos.indexOf(row.parentItemNo) >= 0); });
      var removed = before - items.length;
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
      return this._enrichFromOriginOfData().then(function () { return that._enrichFromProductDetails(); });
    },

    /** Supplier ID / external ID / name and the warehouse's stock class from C4C's custom
     *  Origin of Data object (the same lookup C4C's own Supplier Information does), per line:
     *  needs the line's Origin of Data. Fills only BLANK cells — a user's entry always wins.
     *  Ambiguous suppliers / unmapped stock classes are reported, never guessed. */
    _enrichFromOriginOfData: function () {
      var that = this;
      var vm = this._vm();
      var rows = vm.getProperty("/items");
      var lines = [];
      var rowIdx = [];
      rows.forEach(function (r, i) {
        if (!(r.partNumber || "").trim()) { return; }
        if ((r.supplier || "").trim() && (r.supplierExternalId || "").trim() && r.stockClassSel && (r.warehouse || "").trim()) { return; }
        lines.push({ partNumber: r.partNumber.trim(), ood: (r.ood || "").trim(), warehouse: (r.warehouse || "").trim() });
        rowIdx.push(i);
      });
      if (lines.length === 0) { return Promise.resolve(); }
      var session = this.getSession();
      vm.busyStart();
      return this.callRest("/rest/pricing/fetchC4cOriginOfData", {
        body: { payload: { items: lines, region: session.getProperty("/region"), salesOrg: session.getProperty("/salesOrg") } }
      })
        .then(function (res) {
          if (res.status !== "OK") {
            // Say why nothing was filled in, instead of leaving empty cells unexplained.
            that._message((res.message || res.status) + " — supplier, stock type and origin could not be looked up.", "Warning");
            return;
          }
          var items = vm.getProperty("/items");
          var notes = {};
          res.results.forEach(function (o, k) {
            var r = items[rowIdx[k]];
            if (!r) { return; }
            // A line that had no Origin of Data gets its region's own (shown in the column).
            if (o.ood && !(r.ood || "").trim()) { r.ood = o.ood; }
            if (o.warehouse && !(r.warehouse || "").trim()) { r.warehouse = o.warehouse; }
            if (o.supplier) {
              if (!(r.supplier || "").trim()) { r.supplier = o.supplier.id || ""; }
              if (!(r.supplierExternalId || "").trim()) { r.supplierExternalId = o.supplier.externalId || ""; }
              if (!(r.supplierName || "").trim()) { r.supplierName = o.supplier.name || ""; }
            } else if (o.supplierNote === "NO_SUPPLIER_IN_C4C") {
              notes[r.partNumber + ": no supplier record in C4C for origin " + (o.ood || "—") + " (right region / Origin of data?)"] = true;
            } else if (o.supplierNote) {
              notes[r.partNumber + ": " + o.supplierNote] = true;
            }
            if (!r.stockClassSel) {
              if (o.stockClass) {
                r.stockClassSel = o.stockClass;
                r.stockClassHow = o.stockClassBy === "RULE:DEFAULT" ? "Set by the stock-class rule (no special strategy group)"
                  : (o.stockClassBy ? "Set by the stock-class rule " + o.stockClassBy.replace("RULE:", "") : "Read from C4C");
              }
              else if (o.stockClassNote) {
                notes[r.partNumber + ": stock class " + o.stockClassNote] = true;
                // A strategy group overrides the plain stock class: hold the line back so the
                // product-sales fallback below cannot fill in a stock class C4C would not use.
                if (/^STRATEGY_GROUP_RULE_PENDING/.test(o.stockClassNote)) { r.stockClassHold = true; }
              }
            }
          });
          vm.setProperty("/items", items);
          var keys = Object.keys(notes);
          if (keys.length > 0) {
            var bundle = that.getView().getModel("i18n").getResourceBundle();
            // Group by reason so a 27-line quote reads as 2-3 short sentences, not one wall of text.
            var byReason = {};
            keys.forEach(function (k) {
              var i = k.indexOf(": ");
              var part = i < 0 ? k : k.slice(0, i);
              var reason = i < 0 ? "" : k.slice(i + 2);
              (byReason[reason] = byReason[reason] || []).push(part);
            });
            var text = Object.keys(byReason).map(function (reason) {
              var parts = byReason[reason];
              var shown = parts.slice(0, 4).join(", ") + (parts.length > 4 ? " … +" + (parts.length - 4) + " more" : "");
              return (reason || "see lines") + " — " + parts.length + " line" + (parts.length === 1 ? "" : "s") + " (" + shown + ")";
            }).join("; ");
            that._message(bundle.getText("originOfDataNotes", [text]), "Warning");
          }
        })
        .catch(function (err) { that._enrichmentFailed(err); })
        .finally(function () { vm.busyEnd(); });
    },

    /** Enrichment is a convenience — the grid stays usable — but a failure is SAID, never an empty cell with no reason. */
    _enrichmentFailed: function (err) {
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      this._message(bundle.getText("enrichFailed", [String((err && err.message) || err)]), "Warning");
    },

    _enrichFromProductDetails: function () {
      var that = this;
      var vm = this._vm();
      var parts = vm.getProperty("/items")
        .filter(function (r) {
          return (r.partNumber || "").trim() &&
            (!(r.description || "").trim() || !(r.uom || "").trim() || !(r.productCategory || "").trim());
        })
        .map(function (r) { return r.partNumber.trim(); });
      if (parts.length === 0) { return Promise.resolve(); }
      var session = this.getSession();
      vm.busyStart();
      return this.callRest("/rest/pricing/fetchC4cProductDetails", {
        body: { payload: { partNumbers: parts, region: session.getProperty("/region"), salesOrg: session.getProperty("/salesOrg") } }
      })
        .then(function (res) {
          if (res.status !== "OK") { return; }
          var items = vm.getProperty("/items");
          items.forEach(function (r) {
            var p = res.products[(r.partNumber || "").trim()];
            if (!p) { return; }
            if (!(r.description || "").trim() && p.description) { r.description = p.description; }
            if (!(r.uom || "").trim() && p.uom) { r.uom = p.uom; }
            if (!(r.productCategory || "").trim() && p.productCategory) { r.productCategory = p.productCategory; }
          });
          vm.setProperty("/items", items);
        })
        .catch(function (err) { that._enrichmentFailed(err); })
        .finally(function () { vm.busyEnd(); });
    },

    _message: function (text, type) {
      this._vm().setProperty("/message", text);
      this._vm().setProperty("/messageType", type || "Information");
    },

    onCloseMessage: function () { this._message(""); },

    /** One grid row as a pricing item (what the engine receives for an ordinary line). */
    _rowToItem: function (row) {
      var item = { partNumber: (row.partNumber || "").trim(), quantity: Number(row.quantity) || 1, pricingType: row.pricingType || "COST_PLUS" };
      if (String(row.priceUnit || "").trim() !== "") { item.priceUnit = Number(row.priceUnit); }
      // Step 2 of the flow (after Fetch Costs): what the user typed decides the selling price.
      //   typed Price  -> manualPrice (margin is then derived)   typed Margin % -> margin on the landed cost
      //   typed Cost   -> replaces the fetched cost (explicit manual cost; the build-up still applies per Additional Cost)
      if (row.priceBy === "PRICE" && String(row.price || "").trim() !== "") { item.manualPrice = Number(row.price); }
      else if (row.priceBy === "MARGIN" && String(row.marginPct || "").trim() !== "") { item.margin = { marginPct: Number(row.marginPct) }; }
      if (row.costManual && String(row.cost || "").trim() !== "" && row.currency) {
        item.hostCost = { value: String(parseFloat((Number(row.cost) / (Number(row.priceUnit) || 1)).toPrecision(12))), currency: row.currency };
      }
      if ((row.itemType || "").trim()) { item.itemType = row.itemType.trim(); }
      if (row.stockClassSel) { item.stockClass = row.stockClassSel; }
      if ((row.supplier || "").trim()) { item.supplier = row.supplier.trim(); }
      if ((row.supplierExternalId || "").trim()) { item.supplierExternalId = row.supplierExternalId.trim(); }
      if ((row.productCategory || "").trim()) { item.productCategory = row.productCategory.trim(); }
      if ((row.ood || "").trim()) { item.ood = row.ood.trim(); }
      if ((row.warehouse || "").trim()) { item.warehouse = row.warehouse.trim(); }
      if ((row.additionalCost || "").trim() !== "") { item.additionalCost = String(row.additionalCost).trim(); }
      return item;
    },

    /** Rows with a part number, in table order, plus the row indexes they came from — results zip back by
     *  position, never by guessing (blank rows are skipped, order is preserved). A kit header travels with
     *  its components inside it (quantity = quantity in ONE kit; the engine scales by the header quantity);
     *  component rows are never sent on their own, so a kit is never priced twice. */
    _payloadItems: function () {
      var that = this;
      var rows = this._vm().getProperty("/items");
      var payloadItems = [];
      var rowIndexes = [];
      var componentRowIndexes = []; // parallel to payloadItems: the component rows of each kit header
      rows.forEach(function (row, i) {
        if (!(row.partNumber || "").trim() || row.parentItemNo) { return; }
        var item = that._rowToItem(row);
        var compIdx = [];
        if (row.itemType === "ZKIT") {
          // The header has no price of its own to type except a margin (pushed down to its components).
          delete item.manualPrice; delete item.hostCost;
          var comps = [];
          rows.forEach(function (r, k) {
            if (r.parentItemNo && r.parentItemNo === row.itemNo && (r.partNumber || "").trim()) {
              var c = that._rowToItem(r);
              delete c.manualPrice; delete c.margin; delete c.hostCost;
              c.quantity = Number(r.perKitQty) || 1;
              comps.push(c);
              compIdx.push(k);
            }
          });
          if (comps.length) { item.components = comps; }
        }
        payloadItems.push(item);
        rowIndexes.push(i);
        componentRowIndexes.push(compIdx);
      });
      return { payloadItems: payloadItems, rowIndexes: rowIndexes, componentRowIndexes: componentRowIndexes };
    },

    /** The user typed in Cost / Price / Margin %: remember WHAT they typed, it drives the next Calculate Prices. */
    onCostEdit: function (e) { e.getSource().getBindingContext("vm").getModel().setProperty(e.getSource().getBindingContext("vm").getPath() + "/costManual", true); },
    onPriceEdit: function (e) { e.getSource().getBindingContext("vm").getModel().setProperty(e.getSource().getBindingContext("vm").getPath() + "/priceBy", "PRICE"); },
    onMarginEdit: function (e) { e.getSource().getBindingContext("vm").getModel().setProperty(e.getSource().getBindingContext("vm").getPath() + "/priceBy", "MARGIN"); },

    /** ONE action for both host objects (owner 2026-11-27): an OPPORTUNITY gets its cost, a QUOTE cost AND price/margin. */
    onCalculate: function () {
      this._runPricing(this.getSession().getProperty("/objectType") !== "OPPORTUNITY");
    },

    /** Display-only order summary (sum of (price||landed cost) x rule-adjusted qty, per
     *  currency) — plain Number math, deliberately: the engine owns all real pricing math. */
    _orderTotal: function (rows) {
      var totals = {};
      rows.forEach(function (row) {
        if (!row.line || row.line.status !== "PRICED" || row.parentItemNo) { return; } // components are inside their header's value
        var perUnit = Number(row.line.result.priceUnit) || 1; // price/cost unit: the amount is per N pieces
        var unit = Number(row.price) / perUnit; // order total = selling price x qty; cost is never summed here
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

    /** Fill one grid row from one engine line (an ordinary line, a kit header, or a kit component). Returns
     *  { priced, withMargin } so the caller can summarize. Display only — every number comes from the engine. */
    _applyLine: function (row, line) {
      var counts = { priced: 0, withMargin: 0 };
      row.line = line;
      row.status = line.status;
      row.stale = false;

      var cc = (line.trace && line.trace.costCandidate) || null;
      row.confidence = cc ? cc.confidence : "";
      row.sourceErp = cc && cc.source ? cc.source.system : "";
      var rowUnit = Number(row.priceUnit) || 1; // what was sent for this line
      // The cost candidate is per piece; show it per price unit, like the landed cost / price.
      row.cost = cc ? (rowUnit === 1 ? cc.value : String(parseFloat((Number(cc.value) * rowUnit).toPrecision(12)))) : "";
      if (line.trace && line.trace.stockClass && !row.stockClassSel) { row.stockClassSel = line.trace.stockClass; row.stockClassHow = "Resolved by the calculation"; }
      if (line.status === "PRICED") {
        counts.priced = 1;
        var amount = line.result.landedCost !== undefined ? line.result.landedCost : line.result.unitPrice;
        row.landedCost = amount;
        row.currency = line.result.currency || row.currency;
        // Line value is ALWAYS selling price x quantity (owner rule) — never cost. No selling
        // price yet (cost only, or an opportunity) = blank. A cost-based line value exists in C4C
        // only for China / the sales-quote layout: a later item.
        var lv = line.result.sellingPrice !== undefined ? Number(line.result.sellingPrice) / rowUnit * Number(line.result.quantity) : NaN;
        row.lineValue = Number.isFinite(lv)
          ? lv.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : "";
        if (line.result.sellingPrice !== undefined) {
          // The engine did the margin math on the fetched cost: selling price + the margin it implies.
          // Works on the FIRST call too: a typed margin/price, or the region's predefined margin rule.
          row.price = line.result.sellingPrice;
          row.marginPct = line.result.marginPct;
          row.marginNote = line.result.priceBy === "DEFAULT_RULE" ? ("Predefined margin (region rule " + line.result.marginRule + ")") : "";
          counts.withMargin = 1;
        } else if (row.priceBy === "") {
          row.price = ""; row.marginPct = ""; row.marginNote = ""; // nothing typed and no predefined rule: cost only
        }
        // Fetch Costs (or no margin/price typed yet) leaves whatever the user typed untouched.
      } else {
        row.landedCost = "";
        row.lineValue = "";
      }
      return counts;
    },

    /** A kit header has no cost candidate of its own: its Cost column is the roll-up of its components
     *  (their per-piece cost x quantity in one kit, per the header's price unit). Display only. */
    _applyKitHeaderCost: function (row, components) {
      var unit = Number(row.priceUnit) || 1;
      var sum = 0;
      var any = false;
      components.forEach(function (c) {
        var cc = c.trace && c.trace.costCandidate;
        if (cc && Number.isFinite(Number(cc.value))) { sum += Number(cc.value) * Number(c.perKitQuantity); any = true; }
      });
      row.cost = any ? String(parseFloat((sum * unit).toPrecision(12))) : "";
    },

    _runPricing: function (fillPrices) {
      var that = this;
      var session = this.getSession();
      var vm = this._vm();
      var built = this._payloadItems(fillPrices);
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
      // Customer header read from the C4C customer master (when this quote was loaded from C4C).
      var cust = vm.getProperty("/customer");
      if (cust) {
        payload.customerId = cust.customerId || undefined;
        payload.customerOod = cust.originOfData || undefined;
        payload.customer = {
          salesTerritory: cust.salesTerritory, countryCode: cust.countryCode, currency: cust.currency,
          priceGroup: cust.priceGroup, classCode: cust.classCode, segmentCode: cust.segmentCode
        };
      }

      vm.busyStart();
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
            if (!row.stockClassSel && attrs.stockClass) { row.stockClassSel = attrs.stockClass; row.stockClassHow = "From the part's classification"; }
          });
          vm.setProperty("/items", rows);
          // Re-build the payload so freshly resolved attributes flow into pricing too.
          var rebuilt = that._payloadItems(fillPrices);
          return that.callRest("/rest/pricing/price", { body: { payload: Object.assign({}, payload, { items: rebuilt.payloadItems }) } })
            .then(function (res) { return { res: res, rowIndexes: rebuilt.rowIndexes, componentRowIndexes: rebuilt.componentRowIndexes }; });
        })
        .then(function (zip) {
          var res = zip.res;
          var rows = vm.getProperty("/items");
          var priced = 0;
          var pricedWithMargin = 0;
          (res.items || []).forEach(function (line, j) {
            var row = rows[zip.rowIndexes[j]];
            if (!row) { return; }
            var counts = that._applyLine(row, line);
            priced += counts.priced;
            pricedWithMargin += counts.withMargin;
            if (row.itemType === "ZKIT") {
              // The header shows the roll-up of its components; each component row shows its own result.
              var comps = (line.trace && line.trace.components) || [];
              that._applyKitHeaderCost(row, comps);
              (zip.componentRowIndexes[j] || []).forEach(function (rowIdx, k) {
                if (rows[rowIdx] && comps[k]) { that._applyLine(rows[rowIdx], comps[k]); }
              });
            }
          });
          vm.setProperty("/items", rows);
          vm.setProperty("/hasResults", priced > 0);
          vm.setProperty("/orderTotal", that._orderTotal(rows));
          that._updateWritable();
          if (res.region && res.region.value) { that.getSession().setProperty("/region", res.region.value); }
          var bundle = that.getView().getModel("i18n").getResourceBundle();
          var summary = bundle.getText(fillPrices ? "pricedSummary" : "costedSummary", [priced, (res.items || []).length]);
          var recorded = res.api6Mode === "recorded";
          if (priced > 0 && pricedWithMargin === 0) { summary += " " + bundle.getText("enterMarginHint"); }
          if (recorded) { summary += " " + bundle.getText("recordedModeNote"); }
          that._message(summary, (priced === (res.items || []).length && !recorded) ? "Success" : "Warning");
        })
        .catch(function (err) { that._message(String(err.message || err), "Error"); })
        .finally(function () { vm.busyEnd(); });
    },

    /** Write the priced, still-current lines back to the C4C object. Asks first (it changes
     *  the host system), matches C4C items by their own item number, and reports the result. */
    onWriteBack: function () {
      var that = this;
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      var session = this.getSession();
      var objectId = session.getProperty("/objectId") || "";
      var lines = this._writableRows();
      if (lines.length === 0) { return; }
      if (!objectId) { this._message(bundle.getText("writeBackNeedsObject"), "Warning"); return; }
      var skipped = this._vm().getProperty("/items").filter(function (r) { return r.line && r.line.status === "PRICED" && r.stale; }).length;
      var kitRows = this._vm().getProperty("/items").filter(function (r) { return r.line && that._isKitRow(r); }).length;

      MessageBox.confirm(bundle.getText("writeBackConfirm", [lines.length, objectId]) + (skipped ? " " + bundle.getText("writeBackSkipped", [skipped]) : "") + (kitRows ? " " + bundle.getText("writeBackKitSkipped") : ""), {
        title: bundle.getText("writeBack"),
        actions: [bundle.getText("writeBack"), MessageBox.Action.CANCEL],
        emphasizedAction: bundle.getText("writeBack"),
        onClose: function (action) { if (action !== MessageBox.Action.CANCEL) { that._doWriteBack(lines, objectId); } }
      });
    },

    _doWriteBack: function (lines, objectId) {
      var that = this;
      var session = this.getSession();
      var vm = this._vm();
      vm.busyStart();
      this.callRest("/rest/pricing/writeBackToC4C", {
        body: {
          payload: {
            objectType: session.getProperty("/objectType"),
            objectId: objectId,
            items: lines.map(function (row) {
              return {
                partNumber: row.line.partNumber,
                itemId: row.fromC4c ? row.itemNo : undefined, // C4C's own item number: price-break lines share a product
                cost: row.cost,
                landedCost: row.landedCost,
                price: row.price || undefined,
                marginPct: row.marginPct || undefined,
                priceUnit: row.priceUnit || undefined,
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
        .finally(function () { vm.busyEnd(); });
    },

    /** Load a quote/opportunity's items straight from C4C (fetchC4cObject) — the
     *  "replace the C4C Products tab" flow. Typed non-OK outcomes show honestly: not
     *  configured / credentials missing / object not found — items are never invented. */
    onLoadObject: function () {
      this._loadObject((this.byId("objectSearch").getValue() || "").trim());
    },

    onReloadObject: function () {
      this._loadObject(this.getSession().getProperty("/objectId"));
    },

    _loadObject: function (value) {
      var that = this;
      if (!value) { return; }
      var vm = this._vm();
      vm.busyStart();
      this.callRest("/rest/pricing/fetchC4cObject", {
        body: { payload: { objectType: this.getSession().getProperty("/objectType"), objectId: value } }
      })
        .then(function (res) {
          var bundle = that.getView().getModel("i18n").getResourceBundle();
          if (res.status === "OK") {
            that.getSession().setProperty("/objectId", value);
            vm.setProperty("/header", { account: res.header.account || "", currency: res.header.currency || "" });
            vm.setProperty("/customer", res.customer || null);
            var rows = (res.items || []).map(function (it) {
              var row = that._newRow();
              row.itemNo = (it.itemId || "").trim(); // keep C4C's own item number (blank -> auto)
              row.fromC4c = row.itemNo !== ""; // write-back matches these lines to C4C by item number
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
              row.additionalCost = (it.additionalCost || "").trim() || row.additionalCost; // blank in C4C = its default (1)
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
        .finally(function () { vm.busyEnd(); });
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
        "item type": "itemType", "item type description": "itemType", "processing type": "itemType", "itemtypedesc": "itemType",
        "price/cost unit": "priceUnit", "price unit": "priceUnit", "cost unit": "priceUnit", "price per": "priceUnit",
        "customer part number": "customerPartNumber", "customer part no": "customerPartNumber", "tss item id": "customItemId", "tss custom item id": "customItemId", "custom item id": "customItemId",
        "origin of data": "ood", "data origin": "ood", "ood": "ood",
        "warehouse id": "warehouse", "warehouse": "warehouse",
        "no. of picks": "picks", "no of picks": "picks", "picks": "picks",
        "lead time (weeks)": "leadTime", "quoted lead time (weeks)": "leadTime", "lead time": "leadTime",
        "additional cost": "additionalCost", "addl cost": "additionalCost", "add cost": "additionalCost",
        "supplier": "supplier", "supplier id": "supplier", "supplier external id": "supplierExternalId", "supplier ext. id": "supplierExternalId", "supplier ext id": "supplierExternalId", "supplier name": "supplierName",
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
            row.stockClassHow = "Imported";
          }
          if (field === "itemType") {
            // "AGN - Product" / "agn" -> the code; only C4C's known item types are taken, anything else keeps the AGN default
            var code = String(value).split(" - ")[0].trim().toUpperCase();
            if (["AGN", "ZCOM", "ZKIT", "ZPRB", "ZSMP", "ZSRV", "ZTOL"].indexOf(code) === -1) { return; }
            value = code;
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


    /** ⋯ menu at the start of every line: add a quantity break / an alternative (C4C's own modeling: an extra line,
     *  Price break flag + "alternative to line" pointing back at the main line), fetch kit components, remove. */
    onOpenRowMenu: function (oEvent) {
      var that = this;
      var btn = oEvent.getSource();
      var path = btn.getBindingContext("vm").getPath();
      var row = btn.getBindingContext("vm").getObject();
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      if (this._rowMenu) { this._rowMenu.destroy(); }
      var menu = new Menu();
      if (!row.parentItemNo) {
        menu.addItem(new MenuItem({ text: bundle.getText("menuAddBreak"), icon: "sap-icon://add", press: function () { that._addLinkedRow(path, "BREAK"); } }));
        menu.addItem(new MenuItem({ text: bundle.getText("menuAddAlternative"), icon: "sap-icon://duplicate", press: function () { that._addLinkedRow(path, "ALTERNATIVE"); } }));
        if (row.itemType === "ZKIT") {
          menu.addItem(new MenuItem({ text: bundle.getText("kitRefetch"), icon: "sap-icon://refresh", press: function () { that._explodeKit(that._vm().getProperty(path)); } }));
        }
        menu.addItem(new MenuItem({ text: bundle.getText("removeItem"), icon: "sap-icon://delete", startsSection: true, press: function () { that._removeRowAt(path); } }));
      } else {
        menu.addItem(new MenuItem({ text: bundle.getText("kitComponentNoRemove"), enabled: false }));
      }
      this._rowMenu = menu;
      this.getView().addDependent(menu);
      menu.openBy(btn);
    },

    /** A quantity break or an alternative of the line at `path`, placed right under it (and its other breaks). */
    _addLinkedRow: function (path, kind) {
      var vm = this._vm();
      var items = vm.getProperty("/items");
      var index = Number(path.split("/").pop());
      var from = items[index];
      // A break/alternative of a break belongs to the same MAIN line.
      var mainNo = from.alternativeToLine ? Number(from.alternativeToLine) : from.itemNo;
      var main = items.filter(function (r) { return r.itemNo === mainNo; })[0] || from;
      var row = Object.assign({}, main, {
        itemNo: 0, line: null, stale: false, status: "", confidence: "", cost: "", landedCost: "", price: "", marginPct: "", lineValue: "",
        sourceErp: "", marginNote: "", priceBy: "", costManual: false, parentItemNo: "", perKitQty: "", fromC4c: false, alternativeToLine: String(mainNo),
        priceBreak: kind === "BREAK"
      });
      if (kind === "BREAK") { row.quantity = ""; } else { row.partNumber = ""; row.description = ""; }
      // insert after the main line's last linked row
      var at = items.indexOf(main);
      items.forEach(function (r, i) { if (r === main || Number(r.alternativeToLine) === mainNo) { at = i; } });
      items.splice(at + 1, 0, row);
      vm.setProperty("/items", this._renumber(items));
      vm.setProperty("/hasResults", false);
      vm.setProperty("/orderTotal", "");
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      this._message(bundle.getText(kind === "BREAK" ? "breakAdded" : "alternativeAdded", [mainNo]), "Information");
    },

    /** Line popup (WHAT / WHERE / WHY) bound to one line; ← → step through the lines without closing it. */
    onOpenLineDetails: function (oEvent) {
      var that = this;
      var view = this.getView();
      var index = Number(oEvent.getSource().getBindingContext("vm").getPath().split("/").pop());
      if (!this._lineDialogPromise) {
        this._lineDialogPromise = Fragment.load({ id: view.getId(), name: "com.tss.pricing.c4c.view.LineDetails", controller: this })
          .then(function (dialog) { view.addDependent(dialog); return dialog; });
      }
      this._lineDialogPromise.then(function (dialog) { that._lineDialog = dialog; that._showDetailAt(index); dialog.open(); });
    },

    _showDetailAt: function (index) {
      var vm = this._vm();
      var max = vm.getProperty("/items").length - 1;
      index = Math.max(0, Math.min(index, max));
      vm.setProperty("/detailIndex", index);
      this._lineDialog.bindElement({ path: "/items/" + index, model: "vm" });
    },
    onDetailsPrev: function () { this._showDetailAt(this._vm().getProperty("/detailIndex") - 1); },
    onDetailsNext: function () { this._showDetailAt(this._vm().getProperty("/detailIndex") + 1); },
    onCloseDetails: function () {
      if (this._lineDialog) { this._lineDialog.close(); }
      this._updateWritable();
    },

    onShowTrace: function (oEvent) {
      var ctx = oEvent.getSource().getBindingContext("vm");
      var row = ctx.getObject();
      if (!row.line) { return; }
      this.openTraceDialog(this.getView(), row.line);
    }
  });
});
