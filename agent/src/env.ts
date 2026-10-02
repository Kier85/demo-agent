import { existsSync } from "node:fs";
import path from "node:path";

// Loads agent/.env if present. Real environment variables win.
const file = path.join(import.meta.dirname, "..", ".env");
if (existsSync(file)) process.loadEnvFile(file);
