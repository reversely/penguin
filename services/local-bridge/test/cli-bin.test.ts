import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, constants, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function binTarget(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  const target = manifest.bin?.["penguin-bridge"];
  assert.ok(target, "package.json names a penguin-bridge bin");
  return join(PACKAGE_DIR, target);
}

test("the penguin-bridge bin is an executable Node script", async () => {
  const target = await binTarget();
  assert.equal(target, join(PACKAGE_DIR, "src", "cli.ts"));
  assert.match(await readFile(target, "utf8"), /^#!\/usr\/bin\/env node\n/);
  await access(target, constants.X_OK);
});

test("the bin runs through a symlink, as npm installs it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "penguin-bin-"));
  try {
    const link = join(dir, "penguin-bridge");
    await symlink(await binTarget(), link);
    // No command prints the usage and exits 2; an unrecognised main check would print nothing and exit 0.
    const run = promisify(execFile)(link, [], { env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    const error = await run.then(
      () => assert.fail("penguin-bridge with no command exits 2"),
      (failure: { code: number; stdout: string }) => failure,
    );
    assert.equal(error.code, 2);
    assert.match(error.stdout, /^Usage: penguin-bridge register/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
