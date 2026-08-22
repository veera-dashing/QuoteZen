# QuoteZen — Technical & Business Understandings Document

Commercial quoting engine for Seen Technology (digital-signage / AV). It builds multi-component client proposals by combining hardware catalogs, custom manufacturing, regional labour rates, logistics, and recurring software licences into a single audited web-based wizard — replacing a complex Excel workbook (`2026-XXX Quote Base V1.3`).

---

## 1. Storage & Usage of QuoteBase Excel Data

### 1.1 Ingestion Pipeline & Source-to-Database Mapping
The original workbook `2026-XXX Quote Base V1.3` contains 14 key sheets (`Reference Data`, `PI`, `Summary`, `LED 1`, `LCD 1`, `LCDRef`, `Licence & Support`, `Manufactured`, `Audio`, `Music`, `Software Costs`, `Hypervsn`, `Installer Breakdown`, `Import`).

```
[2026-XXX Quote Base V1.3 (XLSX)]
                 │
                 ▼ extract_catalog.py
     [prisma/data/catalog.json]
                 │
                 ▼ import-catalogs.ts & seed.ts
     [PostgreSQL Database (58 Tables)]
```

* **Ingestion Script (`extract_catalog.py`):** Parses the workbook sheets and outputs structured catalog records to `prisma/data/catalog.json`.
* **Database Seeder (`import-catalogs.ts` & `seed.ts`):** Populates ~850 catalog records into a fully relational PostgreSQL schema (58 tables).

### 1.2 Architecture of the 58 Relational Tables
The database model is structured into three clear functional layers (no unstructured JSON blobs for core pricing):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             POSTGRESQL DATABASE                             │
├──────────────────────────────┬──────────────────────────────┬───────────────┤
│ 1. Auth & Audit (4)          │ 2. Reference Catalog (~40)   │ 3. Quote (14) │
│ • users                      │ • led_products (230 rows)    │ • quotes      │
│ • roles                      │ • display_catalog (543 rows) │ • quote_led_  │
│ • quote_audit_log            │ • controllers & peripherals  │   screens     │
│ • quote_revisions            │ • installer_rates & locations│ • quote_lcd_  │
│                              │ • freight_options            │   screens     │
│                              │ • licence_components         │ • quote_      │
│                              │ • settings & exchange_rates  │   licences    │
└──────────────────────────────┴──────────────────────────────┴───────────────┘
```

1. **Auth & Audit Layer (4 tables):** `users`, `roles`, `quote_audit_log` (field-level transactional change log tracking who, when, field name, old value, new value), `quote_revisions` (immutable historical quote JSON snapshots).
2. **Reference / Catalog Layer (~40 tables):** The Product Master. Includes `led_products` (specs, min cabinet dimensions, pitch, power, weight, nits, cost/sqm USD), `display_catalog` (LCDRef master covering screens, media players, brackets, shrouds, networking), `controllers`, `led_peripherals`, `gob_options`, `trim_options`, `hanging_bar_options`, `frames`, `engineering_options`, `install_methods`, `access_equipment`, `warranty_options`, `service_hours_options`, `screen_ratios`, `installer_rates`, `locations`, `freight_options`, `currencies`, `exchange_rates`, `settings`, and commercial multipliers.
3. **Quote Transactional Layer (~14 tables):** `quotes` (header, job ref, status, currency, client, estimated/actual cost rollups), `quote_led_screens` (LED inputs, cabinet counts, specs, price snapshot), `quote_led_components` (flexible FK list for controllers, media players, peripherals attached to a screen), `quote_led_cost_breakdown`, `quote_lcd_screens`, `quote_lcd_items`, `quote_licences`, `quote_terms`, `quote_overrides`, `quote_documents`.

### 1.3 Key Data Handling Principles
* **Catalog vs. Quote Separation & Point-in-Time Price Snapshots:** Reference products live in catalog tables. When added to a quote, specs and unit prices are **snapshotted** on `quote_*` rows. If an admin modifies catalog pricing later, existing issued quotes remain byte-for-byte unchanged.
* **Money Representation:** All monetary values are stored as Postgres `NUMERIC` / Prisma `Decimal` (never floats). All arithmetic uses `decimal.js` helpers in `@quotezen/shared` (`add`, `mul`, `round`, `applyMarkup`).
* **Deprecate-Not-Delete (P1-08.4 / P1-11.4):** Catalog items carry a `deprecated` boolean flag. Deleting an item referenced by active quotes sets `deprecated = true` (audited), preventing catalog updates from breaking historical quotes or violating FK constraints (`onDelete: Restrict`).

---

## 2. Questionnaire & Input Structure (User Journey)

To determine screen selection and generate a proposal, the QuoteZen wizard collects inputs across 5 structured steps:

```
Step 1: Details ──► Step 2: LED Screens ──► Step 3: LCD Displays ──► Step 4: Licences ──► Step 5: Review
```

### Step 1: Quote Details & Site Context Intake
* **Header Information:** Job Reference Number, Job Title, Client selection, Target Shipping Location, Currency selection (AUD, USD, EUR, GBP, NZD, SGD, ZAR, MYR), Viewers (user permissions).
* **Site Context Intake (AA1):** End Customer Name, Site Address, Airside vs Landside, Sun Exposure (Direct sunlight / Indirect), Wall Substrate (Concrete, Drywall, Steel frame), Power & Data availability, Controller location, Window-facing flag, Space around screen (mm), Account Executive name.
* **Commercial Intake (AA6a):** Price Sensitivity, Indicative Client Budget (AUD), Project Tenure (months), Client "Must-Haves" text, Solutions Engineer requirement flag.

### Step 2: LED Screen Selection & Configuration Questionnaire
* **Dimensional & Environment Intake:**
  * Desired Opening Width ($W_{\text{mm}}$) & Height ($H_{\text{mm}}$) **OR** Target Pixel Resolution ($W_{\text{px}} \times H_{\text{px}}$).
  * Screen Orientation: Landscape vs Portrait.
  * Installation Environment: `Indoor` vs `Outdoor` (influences brightness threshold $\ge 4000\text{ nits}$, GOB requirement, outdoor hardware dependencies).
  * Approximate Viewing Distance ($m$): Filters candidate pixel pitch ($\text{pitch}_{\text{mm}} \le \text{viewingDistance}_m$).
* **Auto-Configurator Engine (`configureScreen`):**
  * Iterates `led_products`, snaps opening to whole cabinet dimensions $W_{\text{cabs}} = \lceil W / w_{\text{cab}} \rceil$, $H_{\text{cabs}} = \lceil H / h_{\text{cab}} \rceil$.
  * Computes fill percentage, physical size deviation, resolution, aspect ratio, and flags cut cabinets.
  * Ranks options by Manufacturer Priority, Model Priority, Area Fit, Preferred Aspect Ratio (`16:9`, `2:1`, `3:1`, `5:4`, `1:1`, `9:16`).
  * Offers **Good / Better / Best Tiers**:
    1. **Value (Bronze):** Lowest supply cost per sqm fitting opening.
    2. **Recommended (Ideal):** Top engine rank (closest area fit).
    3. **Premium (Gold):** Finest pixel pitch (highest image quality).
* **Peripherals & Options Questionnaire:**
  * **Controller:** Auto-selected based on total screen pixels $\le \text{max\_pixels}$, or manual override picker.
  * **Media Player:** SpinetiX, BrightSign, Windows PC, Outdoor High-Temp PC, or Built-in SeenCMP.
  * **Receiving Cards:** Quantity per cabinet (config-driven).
  * **Mounting Frame & Trims:** Frame selection (Aluminium, Steel, Standard Mount), Trim option, Hanging bar option.
  * **Coating Add-on:** GOB (Glue-on-Board) protective coating (mandatory for pitch $< 2.5\text{mm}$).
  * **Supply Upgrades:** High-resolution supply upgrade percentage, Engineering certification option.
* **Site Services & Logistics Questionnaire:**
  * **Installation Method:** Wall mount, Ceiling suspend, Recessed cavity, Freestanding ground mount.
  * **Access Equipment:** Scissor Lift, Boom Lift, Mobile Scaffold, None (day rate lookup).
  * **Installation Location / State:** Determines regional installer labour rate & hourly uplift ($/hr).
  * **Service & Maintenance Hours:** Standard Business Hours vs 24/7 4hr response window.
  * **Warranty Option:** 3-Year Standard, 5-Year Extended, 7-Year Extended.
  * **Freight Method:** Air Freight vs Sea Freight vs Flat per-screen Freight override.

### Step 3: LCD Screen & Display Questionnaire
* **Display Panel Selection:** Select panel from `display_catalog` (543-row catalog including Samsung, LG, Philips Q-Line, Sony, etc.).
* **Category Discriminator:** Display, Media Player, Bracket, Shroud, Mount, Network.
* **Display Configuration:** Orientation (Landscape vs Portrait), Display Quantity.
* **Site Requirement Checklist (AA3a):** Android required flag, Max mounting depth limit ($mm$), Needs separate PC, Needs separate hard drive.

### Step 4: Software & Licence Questionnaire
* **Software Platform Selection:** SeenOS, SignageLive, Navori, etc.
* **Licence Tiering Input:** Total Screen Count & Interactive Screen Count (applies tiered pricing: $270 site fee + $125/screen + $100 interactive uplift).
* **Hardware Support Tier:** Silver, Gold, Platinum support packages.

### Step 5: Review, Commercial Overrides & Governance
* **Itemised Price View:** Review breakdown of cost, sell, and gross margin per screen/line. Cost data masked for non-admin users (BR-081).
* **Commercial Price Overrides (P1-17):** Ability to override item sell price with sell-price pinning (recalculates overall quote margin; records original price, user ID, timestamp, and rationale in `quote_overrides`).
* **Governance Guardrails:**
  * **Margin Floor Guardrail (P1-19g.2):** Validates gross margin against systemic `margin_floor`. Non-admin users are blocked from issuing quotes below floor (403 error); admins can override with audit logging.
  * **Validation Engine Guardrail (P1-15):** Evaluates technical rules. Hard errors block quote finalisation unless overridden by admin.
* **Proposal Terms & Assumptions Editor:** Customise quote terms, assumptions, exclusions, and payment terms.
* **Risk Register Intake (T4):** Capture manual risks (category, severity `high`/`medium`/`low`, description, mitigation strategy).

---

## 3. Data & Business Rules Execution

### 3.1 Pure Pricing Engine Formulas (`packages/calc`)

#### A. LED Geometry & Physical Spec (`geometry.ts` / `led.ts`)
$$\text{cabs}_W = \max\left(1, \operatorname{round}\left(\frac{W_{\text{desired}}}{w_{\text{cab}}}\right)\right), \quad \text{cabs}_H = \max\left(1, \operatorname{round}\left(\frac{H_{\text{desired}}}{h_{\text{cab}}}\right)\right)$$
$$W_{\text{snapped}} = \text{cabs}_W \times w_{\text{cab}}, \quad H_{\text{snapped}} = \text{cabs}_H \times h_{\text{cab}}$$
$$\text{Area}_{\text{sqm}} = \frac{W_{\text{snapped}} \times H_{\text{snapped}}}{1,000,000}$$
$$\text{Res}_W = \operatorname{round}\left(\frac{W_{\text{snapped}}}{\text{pitch}_H}\right), \quad \text{Res}_H = \operatorname{round}\left(\frac{H_{\text{snapped}}}{\text{pitch}_V}\right), \quad \text{TotalPixels} = \text{Res}_W \times \text{Res}_H$$
$$\text{Weight}_{\text{kg}} = \text{Area}_{\text{sqm}} \times \text{kgPerSqm}$$

#### B. LED Supply Pricing & Add-Ons (`led.ts`)
$$\text{Cost}_{\text{Supply\_AUD}} = \frac{\text{Area}_{\text{sqm}} \times \text{CostPerSqm}_{\text{USD}}}{\text{FX}_{\text{USD}}}, \quad \text{Sell}_{\text{Supply\_AUD}} = \text{Cost}_{\text{Supply\_AUD}} \times \text{Markup}_{\text{LED}}\ (1.5\times)$$
$$\text{Cost}_{\text{Spares\_AUD}} = \text{Cost}_{\text{Supply\_AUD}} \times \text{SparesPct}\ (10\%), \quad \text{Sell}_{\text{Spares\_AUD}} = \text{Cost}_{\text{Spares\_AUD}} \times \text{Markup}_{\text{LED}}$$
$$\text{Cost}_{\text{Packaging\_AUD}} = \text{Cost}_{\text{Supply\_AUD}} \times \text{PackagingPct}, \quad \text{Sell}_{\text{Packaging\_AUD}} = \text{Cost}_{\text{Packaging\_AUD}} \times \text{Markup}_{\text{LED}}$$
$$\text{Cost}_{\text{ReceiverCards\_AUD}} = \text{CabinetCount} \times \text{ReceiverCardCost}_{\text{AUD}}, \quad \text{Sell}_{\text{ReceiverCards\_AUD}} = \text{Cost}_{\text{ReceiverCards\_AUD}} \times \text{Markup}_{\text{LED}}$$
$$\text{Cost}_{\text{GOB\_AUD}} = \text{Area}_{\text{sqm}} \times \text{GobCostPerSqm}_{\text{AUD}}, \quad \text{Sell}_{\text{GOB\_AUD}} = \text{Cost}_{\text{GOB\_AUD}} \times \text{Markup}_{\text{LED}}$$

#### C. Controller Selection Rule (`controller.ts`)
The engine iterates catalog controllers sorted by capacity ($\text{max\_pixels}$) ascending:
$$\text{Select controller where } \text{max\_pixels} \ge \text{TotalPixels}$$
If total pixels exceed the single largest controller capacity, the engine computes required multi-controller count: $\lceil \text{TotalPixels} / \text{max\_pixels} \rceil$ and flags over-capacity.

#### D. Installation Labour & Services (`install.ts` / `freight.ts`)
$$\text{LabourHours} = \text{Base (2 hrs)} + \lceil \text{Area}_{\text{sqm}} \rceil + \text{FrameInstallHours} + (\text{Hanging ? 4 hrs : 0 hrs})$$
$$\text{HourlyRate} = \text{AssemblyLabourRate } (\$45/hr) + \text{LocationHourlyUplift}$$
$$\text{Cost}_{\text{Labour}} = \text{LabourHours} \times \text{HourlyRate}$$
$$\text{FreightWeight}_{\text{kg}} = \max(\text{ActualWeight}_{\text{kg}}, \text{ActualWeight}_{\text{kg}} \times \text{VolumetricModifier})$$
$$\text{Cost}_{\text{SeaFreight}} = \left(\frac{\text{SeaOrigin}_{\text{USD}} + \text{SeaTransit}_{\text{USD/CBM}} \times \text{CBM}}{\text{FX}_{\text{USD}}} + \text{SeaDestination}_{\text{AUD}}\right) \times \text{SeaMultiple}\ (1.3\times)$$
$$\text{MarkupableCost} = \text{Cost}_{\text{Labour}} + \text{AccessEquipmentDayRate} + \text{FreightCost}_{\text{AUD}}$$
$$\text{Sell}_{\text{Services}} = (\text{MarkupableCost} \times \text{ServiceMarkup}\ [1.65\times]) + \text{EngineeringPrice}_{\text{AUD}}$$

#### E. Commercial Markups & Margin Rules (`constants.ts` / `lcd-tiers.ts`)
* **Category Markups:** Philips Q-Line $1.4\times$, Other Equipment $1.6\times$, Metalwork $1.5\times$, Service $1.65\times$, LED Supply $1.5\times$, Controller $1.5\times$, International Freight $1.5\times$.
* **Margin Formula:**
$$\text{Sell} = \frac{\text{Cost}}{1 - \text{Margin}}$$
* **Client Override Resolution (`P1-10`):** Client-specific preferred margin overrides global default margin. However, the systemic **Margin Floor** strictly wins:
$$\text{EffectiveMargin} = \max(\text{ClientPreferredMargin}, \text{MarginFloor})$$

#### F. Licence Tiering Rule (`licence.ts`)
$$\text{AnnualLicence} = \text{SiteFee } (\$270) + (\text{ScreenCount} \times \$125) + (\text{InteractiveCount} \times \$100)$$
*(First screen = $395; interactive first screen = $495; subsequent screens = $125).*

### 3.2 Technical Conflict & Validation Engine (`validation.ts`)
Evaluates rules and returns findings tagged with severity:
1. `GOB_REQUIRED` (Error): Triggered if pixel pitch $< 2.5\text{mm}$ and GOB protection is not selected.
2. `OUTDOOR_DEPENDENCIES` (Error): Outdoor environment requires Light Sensor, Multifunction Card, and High-Temp Media Player.
3. `CONTROLLER_PIXELS_EXCEEDED` (Error): Triggered if screen pixel count $> \text{controller max\_pixels}$.
4. `FRAME_DIMENSIONS_EXCEEDED` (Error): Triggered if screen dimensions exceed maximum frame width/height.
5. `LCD_BRACKET_SUBRANGE` (Warning): Triggered if LCD panel size falls outside bracket min/max inches.
6. `LCD_DEPTH_EXCEEDED` (Warning): Triggered if display depth exceeds site maximum depth.

### 3.3 Output Documents Generation (`outputs.ts` / `pdf.ts`)
* **Deterministic Descriptions (`descriptions.ts`):** Formats natural language screen specs using resolved screen ratios (e.g. `9:16`).
* **Procurement BOM & PI (`buildBom`):** Complete component breakdown (panels, frames, controllers, cables, cost lines). Cost fields are masked for non-admin users per BR-081.
* **Solution Summary (`buildSolutionSummary`):** High-level summary of job context, screens, software dependencies, assumptions, and exclusions.
* **PM Handoff (`buildPmHandoff`):** Execution-focused document containing site context, recess depth, custom metalwork lead-time alerts (3-4 week alert), and risk register.
* **Proposal PDF (`pdf.ts`):** Server-side PDF generation using `pdfkit` featuring title block, itemised pricing tables, solution descriptions, terms & conditions, and assumptions.
