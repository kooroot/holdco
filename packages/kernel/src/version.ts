import { readFileSync } from "node:fs"
import { join } from "node:path"
/** The kernel's own version, from its package.json (what `holdco init` records and `smoke` prints). */
export const KERNEL_VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version
