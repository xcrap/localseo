import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import "../src/db";
import { createOrReplaceAdmin, getAdminById } from "../src/auth";

const existing = getAdminById("local-admin");
if (!existing) {
  console.error("No admin exists. Run bun run admin:create first.");
  process.exit(1);
}

const rl = createInterface({ input, output });
const password = await rl.question(`New password for ${existing.email}: `);
rl.close();

await createOrReplaceAdmin(existing.email, password);
console.log("Password updated. Existing browser sessions were signed out.");
