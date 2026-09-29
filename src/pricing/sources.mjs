// Price sources: where a list price comes from and how its page is read.
//
// Both vendors publish their price tables as Markdown at a stable URL, next to
// the HTML page a human reads. That is the source: the official page itself,
// not a copy of it in a third-party dataset that has to be kept in sync by
// somebody else. The cost is a parser per page; the parser is strict on purpose
// (see parse*), so a redesigned page is a failed refresh, never a wrong price.
//
// A source knows nothing about harnesses: it names a vendor ("anthropic",
// "openai"). Which harness is billed by which vendor is the provider's business.
//
// Rates are USD per million tokens in five token classes, the classes every
// provider already reports usage in:
//   in   uncached input      cr   cache read (hit / refresh)
//   out  output              c5   cache write, 5-minute tier
//                            c1h  cache write, 1-hour tier
// A class the page does not publish is null, never a guess. `long` holds a
// second rate set that applies above `above` input tokens per request.

const MIN_ROWS = 5;                 // fewer than this parsed = the page changed shape

/** "$12.50 / MTok<sup>1</sup>" -> 12.5; "-" or "" -> null; anything else throws. */
export function dollars(cell) {
  const s = String(cell).replace(/<sup>.*?<\/sup>/gi, "").replace(/<[^>]*>/g, "").trim();
  if (s === "-" || s === "" || s === "—") return null;
  const m = s.match(/^\$\s*([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*MTok)?$/i);
  if (!m) throw new Error(`unreadable price cell '${s}'`);
  return Number(m[1]);
}

/** The first Markdown table after `anchor`: its header cells and body rows. */
function tableAfter(text, anchor) {
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error(`section '${anchor}' not found`);
  const lines = text.slice(at).split("\n");
  let i = lines.findIndex(l => l.trim().startsWith("|"));
  if (i < 0) throw new Error(`no table after '${anchor}'`);
  const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
  const head = cells(lines[i]).map(h => h.toLowerCase());
  const rows = [];
  for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]));
  return { head, rows };
}

const col = (head, ...names) => {
  for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; }
  throw new Error(`column '${names[0]}' not found`);
};

// "Claude Opus 5.5" -> "claude-opus-5-5"; "Claude Mythos 5.1 ([limited…](…))" -> "claude-mythos-5-1".
// Only the current naming scheme maps cleanly, and only it is needed: the retired
// "Claude Haiku 3.5" becomes "claude-haiku-3-5", an id no transcript carries, so
// it is simply never looked up.
const anthropicId = name => "claude-" + name.replace(/\(.*$/, "").trim()
  .replace(/^claude\s+/i, "").toLowerCase().replace(/[.\s]+/g, "-");

export function parseAnthropic(text) {
  const { head, rows } = tableAfter(text, "## Model pricing");
  const c = { name: col(head, "model"), in: col(head, "base input tokens"),
    c5: col(head, "5m cache writes"), c1h: col(head, "1h cache writes"),
    cr: col(head, "cache hits and refreshes"), out: col(head, "output tokens") };
  const out = rows.map(r => ({ model: anthropicId(r[c.name]), rates: {
    in: dollars(r[c.in]), out: dollars(r[c.out]), cr: dollars(r[c.cr]),
    c5: dollars(r[c.c5]), c1h: dollars(r[c.c1h]) }, long: null }));
  return checked(out, "anthropic");
}

// OpenAI publishes one standard table with a short- and a long-context half.
// Only the Standard tier is read: Batch, Flex and Fast are request options the
// Codex store does not record per call, so there is nothing to select them by.
export const OPENAI_LONG_ABOVE = 272_000;
export function parseOpenAI(text) {
  const { head, rows } = tableAfter(text, "### Standard pricing data");
  const c = { name: col(head, "model"),
    in: col(head, "short context input"), cr: col(head, "short context cached input"),
    cw: col(head, "short context cache writes"), out: col(head, "short context output"),
    lin: col(head, "long context input"), lcr: col(head, "long context cached input"),
    lcw: col(head, "long context cache writes"), lout: col(head, "long context output") };
  const out = rows.map(r => {
    const rates = { in: dollars(r[c.in]), out: dollars(r[c.out]), cr: dollars(r[c.cr]),
      c5: dollars(r[c.cw]), c1h: dollars(r[c.cw]) };
    const lin = dollars(r[c.lin]);
    return { model: r[c.name].replace(/\s*\(.*\)\s*$/, "").trim(), rates,
      long: lin == null ? null : { above: OPENAI_LONG_ABOVE, rates: { in: lin, out: dollars(r[c.lout]),
        cr: dollars(r[c.lcr]), c5: dollars(r[c.lcw]), c1h: dollars(r[c.lcw]) } } };
  });
  return checked(out, "openai");
}

/** A parse that looks wrong is an error: a refresh must fail rather than store it. */
function checked(rows, vendor) {
  const ok = rows.filter(r => r.model && r.rates.in > 0 && r.rates.out > 0);
  if (ok.length < MIN_ROWS) throw new Error(`${vendor}: only ${ok.length} priced rows parsed`);
  return ok;
}

// Transcript model ids that differ from the listed id only by decoration.
const normalizers = {
  // "claude-haiku-4-5-20251001" (dated snapshot) and "claude-sonnet-5[1m]"
  // (the harness's 1M-context marker; 1M context is billed at standard rates).
  anthropic: m => [m, m.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "")],
  openai: m => [m],
};

export const SOURCES = [
  { vendor: "anthropic", url: "https://platform.claude.com/docs/en/about-claude/pricing.md",
    page: "https://platform.claude.com/docs/en/about-claude/pricing", parse: parseAnthropic },
  { vendor: "openai", url: "https://developers.openai.com/api/docs/pricing.md",
    page: "https://developers.openai.com/api/docs/pricing", parse: parseOpenAI },
];

/** Candidate ids to look a transcript's model up by, most specific first. */
export const candidates = (vendor, model) =>
  [...new Set((normalizers[vendor] || (m => [m]))(String(model)))];
