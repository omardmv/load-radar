# GLiNER2 spike (2026-11-04)

**Question:** can GLiNER2 (`fastino/gliner2-base-v1`, Apache-2.0, `pip install gliner2` + `torch`) turn dispatcher search text into our search fields, locally and fast?

**Setup:** MacBook (M4 Pro), CPU, Python 3.15, torch 2.15, gliner2 2.1.0. Schema: entities `origin_city`, `destination`, `rate_per_mile`, `deadhead_miles` + classification `equipment` ∈ {van, reefer, flatbed}. Scripts: `gliner2_templates.py`, `gliner2_messy.py`.

## Results

- **Speed:** ~50 ms per search after loading (first load 82 s including the download). Fine for the cold path (search creation), far too slow per posting.
- **Generator's own phrasings (10):** 10/10 correct spans for every field. These are clean templates, so this is the easy case.
- **Messy hand-written phrasings (6):** about half the fields right.
  - Shorthand breaks it: `DH 150 RPM 3.1` came out as one rate span.
  - Extra words stick: `joliet tmrw`.
  - Regions and directions (`southeast`, `north`) aren't places.
  - Typos survive (`savanah`); a destination copied the origin.
  - **No "unknown" option:** "need loads out of dallas" was classified as flatbed. A forced-choice classifier always answers.
- **Ambiguity:** "going LA" was Louisiana (state code) in the truth data; our gazetteer maps LA to Los Angeles. The model extracts the text, but meaning needs context and the confirm step.

## Design consequences

1. **Hybrid parser:** rules for structured tokens (`DH 150`, `RPM 3.1`, `$3.40/mi`, `100 mi`), GLiNER2 for places, destination and equipment, then our gazetteer with fuzzy matching (`savanah` → Savannah), region → states mapping, and validation.
2. **Equipment needs an "unspecified" label plus a confidence threshold;** below it, ask the user instead of guessing.
3. **Ambiguous places (LA, Columbus, Portland…) are resolved by the confirm step,** never silently.
4. **Eval set must include messy text** (shorthand, typos, regions, missing fields), not only generator templates. A local LLM (Qwen 2.5 1.5B) can paraphrase templates into messy variants.
5. **Possible ML step:** fine-tune GLiNER2 on labeled synthetic + messy phrasings (the library supports training), then measure the gain on the eval set.
