import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import "../src/db";
import { createOrReplaceAdmin } from "../src/auth";

const rl = createInterface({ input, output });
const email = (await rl.question("Admin email: ")).trim();
const password = await rl.question("Password (min 10 chars): ");
rl.close();

const user = await createOrReplaceAdmin(email, password);
console.log(`Admin saved: ${user.email}`);
