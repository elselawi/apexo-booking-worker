// Regenerates src/client_script.generated.ts from assets/booking.js so the
// Worker can ship the client script as a text module (Wrangler treats .js
// imports as ES modules, never as text).
import { readFile, writeFile } from "node:fs/promises";

const source = await readFile(new URL("../assets/booking.js", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../assets/booking.css", import.meta.url), "utf8");
const output = `// Generated from assets/booking.js by tools/embed-client.mjs. Do not edit.
export const BOOKING_CLIENT_JS: string = ${JSON.stringify(source)};
export const BOOKING_CLIENT_CSS: string = ${JSON.stringify(cssSource)};
`;
await writeFile(new URL("../src/client_script.generated.ts", import.meta.url), output);
