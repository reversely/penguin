// Deploys Penguin on the Cloudflare account Wrangler is signed in to, sets up the project for one owner and prints
// the command that connects that owner's coding agent to Penguin's MCP endpoint.
//
//   npm run deploy -- --owner <id>
//
// Safe to run again: it keeps the issues queue, both secrets and the project's repos. The deployer token lives in
// ~/.config/penguin/deployer-token (mode 0600) and is never printed; the MCP token is printed once, for the person
// running this.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { webcrypto } from "node:crypto";

const { values } = parseArgs({ options: { owner: { type: "string" } } });
const owner = values.owner;
if (!owner || !/^[a-z0-9-]{1,64}$/u.test(owner)) {
  console.error("usage: npm run deploy -- --owner <id>   (lowercase letters, digits and dashes)");
  process.exit(1);
}

const root = join(import.meta.dirname, "..");
const worker = join(root, "apps", "worker");
const wrangler = (args, options = {}) =>
  execFileSync("npx", ["wrangler", ...args], { cwd: worker, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
const step = (text) => console.log(`- ${text}`);

try {
  wrangler(["whoami"]);
} catch {
  console.error("Sign in to Cloudflare first: npx wrangler login");
  process.exit(1);
}

try {
  wrangler(["queues", "create", "penguin-issues-events"]);
  step("created the penguin-issues-events queue");
} catch (error) {
  if (!/already (exists|taken)/iu.test(`${error.stdout}${error.stderr}`)) throw error;
  step("penguin-issues-events queue already exists");
}

const configDir = join(homedir(), ".config", "penguin");
const tokenFile = join(configDir, "deployer-token");
mkdirSync(configDir, { recursive: true, mode: 0o700 });
if (!existsSync(tokenFile)) {
  writeFileSync(tokenFile, Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("hex"), { mode: 0o600 });
}
const deployerToken = readFileSync(tokenFile, "utf8").trim();

let secrets = [];
try {
  secrets = JSON.parse(wrangler(["secret", "list"])).map((each) => each.name);
} catch {
  // A Worker that was never deployed has no secrets to list yet.
}
if (!secrets.includes("PENGUIN_DEPLOYER_TOKEN")) {
  wrangler(["secret", "put", "PENGUIN_DEPLOYER_TOKEN"], { input: deployerToken });
  step("set PENGUIN_DEPLOYER_TOKEN");
}
if (!secrets.includes("PENGUIN_OP_SIGNING_KEY")) {
  const pair = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  wrangler(["secret", "put", "PENGUIN_OP_SIGNING_KEY"], { input: JSON.stringify(jwk) });
  step("set PENGUIN_OP_SIGNING_KEY");
}

const deployed = wrangler(["deploy"]);
const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/u.exec(deployed)?.[0];
if (url === undefined) {
  console.error(deployed);
  throw new Error("wrangler deploy printed no workers.dev URL");
}
step(`deployed ${url}`);

const deployer = (path, body) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${deployerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
for (let attempt = 1; ; attempt += 1) {
  const answer = await deployer("/setup", { owners: [owner] });
  const report = answer.status === 200 ? await answer.json() : undefined;
  if (report?.complete) break;
  if (attempt === 5) throw new Error(`/setup is not complete: HTTP ${answer.status} ${JSON.stringify(report ?? (await answer.text()))}`);
  await new Promise((done) => setTimeout(done, 3000));
}
step(`project set up for ${owner}`);

const issued = await deployer("/mcp/tokens", { owner });
if (issued.status !== 201) throw new Error(`/mcp/tokens answered HTTP ${issued.status}`);
const { token } = await issued.json();

console.log(`
Connect your coding agent to Penguin as ${owner}:

  claude mcp add --transport http penguin ${url}/mcp --header "Authorization: Bearer ${token}"

  Codex: export PENGUIN_TOKEN=${token}
         codex mcp add penguin --url ${url}/mcp --bearer-token-env-var PENGUIN_TOKEN
`);
