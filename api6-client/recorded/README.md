# Recorded API6 payloads
Real (anonymized) API6 responses for offline dev + golden tests.
Naming: `<region>-<scenario>.json` e.g. `americas-mts-mroq.json`, `china-sap-fallback.json`.

`europe-default.json`'s `qtyBreaks` block (part `P-90500`) is a real China quantity-break
table from `Pricing_Tabular_4_2.xlsx` ("test list China" sheet), reused here purely to
exercise the Americas MROQ-override standalone flow (`item.ood === 'SMA'`, see
`srv/pricing-service.js`'s `applyMroqOverrides`) — Phase 1 only seeds one region end to end,
so this demos the mechanism without a real Americas region-config yet.
