# Quote Base — Full Business Rules Extraction
**Source workbook:** `2026-XXX_Quote_Base_V1_3__June_2026_.xlsx`
**Scope:** Complete cell-level extraction of `(LED 1)`, `(LCD 1)` and `Summary`, plus the `Reference Data` and `LCDRef` tables they depend on. Every formula was read directly from the file (formula text + cached value).
**Audience:** Development team replacing the spreadsheet.

> **Provenance note:** The file is a Google Sheets export. Google-only formulas (REGEXEXTRACT, SPLIT, JOIN, ARRAYFORMULA, GOOGLEFINANCE) are frozen as `__xludf.DUMMYFUNCTION(...)` with a static fallback value, so in Excel these cells show the last Google-computed result, not live logic. Affected: LED description (LED 1)!B2, LED peripheral pickers B263/B266, LCD warranty extraction (LCD 1)!F2, and all live FX cells (Reference Data!H3:H9).

---

# PART 0 — GLOBAL REFERENCE DATA (Reference Data sheet)

## 0.1 Currency (Reference Data!A2:H9)
| Pair | Static rate used in quotes (col F) | Live feed (col H) |
|---|---|---|
| AUD/AUD | 1.0 | 1.0 |
| AUD/USD | **0.6845** | `GOOGLEFINANCE("CURRENCY:AUDUSD") − 0.005` (frozen at 0.69293) |
| AUD/EUR | 0.6006 | live − 0.005 |
| AUD/NZD | 1.21 | live − 0.005 |
| AUD/SGD | 0.90 | live − 0.005 |
| AUD/ZAR | 11.3449 | live − 0.005 |
| AUD/GBP | 0.5175 | live − 0.005 |
| AUD/MYR | 2.8501 | live − 0.005 |

⚠ **All pricing formulas reference the static column F, not the live column H.** F3 (0.6845) is a manually maintained number; the live GOOGLEFINANCE−0.005 feed is display-only. The quote T&C line publishes `F3 + 0.01`.

## 0.2 Margins & markups (Reference Data!F10:F19)
| Ref | Item | Value |
|---|---|---|
| F10 | Assembly Labour | $45/hr |
| F11 | Philips Markup (LCD screens) | ×1.4 |
| F12 | LCD Margin | 30% |
| F13 | **LED Margin** | `=IF(OR(C8 = iVisual, Cotton On, Accent Group, Hype, Platypus, Sports Direct, Stylerunner, Glue, Skechers, VANS, TAF, Lacoste), 30%, 33%)` — hardcoded client list reading the LED tab's client cell |
| F14 | Other Equipment Markup | ×1.6 |
| F15 | Metalwork Markup | ×1.5 |
| F16 | Service Markup | ×1.65 |
| F17 | LED Markup | ×1.5 |
| F18 | Controller Markup | ×1.5 |
| F19 | International Shipping Markup | ×1.5 |

Other constants: F20 Seafreight origin USD 660; F21 transit USD 90/CBM; F22 destination AUD 1,200; F23 seafreight multiple ×1.3; F24 20ft container $8,000; F25 40ft $12,000; F27 time estimate multiplier 1.3; F28 material multiplier 1.0.

## 0.3 Freight rates per kg (Reference Data!B31:F37)
Standard Air 13 · Express Air 30 · NZ Standard Air 18 · NZ Express Air =F32 (30) · Sea FCL 5 · Sea LCL (no per-kg rate; priced by the LCL formula) · No Freight.

## 0.4 Location table (Reference Data!A40:F70)
Columns: **B** local freight multiplier · **C** local freight minimum · **D** frame freight · **E** trim freight · **F** location hourly uplift.

| Location | Mult | Min | Frame | Trim | Hourly uplift |
|---|---|---|---|---|---|
| Canberra ACT | 0.1 | 50 | 0 | 0 | **25** |
| Melbourne / Bendigo / Shepparton–Echuca / Latrobe / Geelong / Ballarat / Surf Coast VIC | 0.1 | 50 | 0 | 0 | 0 |
| Sydney / Wollongong / Central Coast NSW | 0.1 | 50 | 200 | 100 | 0 |
| Central West / North Coast / Wagga NSW | 0.15 | 100 | 400 | 200 | **30** |
| Brisbane / Gold Coast QLD | 0.15 | 100 | 300 | 150 | **37** |
| Sunshine Coast QLD | 0.2 | 100 | 300 | 150 | **37** |
| Far North QLD | 0.2 | 150 | 400 | 300 | **37** |
| Darwin NT | 0.4 | 200 | 600 | 200 | **30** |
| Adelaide SA | 0.1 | 50 | 200 | 100 | 0 |
| Perth WA | 0.2 | 150 | 400 | 200 | **25** |
| Hobart / Launceston TAS | 0.15 | 150 | 400 | 200 | **25** |
| Auckland NZ | 0.1 | 50 | 0 | 0 | 0 |
| Christchurch / Dunedin NZ | 0.2 | 150 | 250 | 100 | 0 |
| Wellington NZ | 0.15 | 100 | 150 | 100 | 0 |
| Johannesburg / Cape Town RSA, Singapore | 0.15 | 100 | 150 | 100 | 0 |
| Ex Factory | 0 | 0 | 0 | 0 | 0 |

## 0.5 GOB coating adders, USD/sqm (A73:B77)
No GOB 0 · LEDful GOB 95 · LEDful LOB 49 · ZonePro GOB 80 · GOB Included in Base Price 0.

## 0.6 Controller catalogue (A79:F89)
| Controller | Type group | Max Ports | Max Pixels | Max Width px | Price |
|---|---|---|---|---|---|
| Sending Box MCTRL300 | Standard | 2 | 1,300,000 | 3,840 | 247.73 |
| Sending Box MCTRL700 | Standard | 6 | 2,600,000 ⚠ (4 ports' worth) | 3,840 | 455.90 |
| TB50 (inc HDMI scalar) | For Unknown 3rd Party (TB) | 2 | 1,300,000 | 4,096 | 634.93 |
| TB60 (inc HDMI scalar) | For Unknown 3rd Party (TB) | 4 | 2,600,000 | 4,096 | 726.53 |
| VX400Pro | With Scalar or Switch (VX) | 4 | 2,600,000 | 3,840 | 1,518.00 |
| VX600Pro | With Scalar or Switch (VX) | 6 | 3,900,000 | 3,840 | 1,873.00 |
| VX1000Pro | With Scalar or Switch (VX) | 10 | 6,500,000 | 8,192 | 2,537.66 |
| VX2000Pro | With Scalar or Switch (VX) | 20 | 13,000,000 | 16,384 | 4,681.87 |
| MSD300 sending card | Card Only (MSD300) | 1 | 650,000 | 3,840 | 157.00 |
| H2 Case (needs I/O cards) | H Series | 0 | 0 | — | 809.80 |

⚠ The selection formula uses the price **directly as AUD cost with no FX conversion** (unlike screens/spares, which are USD ÷ F3). Confirm the currency of this table.

## 0.7 LED peripherals (A91:F98), prices used as-is
H-Series input card 4×HDMI/DVI 1,018 · H-Series input card DP1.2 1,455 · H-Series output card 16×RJ45 2,039 · H-Series output card 2×RJ45+HDMI preview 1,516 · MFN300 multifunction card 151 · Light sensor NS060-30A 200.23 · Nova CVT310 fibre converter pair 198.

## 0.8 Mediaplayers (A100:F105) — costs are AUD, pulled from LCDRef
SeenCMP Mediaplayer (F106D Windows) 472.89 · Wide-temperature (AE613 i3) 829.35 · Mini (M3QD) 278.45 · iVisual Mediaplayer 690 · Excludes Mediaplayer 0.

## 0.9 Mediaplayer peripherals (A107:F118)
4G Module (Quectel EG25-G) 80 · Teltonika RUT240 273 · TANGO43 puck antenna 58 · Outdoor camera (Reolink 4K) 200 · 5-port PoE switch 87.91 · 8-port PoE 98.44 · 5-port switch 23.65 · 8-port switch 36 · 1RU shelves 200/250/300 mm 15/17.20/20.

## 0.10 Trim (A120:C125) — per linear metre multipliers
| Option | Width mult | Height mult |
|---|---|---|
| No Trim | 0 | 0 |
| Trim (Sides Only) | 0 | 60 |
| Trim (All Edges) | 60 | 60 |
| Trim (Sides and Bottom) | 30 | 60 |
| Trim (Included in LED supply) | 0.001 | 0 |

Trim cost = `Wmult × width_m + Hmult × height_m` (AUD, no FX).

## 0.11 LED hanging bars (A127:B131), per metre width
No Hanging Bar 0 · WALL $95/m · BM $70/m · HI $60/m. Quantity = `CEILING(desired width mm / 1000)`. ⚠ Rate is divided by FX in the LED tab (treated as USD).

## 0.12 Frames (A133:D164)
Columns: B frame cost, C backcover cost, D frame install hours. ~25 named frames (iVisual elevated/low frames, plinths, stands, portables, transparent, outdoor structures) with costs $480–$17,750, backcovers $0–$549 (mostly formula `149×n + 240×m + 12×3 + 33`), install hours 0–16.

## 0.13 Engineering (A167:B172)
No Engineering 0 · Certificate of Design 1,590 (=940+650) · Engineering + install certification (SDIC) 2,190 · CoD same design new site 1,120 · SDIC same design new site 1,770.

## 0.14 Install methods (A174:C187)
13 install-method strings, each with a "physical" requirements paragraph (col B) and a "power/data" requirements paragraph (col C): supply only; wall (formply); wall (masonry); recessed; bolt-to-floor frame w/ Seen cladding; bolt-to-floor frame w/ client cladding; into client housing; hanging (client points); hanging (Seen points); floor-to-ceiling frame; to client frame/pylon; front-of-glass; rear-of-glass. These feed (LED 1)!AF2/AG2 site-prep output text.

## 0.15 Access equipment hire (A189:B194)
No Access Equipment 0 · Scissor indoor day 600 · Scissor outdoor day 700 · Crane day 2,200 · Semi day 1,000.

## 0.16 Warranty & service hours lists
Warranty: Standard (3 year), Extended (5 year). Service hours: Business Hours; Out of Hours (Before Midnight on a weekday); Out of Hours.

## 0.17 Client-specific rules (A205:B228) — free text
| Client | Rule |
|---|---|
| 2XU | No specific product; always low margin/competitive |
| Dusk | Don't order LCD from us — quote LED as an option |
| ASICS | P1.8 GOB larger screens; standard engineered window frames exist; shelf screens U1.2 with shared controller + mediaplayer |
| Accent Group (Hype, Platypus, Stylerunner, Glue, Skechers, VANS, TAF, Lacoste) | No mediaplayers; change MCTRL to TB50 and uplift config time if 2-port |
| Accent Group (Sports Direct) | Custom cabinets for SD fixtures — refer previous PIs; no mediaplayers |
| Baby Bunting | Trim on all standard screens; P1.5 |
| Cotton On | BM rather than BM-PRO where applicable (IF for smaller); 30% margin; special LEDful buy rates |
| EB Games | No mediaplayers; generally P2.5 |
| Flight Centre | No mediaplayers |
| Forever New / Ever New | P1.8; match existing screen ratios |
| iVisual | No mediaplayers; default 30% margin; IF2.5-Hi or TGC2.8-5.6 4000nit standard; LCD jobs 22–25% margin; no site prep unless hanging LED |
| Just Jeans | P1.8 GOB |
| Lovisa | Standard screens/prices, special LEDful buy price, Lovisa pick up from LEDful; 58 mm cabinet depth critical (vs standard 61 mm); standard install price by country |
| Myer | WallPad P1.8 GOB |
| Palermo | Use WallPad for Wall products (built for 44 mm depth) |
| Peter Alexander | All P1.8; 3:4 (or 2× 3:4) ratio; black trim on counter screens; housings painted Alexander Pink; Biamp audio; 1080×1440 in IF @69 mm; **no Android screens (security)** — SDM screen type; BDL3117P + SDM-L player for greeter screens |
| Roll'd | Standard 43" menu board; client installs, we configure; standard price except remote |
| OZ Hair & Beauty | Standards evolve quickly; swings between quality and value |
| RM Williams | Touch screens: mediaplayer but **no SeenCMP licence**; other screens have SeenCMP |
| Retail Apparel Group (Connor, AXL, YD, Tarocash, Rockwear, Johnny Bigg) | Switch if >1 screen; rack shelf per 2 players; generally P2.5 |
| Strand | P2.5 for most screens |
| Sign Manager | 28% margin; supply mediaplayer only, no SeenCMP |

## 0.18 Aspect-ratio bands (A229:C251) — inclusive of both ends
4:1 [3.78–10.00] · 32:9 [3.28–3.77] · 3:1 [2.84–3.27] · 8:3 [2.51–2.83] · 21:9 [2.17–2.50] · 2:1 [1.89–2.16] · 16:9 [1.69–1.88] · **"0.67"** [1.56–1.68] ⚠ (label almost certainly meant to be 16:10/8:5) · 3:2 [1.42–1.55] · 4:3 [1.30–1.41] · 5:4 [1.13–1.29] · 1:1 [0.91–1.12] · 4:5 [0.78–0.90] · 3:4 [0.71–0.77] · 2:3 [0.65–0.70] · 10:16 [0.60–0.64] · 9:16 [0.54–0.59] · 1:2 [0.43–0.53] · 3:8 [0.36–0.42] · 1:3 [0.30–0.35] · 1:4 [0.00–0.29].

## 0.19 International installer rates (A274:B292)
Ambience (SG/MY): install 5–10 sqm SGD 440/sqm; 1–5 sqm SGD 630/sqm; config SGD 420/screen; project overhead SGD 280; OOH hourly SGD 100 — each × SG VAT 1.09 ÷ AUD/SGD.
CorporateAV (RSA): day rate ZAR 7,200 (2 techs), sundries ZAR 1,800 — × VAT 1.15 ÷ AUD/ZAR.
Snider (USA): USD 150/hr × 1.07 ÷ AUD/USD.
UXGlobal (UK): day rate GBP 1,190; callouts GBP 216 / 272 / 112 — × VAT 1.20 ÷ AUD/GBP.
VAT factors: SG 1.09, RSA 1.15, UK 1.20, US(CA) 1.07.

## 0.20 Product family commentary (A294:B316)
Free-text product selection guidance (BM-PRO vs BM, WallPad vs Wall-PRO, IF constraints — max P1.8 multi-cabinet, max width 1600 mm, 99 mm depth slimmable to 60 mm; FA/FM/FS-PRO outdoor guidance — avoid FA >~8 sqm; transparent TGC/Muxwave/HIS rules; rental HI/HO, XI/TI/XO/TO). Should become product-attribute metadata or estimator help text.

---

# PART 1 — (LED 1) TAB: FULL RULES

## 1.1 Sheet architecture
- **Rows 5–6:** the *selected* product's attribute row(s), copied from the catalogue. Row 6 mirrors row 5 (`=B5` etc.) allowing a second size segment of the same product (row 250).
- **Rows 8–33:** the estimator's input questions.
- **Rows 36–233:** the LED product master catalogue (~150 products; data revised 17/05/2026).
- **Rows 235–246:** derived engineering values (power, weight, pixels, shipping, sides, desired size).
- **Rows 247–279:** LED supply cost build-up ("LED Supply").
- **Rows 281–292:** Frame, trim, back cover, engineering.
- **Rows 294–321:** Install labour ("LED Install").
- **Rows 323–325:** Grand total and currency conversion.
- **Rows 1–2:** the published quote outputs (all strings/prices assembled here; Summary reads row 2 via INDIRECT).

## 1.2 Product master data — column meanings (rows 4/36 headers)
A supplier · B model name · C upgrade options (free text with $/sqm adders) · D mechanical options / cut-cabinet pricing (free text) · E/F largest cabinet W/H (mm) · G volumetric modifier (1.0–1.9) · H kg/sqm · I cost USD/sqm · J/K module W/H · L/M **min cabinet W/H** (snapping grid) · N cabinet depth mm · O max power W/sqm · P avg power W/sqm · Q ship depth (cm per cabinet layer) · R/S pixel pitch H/V · T brightness (nit) · U service access (Front / Rear / Front or Rear) · V cabinet type (diecast aluminium / steel) · W "inc Receivers" Y/N · X "GOB Inc" Y/N · Y "Pack Inc" Y/N · Z module price · AA price-valid-from date.

Special catalogue rows: cubes (5-faced, includes receiver/sender/spares), sphere P2 (weight from crate volume `50×50×50/5000`), transparent, rental families.

## 1.3 Inputs (rows 8–33)
| Cell | Input | Notes |
|---|---|---|
| C8 | Client | D8 shows the matching client rule via `VLOOKUP(C8, RefData A206:B229, 2)` |
| C9 | Screen name | prepended to description |
| C10 | Location | drives local delivery, frame/trim freight, hourly uplift |
| C11/C12 | Desired W/H (mm) | E11/E12 are 16:9 helper suggestions: `ROUND(C12×16/9)` etc. depending on D10/E10 orientation |
| C13 | Rotate Cabinets Y/N | swaps W/H of both largest-cabinet and min-cabinet values |
| C14/C15 | Largest cabinet W/H | `=IF(C13="Y", F5, E5)` / inverse; D14 = D11/C14, D15 = D12/C15 (cabinet counts) |
| C16 | Service | `=U5` from product |
| C17 | GOB Required | list from §0.5 |
| D17 | Cut-cabinet warning | `IF(OR(INT(D14)<>D14, INT(D15)<>D15), "May need to rotate or allow for cut cabinets","")` |
| C18 | LED Controller | Standard / Card Only / H Series / For Unknown 3rd Party (TB) / With Scalar or Switch (VX) |
| C19 | LED Peripherals | comma-separated; split by frozen Google SPLIT formula (B263:G263) |
| C20 | Mediaplayer | from §0.8 |
| C21 | Mediaplayer peripherals | comma-separated; frozen SPLIT (B266:G266) |
| C22 | Warranty | Standard (3 year) / Extended (5 year) |
| C23 | Freight Type | from §0.3; D23 shows "Volumetric Weight=…; estimated weight=…" |
| C24 | Frame Type | from §0.12 |
| C25 | LED Hanging Bar | from §0.11 |
| C26 | Back Cover | Yes/No |
| C27 | Trim Needed | from §0.10 |
| C28 | Engineering Needed | from §0.13 |
| C29 | Access Equipment | from §0.15 |
| C30 | Install Method | from §0.14 |
| C31 | Frame/housing description | inserted into quote description |
| C32 | Service description suffix | appended to C2 |
| C33 | Service Hours | from §0.16 |

## 1.4 Screen sizing (rows 246, 249)
- Desired size: E246 = C11, F246 = C12.
- **Snap to min-cabinet grid, round to NEAREST (not up):**
  `E249 = IF(C13="Y", ROUND(E246/M5,0)×M5, ROUND(E246/L5,0)×L5)`
  `F249 = IF(C13="Y", ROUND(F246/L5,0)×L5, ROUND(F246/M5,0)×M5)`
  ⚠ Screens can come out *smaller* than requested.
- Ratio G249 = D11/D12 (snapped W ÷ snapped H) → banded label via §0.18 (used in description).
- Area (sqm) H249 = `E249 × F249 / 1,000,000 × E245` where **E245 = Sides** (manual input, default 1; multi-sided screens multiply area, pixels, weight, power).
- Second size segment (row 250): E250/F250 manual; H250 = area × sides; costed at the same product rate (I250 = I6).

## 1.5 Power, heat, weight (rows 236–238)
- Max power `E236 = ROUNDUP((H249+H250) × O5 / 0.85, -1)` W — max W/sqm with ÷0.85 derating, rounded up to 10 W.
- Avg power `F236 = ROUNDUP((H249+H250) × P5, -1)` W — no derating.
- Heat: `G236 = ROUNDUP(E236 × 3.41, -2)` BTU/hr (max, rounded up to 100); `H236` same on average power.
- Current: `E237 = E236/230` A (max, unrounded); `F237 = ROUNDUP(F236/230, 0)` A (typ).
- Weight `E238 = (H249+H250) × H5` kg; displayed `ROUNDUP(E238, -1)` (nearest 10 kg up) in G2/Y2.

## 1.6 Resolution & data ports (row 240)
- Width px `E240 = ROUND(E249 / R5, 0) × E245` (× sides).
- Height px `F240 = ROUND(F249 / R5, 0)` ⚠ **uses horizontal pitch R5, not vertical S5** — harmless today (all products have H=V pitch) but a latent bug.
- Total px `G240 = E240 × F240`.
- **Ports** `H240 = IF(RIGHT(LEFT(B5,13),4)="WALL", MAX(ROUNDUP(E246/1000,0), ROUNDUP(G240/650000,0)), ROUNDUP(G240/650000,0))`
  i.e. `CEILING(TotalPixels / 650,000)`, with WALL-family products (chars 10–13 of the model name = "WALL") also requiring ≥1 port per metre of **desired** width. ⚠ Brittle name parse — make it a product attribute. Also note it uses desired width E246, not snapped width E249.
- Modules `I240 = E249/J5 × F249/K5 × E245`.

## 1.7 Shipping weight (row 242, lengths in cm)
- Carton W `E242 = C14/10 + 10` (largest cabinet W cm + 10).
- Carton depth `F242 = MAX(ROUNDUP(D14,0) × ROUNDUP(D15,0) × Q5 + 10, 28)` (cabinet count × ship depth + 10, min 28).
- Carton H `G242 = MIN(C15/10, F249/10) + 20`.
- Volumetric kg `I242 = ROUNDUP(E242×F242×G242 / 5000, 0)`.
- Actual ship kg `J242 = (H249+H250) × H5 × G5` (weight × volumetric modifier).
- Previous-entry carry `K242` (manual, default 0).
- **Chargeable kg `L242 = MAX(I242:K242)`.**

## 1.8 LED supply cost block (rows 249–270)
Column semantics per line: H = quantity/area/units · I = USD unit rate (where used) · **J = AUD cost** (`= I / RefData!F3` when I is USD; direct otherwise) · K = margin check · **L = AUD sell** (J × applicable markup) · O = total cost (H×J) · P = total sell (H×L) · Q margin · R profit · S = USD equivalent of O.

| Row | Line | Cost rule | Sell markup |
|---|---|---|---|
| 249 | Screen (main size) | `I249 = I5` USD/sqm → J = I/F3; O = area × J | ×F17 (1.5) |
| 250 | Screen (second size) | same, product row 6 | ×1.5 |
| 251 | Packaging | area basis `H251 = IF(Y5="Y", 0, H249+H250)`; USD 19/sqm; `O251 = IF(Y5="Y",0, MAX(H251×J251, 49/F3))` — min USD 49; waived if "Pack Inc"=Y | ×1.5 (same MAX applied on sell) |
| 252 | Spares | `H252 = IF(C17="NO GOB", 15%, 10%)`; shown as modules `E252 = H252 × I240`; `O252 = H252 × (screen cost O249:O250 + GOB cost O258)` | ×1.5 ⚠ customer text says "5% modules" |
| 253 | Receiving cards | `H253 = IF(W5="N", ROUNDUP(I240/12, 0), 0)` @ USD 25 | ×1.5 |
| 255–256 | Add-ons/variations (manual) | H manual qty; I USD unit (defaults 276 / 39 — cut-cabinet & option adders per product col D text) | ×1.5 |
| 257 | Upgrade options (manual) | I USD (default 13; e.g. brightness uplift/sqm per product col C) | ×1.5 |
| 258 | GOB | `I258 = VLOOKUP(C17, GOB table) × (1 + H252)` USD/sqm × area H258=H249 — GOB rate grossed by the spares % | ×1.5 |
| 259 | Supplier brackets/customisation (manual) | I USD, default 70 | ×**F16 (1.65)** ⚠ service markup on a supply line |
| 260 | Hanging bar | `H260 = ROUNDUP(E246/1000, 0)` metres; `I260 = VLOOKUP(C25, hanging table)` USD/m → ÷F3 | ×**F16 (1.65)** |
| 262 | **Controller** (see 1.9) | `J262 = VLOOKUP(B262, controller table, 6)` — **no FX division** | ×F18 (1.5) |
| 263 | LED peripherals | up to 6 items split from C19; sum of table prices, no FX | ×F18 (1.5) |
| 265 | Mediaplayer | `J265 = VLOOKUP(C20, RefData A101:F105, 6)` (AUD) | **sell = J / (1 − F13)** — margin regross, not ×markup |
| 266 | Mediaplayer peripherals | up to 6 items split from C21; sum of prices | ×F18 (1.5) |
| 268 | Seafreight LCL | active if C23="Freight (Sea LCL)" (H268 flag); `J268 = ((660 + 90 × L242/100)/F3 + 1200) × 1.3` — CBM approximated as chargeable kg ÷ 100 | ×F17 (1.5) |
| 269 | Freight per kg | `H269 = IF(H268≠0, 0, L242)`; `J269 = IF(C23="Sea", 0, VLOOKUP(C23, rate table))` ⚠ the literal "Sea" never matches any option (dead code); Sea FCL prices at 5/kg here | ×F19 (1.5) |
| 270 | Local delivery | `J270 = MAX(LocationMult × O269, LocationMin)`; H270 = 0 only if C23="No Freight" ⚠ for Sea LCL, O269=0 so local delivery collapses to the location minimum | ×F17 (1.5) |

### 1.9 Controller selection ((LED 1)!B262)
```
IFS( C18="Standard",                    IF(Ports > 2, MCTRL700, MCTRL300),
     C18="Card Only",                   MSD300,
     C18="H Series",                    H2 Case,
     C18="For Unknown 3rd Party (TB)",  IF(Ports > 2, TB60, TB50),
     C18="With Scalar or Switch (VX)",  IFS(Ports < 4,  VX400Pro,
                                            Ports < 6,  VX600Pro,
                                            Ports < 10, VX1000Pro,
                                            Ports < 20, VX2000Pro,
                                            TRUE,       "No Match") )
```
⚠ Anomalies: VX uses strict `<` (exactly 4 ports → VX600Pro; exactly 20 → "No Match") while Standard/TB use `>` (inclusive). No upper-bound validation on Standard/TB (a 10-port screen still gets the 6-port MCTRL700). Max Pixels / Max Width columns are never checked. H-Series I/O cards must be added manually via peripherals.

## 1.10 Supply totals, margin regrossing, warranty (rows 271–275)
- Line totals: `O271 = SUM(O249:O270)` (cost), `P271 = SUM(P249:P270)` (sum of line sells — **informational only**).
- **The actual quoted price regrosses total cost at the LED margin:** `P272 = O271 / (1 − F13)` (33%, or 30% for the named clients). `P273 = P272 × H273` (quantity, default 1).
- 5-year warranty: `G274 = IF(C22="Standard (3 year)", "No", "Yes")`; cost `O274 = IF(Yes, 12% × (O272 − (O269 + O268)), 0)` — 12% of supply cost **excluding international freight and LCL but including local delivery**; sell `P274 = O274 / (1 − F13)`.
- Airfreight uplift `P275 = IF(P269>0, 0, L242 × IF(L242<100, 13, IF(L242<250, 30, IF(L242<500, 18, F36))) × 1.5 − L268)` — the "what would air cost instead" figure when Sea LCL is chosen. ⚠ The weight tiers reference Standard/Express/NZ rates in a way that makes no obvious sense, and the ≥500 kg tier references empty F36. Confirm intent.

## 1.11 "As Quoted" override (rows 277–279)
- B278 Purchase Total (LED only): `J278 = SUM(O249:O260)` and USD `I278 = J278 × F3` (supply lines before controller/mediaplayer/freight).
- Row 279 "Screen Quoted Price": manual USD price I279 to override/benchmark (flows nowhere automatically).

## 1.12 Frame, trim, back cover, engineering (rows 281–292)
| Row | Line | Cost | Sell |
|---|---|---|---|
| 282 | Frame (=C24) | `VLOOKUP(frame table col B)` AUD | ×F16 (1.65) |
| 283 | Back cover | qty `IF(C26="Yes",1,0)`; `VLOOKUP(frame table col C)` | ×1.65 |
| 284 | Trim (=C27) | `Wmult × E249/1000 + Hmult × F249/1000` AUD | ×1.65 |
| 285 | Engineering (=C28) | engineering table | ×1.65 |
| 286 | Building Permit Application (manual) | 1,500 | ×**1.33 hardcoded** |
| 287 | Footings Template (manual) | 100 | ×1.65 |
| 288 | Footings (manual) | 3,200 | ×**1.33 hardcoded** |
| 289 | Aluminium section (manual) | 60 ($30/m 40×40, $60/m 40×80) | ×1.65 |
| 290 | Aluminium peripherals (manual) | 100 | ×1.65 |
| 291–292 | Total; **published K2 regrosses cost at LED margin**: `P292 = O291 / (1 − F13)` | | |

## 1.13 Install labour (rows 294–321)
**Standard overhead (adjust for multi-screen sites):**
| Row | Item | Cost / Sell |
|---|---|---|
| 296 | Consumables | 30 / ×1.65 (49.50) |
| 297 | Rubbish Removal | 60 / ×1.65 (99) |
| 298 | Warehouse Rate | 75 / ×1.65 (123.75) |
| 300 | Project Management (min 4 hrs outdoor) | 1 hr @ 120 / 170 |
| 301 | Installation Design & Site Prep | 1 hr @ 80 / 160 |
| 302 | Screen Configuration (more for large/steel) | 1 hr @ 80 / 160 |
| 303 | Mediaplayer configuration | qty `= H265` if a mediaplayer is priced; 45 / 130 |
| 305 | Access equipment (=C29) | table / ×1.65 |
| 306 | Site Survey (manual) | 155 / ×1.65 |
| 307 | Parking (manual) | 50 / ×**F19 1.5** ⚠ intl-shipping markup on parking |
| 309 | Local Freight (Mediaplayer/Controller) | 30 / ×1.65 |
| 310 | Local Freight (Frame/Trim) | `IF(frame cost>0, location FrameFreight, 0) + IF(trim cost>0, location TrimFreight, 0)`; active when >1 chargeable line in 282:303 | ×1.65 |

**Installer labour:**
| Row | Item | Rule |
|---|---|---|
| 312 | Travel (manual hrs) | 80 / ×1.65 |
| 313 | NZ install base (manual) | 95 / 180 AUD (notes: OOH callout NZD 187.50, hourly NZD 142.50) |
| 314 | NZ size-driven hours (manual) | cost `= 95 / AUD:NZD` (78.51) / sell 180 |
| 315 | Install base cost | **4 hrs** @ 95 / 160 |
| 316 | **Install size-driven hours** | `H316 = MROUND( MAX( ROUNDUP( ROUNDUP(D14,0) × ROUNDUP(D15,0) × F, 0), 4) × M × (1 + (E245−1) × 0.8), 2)` where **F** = 2 if largest-cabinet area C14×C15/1000 > 600 (i.e. >0.6 sqm) — 1.5 instead if model starts "IT" — else 1; **M** = 0.75 if area per side H249/E245 > 6 sqm; multi-side factor +80% per extra side; result rounded to nearest 2 hrs, min 4. @ 95 / 160 |
| 317 | Frame install | hours = frame table col D @ 95 / 160 |
| 318 | Uplift — hanging install (manual) | +4 hrs @ 95 / 160 |
| 319 | Location hourly uplift | qty `H319 = SUM(H315:H318)` (total install hours); rate = location table col F (ACT 25, QLD 37, WA 25, TAS 25, C/N NSW 30, Darwin 30); sell ×1.65 |
| 320–321 | Total install; **published L2 regrosses cost at LED margin**: `P321 = O320 / (1 − F13)` | |

## 1.14 Grand total & currency (rows 323–325)
- `O323 = O271 + O320 + O291 + O274` (cost incl. warranty); `P323 = P271 + P320 + P291` (line sells, informational — ⚠ omits P274).
- Published total M2 = J2+K2+L2 where J2 = `ROUND(P273 + P274, -1)`, K2 = `ROUND(P292, -1)`, L2 = `ROUND(P321, -1)` — i.e. **every published component = cost ÷ (1 − LED margin), rounded to $10**. P324 = O323/(1−F13) is the same figure unsplit.
- Row 325: invoice currency conversion — `O325/P325 = rate(L325) × totals × qty`, L325 currency code against §0.1 table.

## 1.15 Published outputs (rows 1–2)
- **B2 Description** (frozen Google formula; logic): `C9 + newline + "Seen " + LEFT(model,6) + "-" + pitch(regex from model) + " LED Screen (W x Hmm) " + ratio band + [" - Two Sides"/" - N Pieces"] + newline + pitch + "mm pixel pitch, " + brightness + "nit brightness SMD RGB LED, " + service + " service " + cabinetType + " cabinets," + [GOB/LOB text if I258>0 or X5="Y"] + " ANZ/UL compliant power supplies, Novastar LED Control system, " + mediaplayer + peripherals + frame description + " spare parts (5% modules), " + [Side Trim if trim priced] + engineering + (5 or 3) + " year warranty."` ⚠ hardcodes "5% modules".
- **C2 Services description** = install method C30 + suffix C32.
- **D2 Location line** = "Single Visit to Site, {C33} Services, {C10}".
- **E2 Power & data** = "Power: {E236/1000}kW ({ROUND(E237)}A) (Max) / {F236/1000}kW ({F237}A (Typ)). \nData: {H240} x CAT6".
- **F2 Freight text** = Sea options → "Sea Freight (12 weeks lead time)"; any Air option → "Air Freight (6 weeks lead time)"; else "Excludes Freight".
- **G2 Dimensions** = "{D11} x {D12}mm[, (N pieces)], {ROUNDUP(E238,-1)}Kg".
- **H2 Resolution** = "{E240} x {F240}px\n({E240×F240}px)".
- **I2 Warranty** = 5 or 3 Year Warranty.
- **O2** chargeable kg; **P2** freight cost `SUM(O269:O270)`; **Q2** labour hours H319; **R2** labour budget `SUM(O312:O319)`.
- **Spec columns T2:AG2** (internal/site-prep pack): snapped W/H, cabinet depth N5, recess `(W+20) x (H+20) x depth`, service access, weight, ports, avg/max power, heat string, trim choice, resolution, and install-physical / install-power paragraphs from the install-method table.
- **Faceted curve helper** (U235:W243): radius → circumference `π×2r` → length (½ circumference) → % of circumference → degrees → cabinets = length ÷ cabinet width → degrees per cabinet. Standalone calculator, feeds nothing.

---

# PART 2 — (LCD 1) TAB: FULL RULES

## 2.1 Line-item pattern
Every line: **B** item (validated against LCDRef) · **C** cost `=VLOOKUP(B, LCDRef, col 8=Total Cost)` · **D** sell `=VLOOKUP(B, LCDRef, col 10=Sell)` · **E** quoted `=D` (manually overridable) · **F** qty · **G** price `=E×F` · **H** cost `=F×C` · **I** margin `=J/(E×F)` · **J** profit `=(E−C)×F`. Lookup ranges: screens `LCDRef!B4:L622` (cost) / `B4:K277` (sell); brackets & services `B282:K507`; freight `B508/509:L623`.

## 2.2 LCDRef pricing rules (how cost & sell are built)
- **Total cost (col I) = AUD price (col G) + inbound freight allowance (col H).** Col G is either an AUD list price or `USD (col D) ÷ RefData!F3` (or ÷F4 for EUR items, e.g. Nexmosphere). Col H freight is per-item (fixed, or volumetric formulas like `MAX(135×45×85/5000, 95) × AirRate`, or container amortisations like `6000/12`).
- **Sell (col K) by category:**
  - Philips screens: `ROUND(cost × F11 (1.4), -1)`; ad-hoc adjustments on some ranges (×(1.4−0.08), ×(1.4−0.05), ×(1.4−0.04), ×(1.4+0.2) for EKAA outdoor/bonded ≈ ×1.6). Note LCDRef!C4: "Philips prices — add 8% for 5-year warranty."
  - Some screens/mediaplayers: hardcoded sell (e.g. SeenCMP Android player cost 218.22 → sell 405; F106D Windows cost 472.89 → sell 740; SDM player 880 → 955; iVisual player 690 → 920).
  - Peripherals: × F14 (1.6) other-equipment markup, some ×(1.6−0.09); antennas ×F15/F16.
  - Brackets/services: × F16 (1.65) service markup or ×F11, some ×(markup±0.05..0.15); services rows carry hourly-derived costs (e.g. media player config cost `45/3 = 15`, sell 130).
  - Parking × F19 (1.5).
  - **Screen freight surcharges: × K510 = 1.5** (86" surcharge 450→675; 100" 550→825; mediaplayer freight 30→45; screen allowance offpeak 60→90).
  - ⚠ 4G Datapack (12 mo/25 Gb): cost 450, sell 400 — sold below cost (−12.5%).

## 2.3 Sheet sections (rows 4–45)
1. **Display** (rows 5–7): up to 3 screen models.
2. **Mediaplayer & Peripherals** (rows 9–14): row 9 "In-built" qty (F9); rows 10–14 external players/4G/router. 
3. **Bracket & Shroud** (rows 17–20): up to 4 items.
4. **Configuration** (rows 23–24): Media Player Configuration — qty `F23 = SUM(F9:F11)` (in-built + external players), **cost hardcoded `=40`** ⚠ (LCDRef says 15), sell 130; 4G Configuration cost 30 / sell 80.
5. **Installation** (rows 27–34):
   - Standard Installation — Site Attendance: 135 / 265; hours `K27 = C27/135 × F27`.
   - Named install packages (e.g. Single Screen Wall Mount 86": 855 / 1,440); hours `K28 = C28/95 × F28` (÷ $95 base rate).
   - Installation per hour: 95 / 160; `K29 = C29/95 × F29`.
   - Row 30 **Location hourly uplift**: B30 = location; cost = location col F uplift; sell = ×F16 1.65; qty `F30 = IF(uplift≠0, K40 total hours, 0)`.
   - Row 31 **Out-of-hours uplift (till 12pm)**: 50 / 80 per hour; qty `F31 = IF(E2 ≠ "Business Hours", SUM(K28:K29), 0)` ⚠ excludes site-attendance hours K27.
   - Parking 50 → ×1.65; Travel 75 → ×1.65; Induction (manual).
6. **Seen Labour** (rows 37–39): Warehouse rate 75/123.75 (qty 0 default); Consumables 30/49.50 (qty 1); Rubbish allowance 30/49.50 (qty 1).
7. **Row 40 totals** Installation & Configuration (G40/H40/J40, hours K40 = SUM(K23:K39)).
8. **Location Fees** (rows 42–44): Other freight/packaging/handling 25→×1.65; Freight 86" direct-delivery surcharge 450/675; Freight screen allowance (Syd/Mel/Ade offpeak) 60/90.
9. **Row 46**: grand totals of line items (G46 = G15+G21+G40+G45).

## 2.4 Analysis & published pricing (rows 48–54) — the key LCD pricing rule
- Rows 48–50 restate hardware / bracket / services at line-item sell.
- Rows 51–53: each component **regrossed at the nominated margin** `G = ROUND(H_cost / (1 − I), -1)` with `I = I54 = RefData!F12 = 30%`.
- Row 54: **Total At Fixed Margin `G54 = ROUND(H46 / (1 − 30%), -1)`** — this is the published quote total (J2).
- ⚠ **Published component split is mixed-method** (row 2): Screen & Mediaplayer `G2 = G15` (sum of line-item sells); Bracket & Shroud `H2 = G52` (cost regrossed at 30%); Services `I2 = J2 − (G2 + H2)` (residual); Total `J2 = G54`. So the services figure a client sees is a balancing number, not the services line-sell total.

## 2.5 Published outputs (rows 1–2, 56–59)
- **B2 Description** (TEXTJOIN): `C3 screen-name line + qty × screen description (LCDRef col C) per screen row + mediaplayer clause` — if no external players and `F9≥1` → "in-built SeenCMP mediaplayer", if none at all → "Excludes Mediaplayer", else the external player descriptions — `+ peripheral descriptions + bracket descriptions (LCDRef col D) + orientation suffix` from A2 (`L`→" (Landscape)", `P`→" (Portrait)").
- **F2 Warranty** = regex-extract "(\d+) year warranty" from B2 (frozen; fallback "3").
- **C2** service description (manual); **D2** location; **E2** service hours.
- **G2/H2/I2/J2** = published $ split per §2.4.
- **B56 Order List**: concatenation "qty x model, " for screens and brackets with qty>0.
- **Licence & Support (rows 57–59)**: `G = IF(qty=0, 0, FirstScreenRate) + AdditionalRate × MAX(qty−1, 0)` with qty `F58 = F23` (configured players). Standard: **$395 first + $125 each additional**; Volume: **$260 first + $90 each additional**. (Informational rows; not added into J2.)

---

# PART 3 — SUMMARY TAB: FULL RULES

## 3.1 Architecture
Column A of each row names a source sheet; every field is pulled with `INDIRECT($A_row & "!cell")`, so quotes are assembled by adding rows pointing at `(LED 1)`, `(LED 2)`…, `(LCD 1)`… LED rows 3–11 (total row 12), LCD rows 15–22 (total row 23), grand "Screen Total" row 24.

## 3.2 LED section (rows 2–12)
Per row: B Description ←`!B2` · C Services Description ←`!C2` · D Location ←`!D2` · E Power & Data ←`!E2` · F Freight ←`!F2` · G Dimensions ←`!G2` · H Resolution ←`!H2` · I Warranty ←`!I2` · **J Screen & Mediaplayer ←`!J2` · K Frame & Trim ←`!K2` · L Services ←`!L2` · M Total `=J+K+L` · N Qty · O Extended `=M×N`**.

Internal columns:
- **W Freight KG** `= ROUND(!O2 × N, 0)`; **X Freight Cost** `= !P2 × N`.
- **Y Airfreight Uplift** `= IF(LEFT(F3,3)="Sea", W × (AirRate 13 − SeaFCL 5), 0)` — cost delta to switch a sea quote to air.
- **Z Labour Hours** `= !Q2 × N`; **AA Labour Budget** `= !R2 × N`.
- **AB "PI"** manual Yes/No flag.
- **AC2/AD2 headers + AC3/AD3**: the *alternate* freight method and its figure — `ROUNDUP( !H265 × VLOOKUP(alternateFreight, rates, 5) × F19, 0)`. ⚠ **Multiplies the per-kg sell rate by (LED 1)!H265 — the mediaplayer quantity** — almost certainly intended to be the chargeable weight `!L242`. As built it just shows the rounded per-kg sell rate (8 sea / 20 air).

**Reseller block (Q–U, header S1 = 10%):** Q Equipment `= J × 1.1`; R Services `= L × 1.1`; S Total `= ROUND(M × 1.1, -1)`; T Qty; U Extended. ⚠ Only exists for the LED section; the LCD section has no reseller columns (T23/U23 sum empty ranges → 0).

**LED Total row 12** sums N, O, T, U, W, X, Z, AA over rows 3–11.

## 3.3 Standard inclusions text (rows 7–11, fixed T&C paragraphs)
1. Includes: site preparation documentation, installation, consumables, configuration, commissioning, OHS documentation, project management, training, freight to site, rubbish disposal, travel, transition to support.
2. Based on site prepared by client per site prep requirements (power, data, thermal, structure/cabinetry).
3. Controller and mediaplayer in rack connected to screen by CAT6.
4. Excludes: engineering, traffic management, barricading, permits; access equipment at cost +20%; onsite induction allowance up to 15 min; storage up to 1 month from scheduled install (then $10/month/sqm of LED); additional labour (incl. waiting for site) $160ex/hr business hours, $250ex/hr out of hours.
5. Warranty onsite with a Seen Support agreement (else return to base), excluding access equipment and travel outside metro.

## 3.4 LCD section (rows 13–23)
Per row: B ←`!B2` · C ←`!C2` · D = "Single Visit to Site, " & `!E2` & " Services, " & `!D2` · I Warranty = `!F2` & " years" · J ←`!G2` · K `= ROUND(!H2, -1)` · L `= ROUND(!I2, -1)` · M `= ROUND(!J2, -1)` · N qty · O `= M×N` · X Freight cost `= SUM(!G42:G44) × N` · Z Labour hours `= SUM(!K27:K29) × N` · AA Labour budget `= SUM(!G27:G33) × N` (⚠ sell dollars, whereas the LED AA column is cost dollars). LCD Total row 23; Screen Total row 24 = LED + LCD.

## 3.5 Reference price list & ongoing costs (rows 25–34)
- SeenCMP Windows mediaplayer: hardware K26 = LCDRef!K197 (655) + config L26 = LCDRef!K452 ⚠ (points at "Adjustable Stand 13POS-SINGLE-HA", 179.20 — likely meant the Media Player Configuration row; the label says config) → M26 = 834.20.
- iVisual mediaplayer 690 / 920.
- High-temp + 4G upgrade option: cost K28 = 1,295, quoted uplift M28 = 700 (requires client SIM on Seen data pack $400ex p.a. 12 mo/50 Gb).
- Ongoing: SeenCMP Licence & Support yr 1 $395; Interactive $495; subsequent screen on site $125; 4G datapack (12 mo/25 Gb) $400; iVisual annual licence & support $880 (typical live property feed; REA/domain may cost extra).

## 3.6 Terms (rows 36–38)
- B37: `"All prices are ex-GST; valid as at " & TEXT(NOW()+17/24, "DD-MMM-YYYY") & " for 14 days and AUD:USD 1:" & (F3 + 0.01) & ", and subject to the conditions on last page…"` — **validity 14 days; published FX = static rate + 0.01; NOW()+17/24 is a +17-hour timezone shift hack.**
- B38: equipment prices firm on described solution; services budgetary on typical-installation assumptions.

---

# PART 4 — ANOMALIES & DECISIONS FOR THE NEW SYSTEM

**Corrections to the earlier extraction (verified against formulas):**
- **Published LED prices are margin-regrossed, not marked-up.** J2/K2/L2 each = component cost ÷ (1 − LED margin), rounded to $10. The per-line ×1.5/×1.65 sell columns are informational and do not drive the quote total.
- **Controller & LED-peripheral prices are used with no FX conversion** (unlike screens/spares/packaging/receiving cards/hanging rails, which are USD ÷ F3). Confirm which currency those tables are in.
- **5-yr warranty base** excludes international freight and Sea LCL but **includes local delivery**.

**Full decision list:**
1. **Aspect band 1.56–1.68 labelled "0.67"** — should almost certainly be 16:10.
2. **VX controller thresholds off-by-one** (exactly 4 → over-provisions; exactly 20 → "No Match"); Standard/TB inclusive, VX exclusive — inconsistent.
3. **No capacity validation** on Standard/TB (over-port screens silently under-provision); **Max Pixels / Max Width never enforced** (MCTRL700's 2.6M-pixel cap = only 4 ports' worth despite 6 ports).
4. **Height pixels use horizontal pitch R5** — latent bug.
5. **WALL port rule parses model-name character positions**; also uses *desired* width, not snapped width. Make both a product attribute + snapped dimension.
6. **Sizing snaps with ROUND, not ROUNDUP** — screens can be smaller than requested.
7. **Spares: 15% (no GOB) / 10% (GOB) in the cost model vs "5% modules" hardcoded in the description** text.
8. **Freight dead code:** `IF(C23="Sea", 0, …)` never matches any option string; Sea LCL relies on the H268 flag instead. Local delivery collapses to the location minimum under Sea LCL (multiplier applies to a $0 freight line).
9. **Airfreight-uplift weight tiers ((LED 1)!P275)** mix Standard (<100 kg), Express (<250), NZ Standard (<500) rates and reference an empty cell for ≥500 kg — intent unclear.
10. **Summary AC/AD alternate-freight figure multiplies the rate by the mediaplayer quantity (!H265)** instead of chargeable weight (!L242).
11. **Reseller (+10%, round $10) columns exist only for the LED section** — LCD rows have none.
12. **LCD published split is mixed-method**: screens at line sell, brackets at 30%-margin regross, services = residual, total = total cost ÷ 0.7 rounded to $10.
13. **LCD out-of-hours uplift excludes site-attendance hours** (sums K28:K29 only).
14. **LCD media-player-config cost hardcoded 40** on the tab vs 15 in LCDRef.
15. **4G datapack sold below cost** (450 → 400).
16. **Summary M26 config price points at a bracket row** (LCDRef!K452) rather than the config service row.
17. **Inconsistent markups on similar lines**: supplier brackets & hanging bars ×1.65 service markup within LED supply; parking ×1.5 international-shipping markup; permits/footings ×1.33 hardcoded; mediaplayer sell regrossed at margin while everything adjacent is ×markup.
18. **Client margin list (12 names) hardcoded in RefData!F13; client rules are free text** — move to client configuration records (margin override, controller substitution, mediaplayer policy, default pitch, trim default, licensing, cabinet-depth constraints).
19. **FX**: quotes run on a manually maintained static rate (F3 = 0.6845) while a live GOOGLEFINANCE−0.005 feed sits unused beside it; published rate = static + 0.01. Replace with an FX API honouring both buffers.
20. **Frozen Google-Sheets formulas** (description assembly, warranty regex, peripheral splitting, FX) must be reimplemented — the Excel file only carries cached results.
21. **Viewing distance**: no formula or lookup exists anywhere in the workbook (only per-product pitch and client pitch preferences). Confirm the source of truth; conventional rule if wanted: min viewing distance (m) ≈ pixel pitch (mm).
22. **Manual carry-over cells** ((LED 1)!K242 "Previous" weight, E245 Sides, add-on rows 255–257, As-Quoted row 279, install hour overrides) need first-class UI equivalents.
