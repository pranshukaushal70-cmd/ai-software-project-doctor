import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runDetection } from "./detection";
import { loadFixtures } from "./ground-truth";
import { detectionMarkdown, pct } from "./report";

// npm run bench:detection [-- --write | --check] [--fixture name ...]
//   (default)  print the summary
//   --write    update results/detection.json and results/detection.md
//   --check    exit 1 if the results differ from the committed ones (CI)

const { values } = parseArgs({ options: { write: { type: "boolean" }, check: { type: "boolean" }, fixture: { type: "string", multiple: true } } });
const RESULTS = new URL("../results/", import.meta.url);

const result = await runDetection(await loadFixtures(values.fixture));
const json = JSON.stringify(result, null, 2) + "\n";
const md = detectionMarkdown(result);

for (const f of result.fixtures) {
  console.log(`${f.name.padEnd(14)} TP ${f.score.truePositives}  FP ${f.score.falsePositives}  FN ${f.score.falseNegatives}  (${f.findings} findings, ${f.score.outOfScope} out of scope)`);
}
console.log(`overall        precision ${pct(result.overall.precision)}  recall ${pct(result.overall.recall)}  F1 ${pct(result.overall.f1)}`);

if (values.write) {
  await mkdir(RESULTS, { recursive: true });
  await writeFile(new URL("detection.json", RESULTS), json);
  await writeFile(new URL("detection.md", RESULTS), md);
  console.log(`wrote ${fileURLToPath(new URL("detection.json", RESULTS))} and detection.md`);
}
if (values.check) {
  if (values.fixture?.length) throw new Error("--check compares all fixtures; do not combine it with --fixture");
  const committed = await readFile(new URL("detection.json", RESULTS), "utf8").catch(() => "");
  if (committed.replace(/\r\n/g, "\n") !== json) {
    console.error(
      "Detection results differ from benchmarks/results/detection.json. If the change is intended (new rule, fixed false positive, new fixture), " +
        "run `npm run bench:detection -- --write`, review the diff and commit it.",
    );
    process.exit(1);
  }
  console.log("results match benchmarks/results/detection.json");
}
