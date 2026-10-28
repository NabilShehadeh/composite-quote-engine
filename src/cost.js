// The rule-of-thumb quote: what a quoting engineer would work out by hand from the geometry.
// The model does not replace this. It learns how far real jobs drift from it, and why.
//
// Every rate here is an illustrative assumption for the demo, not any supplier's real pricing.

export const RATES = {
  prepreg: 85,        // $ per m² per ply, intermediate-modulus carbon prepreg
  scrap: 0.35,        // material lost to nesting and trim
  cell: 110,          // $ per hour for a layup cell and its operator
  oven: 70,           // $ per hour of oven time
  ovenArea: 1.6,      // m² of shelf per oven load
  cureHours: 2.5,     // one cure cycle
  trim: 6,            // $ per metre of trimmed edge (router plus deburr)
  inspect: 6,         // minutes of inspection per part
  margin: 0.22,       // gross margin on the unit cost
};

// Layup cycle: a fixed robot setup per part, plus time that grows with area and ply count.
export function cycleMinutes(f) {
  return 4 + 22 * f.layup_area_m2 * Math.pow(f.plies, 0.8) + 0.4 * f.plies;
}

export function formulaQuote(f, qty, r = RATES) {
  const material = f.layup_area_m2 * f.plies * r.prepreg * (1 + r.scrap);
  const cycle = cycleMinutes(f);
  const layup = (cycle / 60) * r.cell;
  const footprint = (f.mold_len_mm / 1000 + 0.05) * (f.mold_wid_mm / 1000 + 0.05);
  const perLoad = Math.max(1, Math.floor(r.ovenArea / footprint));
  const cure = (r.oven * r.cureHours) / perLoad;
  const trimLen = 2 * (f.mold_len_mm + f.mold_wid_mm) / 1000;
  const trim = trimLen * r.trim + 1.5;
  const inspect = (r.inspect / 60) * r.cell;
  const tooling = 600 + 2400 * footprint + 6 * f.depth_mm;   // one aluminium tool, amortised over the order
  const unitCost = material + layup + cure + trim + inspect;
  const unitPrice = unitCost * (1 + r.margin) + tooling / qty;
  // Weeks: tool build, then production on 4 cells × 20 h × 5 days, then inspection and shipping.
  const productionWeeks = (qty * cycle) / (4 * 20 * 60 * 5);
  const leadWeeks = Math.max(2, Math.ceil(1 + productionWeeks + 1));
  return {
    unitPrice,
    parts: { material, layup, cure, trim, inspect, tooling: tooling / qty, margin: unitCost * r.margin },
    cycle, perLoad, leadWeeks, tooling,
  };
}
