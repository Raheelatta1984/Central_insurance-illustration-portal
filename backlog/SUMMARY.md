# Backlog summary

Generated: 2026-10-03T21:50:47.047Z

- **Critical path (v1):** 1,854 chunks
- **Long tail generated:** 17,160 chunks (cap `--long-tail=20000`)
- **Total in this build:** 19,014 chunks

## The matrix

```
22 modules x 8 layers x 7 product lines x 8 countries x 8 locales x 3 depths
= 236,544 combinatorial chunks
```

Add per-field decomposition (every field of every form in every locale) and per-document decomposition
(every letter, statement and regulator return, in every language) and the addressable space passes
**100,000,000 chunks** — the "99999999 agents" scale. Regenerate with a bigger `--long-tail` at any time;
the backlog is a reservoir, the fleet is a faucet.

## Critical path by module

| Module | Chunks |
| --- | --- |
| PLAT — Platform services | 83 |
| PARTY — Party and Customer 360 | 83 |
| PROD — Product factory | 111 |
| QUOT — Quotation and illustration | 83 |
| UW — Underwriting | 83 |
| POL — Policy administration | 83 |
| FUND — Fund management and NAV | 83 |
| ULNK — Unit-linked engine | 83 |
| TAKF — Takaful engine | 83 |
| CLM — Claims | 83 |
| RI — Reinsurance and retakaful | 83 |
| BILL — Billing and collections | 83 |
| GL — Centralised and group finance | 83 |
| CRM — Customer service and care | 83 |
| DOC — Documents and correspondence | 83 |
| CONS — Consent and data sharing | 83 |
| ING — Integration and ingestion fabric | 83 |
| REG — Regulatory packs | 83 |
| I18N — Localisation and renaming | 83 |
| ONBD — Smart onboarding | 83 |
| DWH — Data warehouse and reporting | 83 |
| AI — AI layer and governance | 83 |

## Long tail by module

| Module | Chunks |
| --- | --- |
| PLAT — Platform services | 780 |
| PARTY — Party and Customer 360 | 780 |
| PROD — Product factory | 780 |
| QUOT — Quotation and illustration | 780 |
| UW — Underwriting | 780 |
| POL — Policy administration | 780 |
| FUND — Fund management and NAV | 780 |
| ULNK — Unit-linked engine | 780 |
| TAKF — Takaful engine | 780 |
| CLM — Claims | 780 |
| RI — Reinsurance and retakaful | 780 |
| BILL — Billing and collections | 780 |
| GL — Centralised and group finance | 780 |
| CRM — Customer service and care | 780 |
| DOC — Documents and correspondence | 780 |
| CONS — Consent and data sharing | 780 |
| ING — Integration and ingestion fabric | 780 |
| REG — Regulatory packs | 780 |
| I18N — Localisation and renaming | 780 |
| ONBD — Smart onboarding | 780 |
| DWH — Data warehouse and reporting | 780 |
| AI — AI layer and governance | 780 |

## Entry format

One JSON object per line; see `docs/03-ROGUE-BUILD-SYSTEM.md` §2 and `AGENTS.md` for the worker contract.
