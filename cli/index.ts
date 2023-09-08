#!/usr/bin/env node
import * as http from "http";
import { https } from "follow-redirects";
import * as path from "path";
import * as fs from "fs/promises";
import * as tar from "tar";
import { exists, isTsNode } from "../util";
import { spawnSync } from "child_process";

const nodeModulesDir = path.dirname(path.dirname(path.dirname(__dirname)));
const hiddenDir = path.join(nodeModulesDir, ".ngrpc");
const cmdPath = path.join(hiddenDir, process.platform === "win32" ? "ngrpc.exe" : "ngrpc");
let zipName: string | undefined;

if (process.platform === "darwin") {
    if (process.arch === "arm64") {
        zipName = `ngrpc-mac-arm64.tgz`;
    } else if (process.arch === "x64") {
        zipName = "ngrpc-mac-amd64.tgz";
    }
} else if (process.platform === "linux") {
    if (process.arch === "arm64") {
        zipName = `ngrpc-linux-arm64.tgz`;
    } else if (process.arch === "x64") {
        zipName = "ngrpc-linux-amd64.tgz";
    }
} else if (process.platform === "win32") {
    if (process.arch === "arm64") {
        zipName = `ngrpc-windows-arm64.tgz`;
    } else if (process.arch === "x64") {
        zipName = "ngrpc-windows-amd64.tgz";
    }
}

async function ensureDir(dir: string) {
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch { }
}

function reportImportFailure(err?: Error) {
    if (err) {
        console.error(err);
        console.error("");
    }

    console.error("cannot import ngrpc executable, try install it via:");
    console.error("    go install github.com/ayonli/ngrpc/cli/ngrpc@latest");
    process.exit(1);
}

(async function main() {
    if (!(await exists(cmdPath))) {
        if (!zipName) {
            reportImportFailure();
        }

        await ensureDir(hiddenDir);
        const pkg = isTsNode ? await import("../package.json") : require("../../package.json");
        const url = `https://github.com/ayonli/ngrpc/releases/download/v${pkg.version}/${zipName}`;
        const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
            https.get(url, res => {
                resolve(res);
            }).once("error", reject);
        });

        if (res.statusCode !== 200) {
            reportImportFailure(new Error(`unable to download ${zipName}`));
        }

        await new Promise<void>((resolve, reject) => {
            const out = tar.extract({ cwd: hiddenDir });
            const handleError = async (err: Error) => {
                try { await fs.unlink(cmdPath); } catch { }
                reject(err);
            };

            res.pipe(out);
            res.on("error", handleError);
            out.on("error", handleError).on("finish", resolve);
        });

        spawnSync(cmdPath, process.argv.slice(2), { stdio: "inherit" });
    } else {
        spawnSync(cmdPath, process.argv.slice(2), { stdio: "inherit" });
    }
})().catch(err => {
    reportImportFailure(err);
});
