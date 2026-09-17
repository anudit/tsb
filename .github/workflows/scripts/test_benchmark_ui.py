"""Run the actual inline UI script with a tiny DOM and benchmark fixtures."""
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[3]


class BenchmarkUITest(unittest.TestCase):
    def test_disclosures_cover_incomplete_filtered_legacy_and_empty_results(self):
        script = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(process.argv[1], 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const row = {function:'join',tsb:{mean_ms:1},pandas:{mean_ms:2},ratio:0.5};
async function render(data, includeRows = false) {
  const elements = new Map();
  const rows = [];
  const element = () => ({style:{},hidden:true,textContent:'',appendChild(row){ rows.push(row.innerHTML); }});
  const document = {getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement:element};
  await vm.runInNewContext(source, {document,fetch:async () => ({ok:true,json:async () => data})});
  assert.equal(elements.get('measurement-status').hidden, false);
  return includeRows ? rows.join('\n') : elements.get('measurement-status').textContent;
}
(async () => {
  const base = {schema_version:2,benchmarks:[row],status:'incomplete',summary:{completed:1,total:3,failed:2},scope:{kind:'all',discovered_pairs:3},provenance:{candidate_sha:'a'.repeat(40)}};
  const incomplete = await render(base);
  assert.match(incomplete,/Incomplete measurement/);
  assert.match(incomplete,/1\/3 selected pairs completed; 3 pairs discovered; 2 failed/);
  assert.match(incomplete,/Measured SHA: a{40}/);
  assert.match(incomplete,/not proof of correctness, API parity/);
  const filtered = await render({...base,status:'complete',summary:{completed:1,total:1,failed:0},scope:{kind:'filtered',discovered_pairs:842}});
  assert.match(filtered,/Filtered measurement — not the full/);
  assert.match(filtered,/842 pairs discovered/);
  const legacy = await render({benchmarks:[row],timestamp:'2026-04-21'});
  assert.match(legacy,/Coverage\/provenance unknown/);
  assert.match(legacy,/Measured SHA: unknown/);
  assert.doesNotMatch(legacy,/collection complete/);
  const inconsistent = await render({...base,status:'complete',summary:{completed:1,total:1,failed:0}});
  assert.match(inconsistent,/Coverage\/provenance unknown/);
  const empty = await render({...base,benchmarks:[],summary:{completed:0,total:3,failed:3}});
  assert.match(empty,/Incomplete measurement/);
  assert.match(empty,/0\/3 selected pairs completed/);
  for (const ratio of [0, -1, NaN, Infinity, -Infinity, '0.5']) {
    const invalid = await render({benchmarks:[{...row,ratio}]}, true);
    assert.match(invalid,/unresolvable timing ratio/);
    assert.doesNotMatch(invalid,/Infinity|NaN|x faster/);
  }
  const tiny = await render({benchmarks:[{...row,ratio:0.0001}]}, true);
  assert.match(tiny,/0.0001x/);
  assert.match(tiny,/10000.00x faster/);
  const reciprocalOverflow = await render({benchmarks:[{...row,ratio:Number.MIN_VALUE}]}, true);
  assert.doesNotMatch(reciprocalOverflow,/Infinity|NaN/);
  const zeroTiming = await render({benchmarks:[{...row,tsb:{mean_ms:0}}]}, true);
  assert.match(zeroTiming,/unresolvable timing ratio/);
})().catch(error => { console.error(error); process.exitCode=1; });
"""
        result = subprocess.run(["node", "-e", script, str(ROOT / "playground" / "benchmarks.html")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_pages_uses_the_existing_ci_pandas_versions(self):
        install = "pip install pandas==2.2.3 numpy==2.1.3"
        for name in ("pages.yml", "ci.yml"):
            self.assertIn(install, (ROOT / ".github" / "workflows" / name).read_text())


if __name__ == "__main__":
    unittest.main()
