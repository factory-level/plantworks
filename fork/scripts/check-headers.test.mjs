// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingHeaders } from "./check-headers.mjs";

test("flags files without the SPDX header and exempts JSON and NOTICE", () => {
  const files = {
    "fork/a.ts": "// SPDX-License-Identifier: Apache-2.0\nexport {};\n",
    "fork/b.sh": "#!/usr/bin/env bash\n# SPDX-License-Identifier: Apache-2.0\n",
    "fork/c.mjs": "export const x = 1;\n",
    "fork/d.md": "# title\n\n\n\n\n<!-- SPDX-License-Identifier: Apache-2.0 -->\n",
    "fork/package.json": "{}",
    "fork/NOTICE": "Plantworks\n",
  };
  assert.deepEqual(missingHeaders(Object.keys(files), (f) => files[f]), ["fork/c.mjs", "fork/d.md"]);
});
