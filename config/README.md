# config/ — pricing rules as code

No database: the rules live in the repo and reach PROD through a deploy.

1. Change the rules in **QUA** (Admin screens). The change lives in memory until the service restarts.
2. Admin → **Export configuration** downloads the config as JSON.
3. Save each kind as `config/<kind>.json` (`region-config`, `supplier-config`, `region-route`, `party-config`,
   `connection-config`) — an array of documents, exactly as exported. Commit and deploy.
4. On boot the service applies these files after the built-in seed. A version that already exists is skipped; a new
   version takes over from its `validFrom`. An invalid document stops the boot with the file named.

`TSS_ENVIRONMENT=PROD` is read-only by default (`TSS_CONFIG_EDIT=true` overrides). Demo suppliers/customers are
seeded in QUA only (`TSS_SEED_DEMO=true` overrides), so PROD gets its real supplier terms from
`config/supplier-config.json`. `connection-config` documents are stamped with the environment they were saved under
and apply only there. Set `TSS_CONFIG_DIR` to read another folder.
