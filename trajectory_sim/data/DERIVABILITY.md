# Thai APM BADA-format export: derivability report

Generated Jul 05 2026 by Thai APM from Bangkok FIR surveillance
(sur_air Mode-S DAPs). Source: apm.type_param / apm.type_envelope
(aggregate run 3193). NOT a EUROCONTROL product.

## What each BADA file/column contains here

| BADA item | Status | Source |
|--|--|--|
| APF climb/cruise/descent CAS, Mach | derived from data | fitted per-flight schedules, p25/p50/p75 across flights as LO/AV/HI (NOT mass bands) |
| APF cruise CAS (hi) | ISA-derived | CAS-equivalent of cruise Mach percentile at cruise FL p50 |
| APF Mach for Mach-less types (turboprops) | ISA-derived | Mach equivalent of observed cruise TAS at cruise FL p50 |
| PTF climb/descent TAS per FL | derived + ISA | fitted IAS band p50 converted via ISA; Mach segment above fitted crossover |
| PTF climb ROCD lo/nom/hi | derived from data | envelope p75/p50/p25 (INVERTED: BADA lo = low mass = best climb = our p75). The same inversion applies to the sqlite `rocd_lo`/`rocd_hi` columns for the climb phase (rocd_lo = flight-percentile p75, rocd_hi = p25) — consumers must not read these column names as plain percentiles. |
| PTF descent ROCD nom | derived from data | envelope ROD p50 |
| PTF cruise TAS | derived + ISA | cruise Mach p50 via ISA per FL, rows within cruise FL p10-p90 |
| PTF FL grid | simplified | 0,5,10,15,20,30,40 then 20-steps; no Mach-transition extra row |
| ALL fuel columns | ABSENT | zero placeholders (text) / NULL (sqlite); no fuel model |
| OPF (thrust/drag/fuel coefficients, masses) | ABSENT | not derivable from surveillance data |
| PTD | ABSENT | not generated |

## Caveats

- lo/nom/hi are statistical percentiles across observed flights, not the
  low/nominal/high MASS conditions of real BADA.
- Values embed Bangkok-region operating conditions (approx ISA+15);
  real BADA PTFs are ISA-referenced.
- Consumers needing fuel or point-mass coefficients must not use these files.
- sqlite descent rows carry NULL rocd_lo/rocd_hi by design: the reference
  PTF descent section only ever publishes a nominal ROCD, so descent
  lo/hi are intentionally left NULL for PTF parity rather than populated.

## Exported types (66)

A20N, A21N, A319, A320, A321, A332, A333, A338, A339, A343, A346, A359, A35K, A388, AJ27, AT75, AT76, B350, B38M, B39M, B733, B734, B737, B738, B739, B744, B748, B752, B763, B772, B773, B77L, B77W, B788, B789, B78X, BE20, C130, C17, C295, C510, C750, C909, CL35, CL60, CN35, DH8D, E135, E190, E290, E35L, F2TH, FA7X, GALX, GL5T, GL7T, GLEX, GLF4, GLF5, GLF6, H25B, HDJT, LJ60, SF34, SU95, TEX2

## Excluded types (20)

| Type | Missing |
|--|--|
| A139 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas |
| A189 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas, roc_bands(3), rod_bands(2) |
| AJET | climb_cas, descent_cas, cruise_mach/cruise_tas, roc_bands(0), rod_bands(0) |
| B412 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas, roc_bands(2), rod_bands(2) |
| B762 | climb_cas, descent_cas |
| C172 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas |
| C208 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas |
| C212 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas |
| C30J | roc_bands(3) |
| C55B | climb_cas, descent_cas, cruise_mach/cruise_tas, roc_bands(0), rod_bands(0) |
| D228 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas |
| DA40 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas |
| DA42 | cruise_fl, cruise_mach/cruise_tas |
| EC35 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas, roc_bands(1), rod_bands(0) |
| F16 | climb_cas, descent_cas, cruise_mach/cruise_tas, roc_bands(0), rod_bands(0) |
| F5 | climb_cas, descent_cas, cruise_mach/cruise_tas, roc_bands(0), rod_bands(0) |
| S76 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas, roc_bands(3), rod_bands(3) |
| SB39 | climb_cas, descent_cas, cruise_mach/cruise_tas, roc_bands(0), rod_bands(0) |
| SR22 | climb_cas, descent_cas, cruise_fl, cruise_mach/cruise_tas, roc_bands(1), rod_bands(2) |
| ZZZZ | climb_cas, descent_cas, cruise_mach/cruise_tas, roc_bands(0), rod_bands(0) |

## Envelope gaps interpolated

- none
