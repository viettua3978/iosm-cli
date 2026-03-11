#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

function runCapture(command, args) {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function run(command, args) {
	execFileSync(command, args, { stdio: "inherit" });
}

const iosmBinPath = runCapture("volta", ["which", "iosm"]);
const packageRoot = iosmBinPath.endsWith("/bin/iosm")
	? `${iosmBinPath.slice(0, -"/bin/iosm".length)}/lib/node_modules/iosm-cli`
	: join(dirname(iosmBinPath), "..", "lib", "node_modules", "iosm-cli");

if (!existsSync(packageRoot)) {
	throw new Error(`Cannot resolve global iosm-cli package directory: ${packageRoot}`);
}

run("rsync", ["-a", "--delete", "dist/", `${join(packageRoot, "dist")}/`]);
run("rsync", ["-a", "--delete", "docs/", `${join(packageRoot, "docs")}/`]);
run("rsync", ["-a", "--delete", "examples/", `${join(packageRoot, "examples")}/`]);

copyFileSync("package.json", join(packageRoot, "package.json"));
copyFileSync("README.md", join(packageRoot, "README.md"));
copyFileSync("CHANGELOG.md", join(packageRoot, "CHANGELOG.md"));

console.log(`Local deploy completed: ${packageRoot}`);
