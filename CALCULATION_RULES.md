# Team Performance Website — Calculation Rules

> **Purpose:** This file documents the exact business rules for every metric
> calculated across all dashboards. Reference this file in any new request to
> ensure these rules are never broken or changed without explicit instruction.

---

## 1. Sales — Average Claim Time

**Definition:** Time from when an order became "claimable" to when the sales agent
first claimed it.

| Column used | Field |
|---|---|
| `ORDER_CREATION_DATE` + `ORDER_CREATION_time` | Order creation datetime |
| `HOURS_TYPE` | Working / Non-Working flag |
| `SALES_CLAIM_DATE_FIRST` + `SALES_CLAIM_TIME_FIRST` | First claim datetime |

### Non-Working Hours Rule (CRITICAL — do not remove)

- If `HOURS_TYPE` contains **"non"** (case-insensitive, e.g. "Non Working",
  "NON WORKING", "non-working"), the SLA clock **does not start at order
  creation time**.
- Instead, the clock starts at **09:00 AM on the next calendar day**.
- If `HOURS_TYPE` is working (no "non" in the value), the clock starts at the
  **actual order creation datetime**.

```
effectiveStart =
  hoursType.toLowerCase().includes("non")
    ? nextDay @ 09:00:00
    : orderCreationDatetime

salesClaimTimeSec = claimDatetime - effectiveStart
```

**Sales working hours:** 09:00 – 22:00 (9 AM – 10 PM)

### Bad Handling Exclusion

Orders with `claimTimeSec > 60,000 seconds` (~16.7 hours) are counted as
**bad handling** and are **excluded from the average**. They are shown
separately as a `badHandlingCount` per agent.

---

## 2. Sales — Average Assignment Time

**Definition:** Time from when the sales agent claimed the order to when it was
assigned to logistics.

```
salesAssignTimeSec = logisticsAssignDatetime - claimDatetime
```

- Uses `LOGISTICS_ASSIGN_DATE_1` + `LOGISTICS_ASSIGN_TIME_1` as the logistics
  assignment timestamp.
- Uses `SALES_CLAIM_DATE_FIRST` + `SALES_CLAIM_TIME_FIRST` as the start.
- **Bad handling exclusion applies:** orders above 60,000 seconds are excluded
  from the average.

---

## 3. Logistics — Average Claim Time

**Definition:** Time from when the logistics agent was assigned an order to
when they first claimed it.

```
logisticsClaimTimeSec = logisticsClaimDatetime - effectiveLogisticsAssignDatetime
```

- Start: `LOGISTICS_ASSIGN_DATE_1` + `LOGISTICS_ASSIGN_TIME_1` (with working hours adjustment)
- End: `LOGISTICS_CLAIM_DATE_FIRST` + `LOGISTICS_CLAIM_TIME_FIRST`
- **Bad handling exclusion:** orders above 60,000 seconds excluded from average.

**Logistics working hours:** 09:00 – 20:00 (9 AM – 8 PM)

### Working Hours Rule (CRITICAL — do not remove)

If the order is assigned **outside** logistics working hours (before 9 AM or after 8 PM),
the SLA clock **does not start at the actual assignment time**.

- If assigned **before 9 AM**: clock starts at **09:00 AM on the same calendar day**
- If assigned **after 8 PM**: clock starts at **09:00 AM on the next calendar day**
- If assigned **within working hours**: clock starts at the actual assignment time

**Example:** Order assigned at 10:00 PM, claimed at 11:00 AM next day  
**Calculation:** 11:00 AM - 9:00 AM (next day) = **2 hours** (not 13 hours)

---

## 4. Logistics — Average Activation Assignment Time

**Definition:** Time from when the logistics agent claimed the order to when
it was assigned to the activation team.

```
activationAssignTimeSec = activationAssignDatetime - logisticsClaimDatetime
```

- Start: `LOGISTICS_CLAIM_DATE_FIRST` + `LOGISTICS_CLAIM_TIME_FIRST`
- End: `ACTIVATION_ASSIGN_DATE` + `ACTIVATION_ASSIGN_TIME`
- **Bad handling exclusion:** orders above 60,000 seconds excluded from average.

---

## 5. Activation — Average Claim Time

**Definition:** Time from when the activation agent was assigned the order to
when they first claimed it.

```
activationClaimTimeSec = activationClaimDatetime - effectiveActivationAssignDatetime
```

- Start: `ACTIVATION_ASSIGN_DATE` + `ACTIVATION_ASSIGN_TIME` (with working hours adjustment)
- End: `ACTIVATION_CLAIM_DATE` + `ACTIVATION_CLAIM_TIME`
- **Bad handling exclusion:** orders above 60,000 seconds excluded from average.

**Activation working hours:** 09:00 – 22:00 (9 AM – 10 PM)

### Working Hours Rule (CRITICAL — do not remove)

If the order is assigned **outside** activation working hours (before 9 AM or after 10 PM),
the SLA clock **does not start at the actual assignment time**.

- If assigned **before 9 AM**: clock starts at **09:00 AM on the same calendar day**
- If assigned **after 10 PM**: clock starts at **09:00 AM on the next calendar day**
- If assigned **within working hours**: clock starts at the actual assignment time

**Example:** Order assigned at 10:00 PM, claimed at 11:00 AM next day  
**Calculation:** 11:00 AM - 9:00 AM (next day) = **2 hours** (not 13 hours)

---

## 6. Agent Mapping Rules

- **Sales agents** are sourced from `SALES_USER_FIRST` / `SALESMAN_ID` columns.
- **Logistics agents** are sourced from `LOGISTICS_USER_FIRST`, `LOGISTICS_USER_LAST`,
  and `DELIVERY_USER` columns.
- **Activation agents** are sourced from `ACTIVATION_USER` column.
- On import, every agent is auto-saved to `agentMappings` in Firestore with the
  correct default type derived from the column they appeared in.
- Existing mappings are **never overwritten** during import — only new agents are added.
- An agent set as **not active** (`visible: false`) in Admin → Agent Mappings
  will **not appear on any dashboard**.
- A mapped agent's type determines which dashboard they appear on exclusively
  (sales → Sales dashboard only, logistics → Logistics only, activation → Activation only).

---

## 7. Bad Handling Threshold

- **Threshold:** 60,000 seconds (~16.7 hours / ~1,000 minutes)
- Any order whose relevant time metric exceeds this threshold is classified as
  bad handling.
- Bad handling orders are **counted separately** (`badHandlingCount`) but are
  **excluded from all average time calculations**.
- This rule applies to: sales claim time, sales assign time, logistics claim
  time, logistics activation assign time, and activation claim time.

---

## 8. Date Filters Available

All three dashboards (Sales, Logistics, Activation) support these date filters:

| Filter key | Range |
|---|---|
| `today` | Current calendar day |
| `yesterday` | Previous calendar day |
| `week` | Current week (Sun – today) |
| `lastmonth` | Full previous calendar month |
| `month` | Current calendar month (1st – today) |
| `mtd` | Month to date (same as month) |
| `quarter` | Current calendar quarter |
| `annual` | Current calendar year |
| `custom` | User-selected date range |

---

## Implementation Reference

| Rule | Where implemented |
|---|---|
| Non-working hours start time | `Admin.jsx` → `getEffectiveSalesStartTime()` + `doImport()` |
| Bad handling exclusion | `AgentsPerformance.jsx`, `LogisticsPerformance.jsx`, `ActivationPerformance.jsx` → `agentData` memo |
| Agent type auto-save | `Admin.jsx` → `doImport()` agent mapping loop (uses `parsedAgents`) |
| Working hours config | `src/utils/sla.js` → `WORKING_HOURS` |
| Last month filter | `getRangeBounds()` in all three performance pages |
