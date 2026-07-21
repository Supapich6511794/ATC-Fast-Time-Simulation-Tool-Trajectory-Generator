# Vertical limits corrected against AIP Thailand

**Source of truth:** AIP THAILAND, ENR 2.1 (FIR, UIR, TMA) and ENR 5.1, AIRAC cycle
**2026-07-09** (AIRAC AIP AMDT 07/26 — the cycle in force on 2026-07-18), retrieved from
the CAAT eAIP at `aip.caat.or.th`.

Cross-checked against MATS Part II — Area Control Services, `QP-ACC.MK-001` Rev.12
(AEROTHAI Document Directory), which reproduces the ENR 2.1 sector table.

Geometry was **not** touched in any file — only attributes. Verified byte-identical
after edit.

---

## 1. `bacc_geo.geojson` — Bangkok ACC sectors: NO CHANGES (already correct)

The 14 features model the 12 published ACC sectors correctly, including the
two-slab treatment of 3S and 6S. Confirmed against ENR 2.1 "Bangkok Area Control
Centre Sector Organization" (12 sectors):

| Sector | AIP 2026-07-09 | File | |
|---|---|---|---|
| 1N–6N | FL460 / GND | 460 / 0 | OK |
| 1S | FL460 / GND | 460 / 0 | OK |
| 2S | FL460 / FL270 | 460 / 270 | OK |
| 3S | FL460 / GND **and** up to but not incl. FL270 / GND | `3S_upper` 460/270 + `3S_lower` 270/0 | OK |
| 4S, 5S | FL460 / GND | 460 / 0 | OK |
| 6S | FL460 / GND **and** up to but not incl. FL270 / GND | `6S_upper` 460/270 + `6S_lower` 270/0 | OK |

The `_upper`/`_lower` split was verified by geometry, not by name: `3S_lower`
reaches 11.67°N (vertex 114006.50N) while `3S_upper` stops at 10.39°N (vertex
102334.00N). The northern strip is Sector 3S only below FL270 and belongs to
Sector 2S at/above FL270, so the union of the two slabs reproduces the AIP
definition exactly. Same pattern for 6S.

## 2. `ctr.geojson` — 35 of 38 corrected

**Systematic error: upper limits are exclusive, not inclusive.** The AIP publishes
almost every CTR as "up to but not including N ft". All affected records updated.

**Systematic error: AGL vs AMSL.** 18 CTRs are published in ft **AGL**; the file
recorded them all as `ALT` (AMSL).

Individually significant:

| CTR | Was | AIP 2026-07-09 |
|---|---|---|
| CHIANG MAI | ALT 5000 / GND | up to but not incl. **5000 ft AGL** / GND |
| TAKHLI | ALT 11000 / **GND** | ALT 11000 / **2000** |
| SAMUI | ALT 3000 / GND | up to but not incl. 3000 ft **AGL** / GND |
| UBON, UDON | ALT 3000 / GND | up to but not incl. 3000 ft **AGL** / GND |
| HAT YAI, SURAT THANI | ALT 3000 / GND | up to but not incl. 3000 ft (AMSL) / GND |

Unchanged because already correct: BANGKOK (ALT 11000 / GND), KHORAT
(ALT 11000 / GND), KAMPHAENG SAEN (ALT 6000 / GND) — these three are genuinely
inclusive in the AIP.

## 3. `tma.geojson` — 8 of 33 corrected

| TMA | Was | AIP 2026-07-09 |
|---|---|---|
| **CHUMPHON** | 11000 / 2000 | **ALT 7000** / 2000 ft AGL |
| **HAT YAI** | 11000 / **2000** | ALT 11000 / **3000 ft** |
| **U-TAPAO** | 20000 (`upper`=99999) / 2000 FT | **UNL** / 2000 ft **AGL** — see note |
| BURIRAM | lower FT | lower **AGL** |
| CHIANG RAI | lower FT | lower **AGL** |
| SAMUI | lower FT | lower **AGL** (upper 11000 ft AGL was already right) |
| UBON | lower FT | lower **AGL** (upper FL200 already right) |

Unchanged because already correct: BANGKOK TMA (FL160 / 3000 ft) and the 24
standard ALT 11000 / 2000 ft TMAs.

### Notes carried in the data (`aip_note` field)

- **U-TAPAO TMA** — the AIP publishes two concentric steps, both to UNL:
  5–15 NM = 700 ft AGL to UNL; 15–50 NM = 2000 ft AGL to UNL. The feature carries
  a single geometry, so the 15–50 NM step is recorded. Excludes U-Tapao CTR,
  Bangkok TMA, Alfa CTA, Hua Hin TMA, and airways A464/R468/G463/G458 FL65–FL460.
- **NARATHIWAT TMA** — the AIP publishes two volumes: (1) 25 NM circle on NTW,
  ALT 11000 / 2000 ft; (2) southern extension, ALT 11000 / **4000 ft**. The
  geometry is a single part, so volume (1) is recorded.
- **TAKHLI CTR** — the AIP prints "ALT 11000 ft / 2000" with no unit on the lower
  limit; read as ft AMSL.

## 4. Not published in ENR 2.1 — left unchanged, NOT verified

`TAK TMA`, `TAK CTR`, `SURIN CTR` have no counterpart anywhere in the current
ENR 2.1. They are flagged in the data with
`aip_source = "NOT PUBLISHED IN ENR 2.1 - values unchanged, unverified"`.
They may be published under AD 2.17 for the individual aerodrome, or withdrawn.
**These need a separate check before the dataset is treated as complete.**

Conversely, the AIP publishes a **BETONG CONTROL ZONE** (up to but not including
4000 ft AGL / GND, Class D) which has no feature in `ctr.geojson`.

## 5. Schema changes

Applied to **both** the GeoJSON exports and the `temp` database tables.

| Column | Purpose |
|---|---|
| `upperlimit` / `lowerlimit` | **Canonical, machine-parseable**: `FL n`, `n FT AGL`, `ALT n`, `GND`, `UNL` |
| `upperlimit_aip` / `lowerlimit_aip` | The AIP's **verbatim wording**, e.g. `up to but not including 5000 ft AGL` |
| `upper_ref` / `lower_ref` | `AMSL` \| `AGL` \| `GND` \| `FL` \| `UNL` |
| `upper_incl` | `false` where the AIP says "up to but not including" (32 CTRs) |
| `aip_source` | Provenance, or the "not published" flag |
| `aip_note` | Only on U-Tapao TMA, Narathiwat TMA, Takhli CTR, VTR3, VTR68 |

`airspace.ctr.upperlimit`/`lowerlimit` widened `varchar(10)` → `varchar(64)`;
`airspace.tma.upperuom`/`loweruom` widened to `varchar(8)`. U-Tapao TMA's
`upperlimit`/`upper`/`height` are now NULL with `upperuom='UNL'`, replacing the
`20000`/`99999` sentinels.

### Why the qualifier is NOT in `upperlimit`

First attempt put the full AIP wording in `upperlimit`
("up to but not including 5000 FT AGL"). That **silently broke the downstream
ingest**: `airspace_db/ingest/local_overrides.py` → `_parse_string_limit()` →
`common.parse_vertical_limit()` returned `(None, None)` for all 32 exclusive
CTRs, which would have nulled their upper limits in `airspace_polygon`.

Verified empirically before and after. The final design keeps `upperlimit` in a
form that parser already understands, so:

- **0 of 38 CTRs and 0 of 33 TMAs fail to parse** downstream (checked directly
  against the live table).
- The AGL/MSL distinction now *reaches* the consumer for the first time —
  e.g. Chiang Mai CTR previously parsed as `(5000, 'MSL')`, now `(5000, 'AGL')`.
- `_ft_uom()` already handled `UNL` and `AGL` natively, so the TMA changes needed
  no consumer change.

No consumer code was modified.

### Backup

`~/db_backups/airspace_pre_aip_fix_20260718.dump` — custom-format `pg_dump` of
`airspace.ctr`, `airspace.tma`, `airspace.pdr`, `airspace.bacc_sector` taken
immediately before the change. Restore with:

```
pg_restore -d temp --clean --if-exists -t ctr -t tma -t pdr -t bacc_sector \
  ~/db_backups/airspace_pre_aip_fix_20260718.dump
```

No views or materialized views depend on these tables (checked `pg_depend`).

---

## 6. `pdr` — 2 limits corrected, 20 cancelled features removed

Source: AIP ENR 5.1, AIRAC 2026-07-09 (86 areas / 98 volumes extracted).

### Vertical limits

Of the 61 area idents present in both the layer and the current AIP, only **2**
differed. Both verified by eye against the published text:

| Area | Was | AIP 2026-07-09 |
|---|---|---|
| VTR3 HUA HIN PALACE | UNL / GND | **ALT 6000** / GND |
| VTR68 NAM PHONG | ALT 15000 / GND | **FL 150** / GND (flight level, not AMSL) |

### Cancelled designators removed

**93 features → 73** (61 idents). The 15 idents below appear **nowhere** in the
current ENR 5.1 — confirmed by raw-text search of the source, not just by the
parser, so this is not an extraction gap.

Thailand renumbered the danger areas wholesale. 14 of the 15 place names are
still published, under new designators:

| Removed | Place | Now published as |
|---|---|---|
| VTD16 | Ratchaburi | VTD8A, VTD8B |
| VTD17 | Kanchanaburi | VTD8C, VTD8D |
| VTD18 | Suphan Buri | VTD8E, VTD8F, VTD8G |
| VTD19 | Mae Klong | *no successor found* |
| VTD31 | Lop Buri | VTD2 |
| VTD35 | Prachuap Khiri Khan | VTD5A, VTD5B, VTTRA5 |
| VTD40 | Kabin Buri / Wattana Nakhon | VTD3A, VTD3B, VTTRA3A, VTTRA3B |
| VTD41 | Mae Rim, Chiang Mai | VTD41A |
| VTD42 | Chom Thong, Chiang Mai | VTD41B |
| VTD48, VTD49, VTD50 | Songkhla | VTD56, VTTRA56A, VTTRA56B |
| VTD53, VTD57 | Phitsanulok | VTD461, VTTRA46 |
| VTD72 | Bangkok/Nonthaburi/Nakhon Pathom/Suphanburi | VTD6A, VTD6B |

Every remaining ident in the layer is present in the current AIP.

### REMAINING GAP — 25 current areas have no geometry

The successor areas listed above are **not in the layer**, because the local table
has no geometry for them and ENR 5.1 publishes boundaries as coordinate/arc
definitions that were not reconstructed here:

VTD2, VTD3A, VTD3B, VTD5A, VTD5B, VTD6A, VTD6B, VTD8A–VTD8G, VTD41A, VTD41B,
VTD56, VTD461, VTTRA2, VTTRA3A, VTTRA3B, VTTRA5, VTTRA46, VTTRA56A, VTTRA56B.

**Operational consequence:** the layer is now internally consistent — everything
in it is current — but it is *not complete*. Airspace still exists over Ratchaburi,
Kanchanaburi, Suphan Buri, Songkhla, Phitsanulok, Lop Buri and the Bangkok
training areas; the layer no longer depicts it. Anything using this layer for
airspace-infringement or route-clearance checking will under-report until the 25
areas are imported with geometry.

Note: ENR 5.1 for this cycle contains no "up to but not including", no AGL and no
SFC — every PDR upper limit is inclusive, and every altitude is ALT (AMSL) or FL.

### Backup

`~/db_backups/airspace_pdr_pre_cancel_purge_20260718.dump` — `airspace.pdr` at 93
features, taken immediately before the deletion.

```
pg_restore -d temp --clean --if-exists -t pdr \
  ~/db_backups/airspace_pdr_pre_cancel_purge_20260718.dump
```

## 7. Provenance: the zip is an export of the local `temp` database

`airspace.ctr` (38 rows), `airspace.tma` (33), `airspace.pdr` (93) and
`airspace.bacc_sector` (14) in the local `temp` PostgreSQL match the delivered
GeoJSON **exactly, field for field** — verified on all limit columns. The database
is the upstream source of the zip, not an independent record, and carries the
identical errors. Fixing the GeoJSON alone will be undone by the next export.

Constraints on fixing upstream (NOT done — needs a decision):

- `airspace.ctr.upperlimit` is `varchar(10)`; "up to but not including 2000 FT AGL"
  does not fit. Needs widening, or the qualifier moved to dedicated columns.
- `airspace.tma.upperlimit` is `integer`; UNL (U-Tapao) cannot be represented.
  The current hack is `20000` with `upperuom='UNL'` and `upper=99999`.
- No columns exist for AGL-vs-AMSL or upper-limit inclusivity — the two
  distinctions that account for most of the CTR errors.
- 25+ source files read these tables (flight-efficiency overlays, CNS coverage
  GeoPackage/QGIS export, GANP KPI viewer, flight-anim exports). Adding columns is
  safe; changing the meaning of existing ones is not. Example: Takhli CTR
  `lower_1` 0 → 2000 changes any altitude filtering that uses it.
- `cat-etl/.../update_pdr_from_html.py` already scrapes the eAIP for PDR, but is
  pinned to the **2025-12-25** cycle and writes to `airspace.pdr_combined`, which
  does not exist in this database. It is stale and non-functional as-is.
