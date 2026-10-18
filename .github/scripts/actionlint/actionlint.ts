import { root, run } from "../run/run.ts";

const workflows = Array.from(
  new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root }),
).sort();
if (!workflows.length) throw new Error("No GitHub Actions workflows found");

for (const workflow of workflows) {
  // actionlint 1.7.12 needs ./ spelling for GitHub's newer $/ self references
  const source = (await Bun.file(`${root}/${workflow}`).text()).replace(
    /^(\s*uses: )\$\//gm,
    "$1./",
  );
  await run(
    ["actionlint", "-color", "-stdin-filename", workflow, "-"],
    new TextEncoder().encode(source),
  );
}
