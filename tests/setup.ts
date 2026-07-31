import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellone-test-"));
process.env.BELLONE_DATA_DIR = dir;
