/// <reference path="./services/ExampleService.ts" />
import { test } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import _try from "dotry";
import ngrpc, { RpcApp } from "./app";
import { spawnSync } from "child_process";
import sleep from "@hyurl/utils/sleep";

test("ngrpc.loadConfig", async () => {
    const config = await ngrpc.loadConfig();
    assert.ok(config.apps.length > 0);
});

test("ngrpc.localConfig with local config file", async () => {
    await fs.copyFile("ngrpc.json", "ngrpc.local.json");
    const [err, config] = await _try(ngrpc.loadConfig());
    await fs.unlink("ngrpc.local.json");

    assert.ok(!err);
    assert.ok(config.apps.length > 0);
});

test("ngrpc.loadConfig with failure", async () => {
    await fs.rename("ngrpc.json", "ngrpc.jsonc");
    const [err, config] = await _try(ngrpc.loadConfig());
    await fs.rename("ngrpc.jsonc", "ngrpc.json");

    const filename = path.join(process.cwd(), "ngrpc.json");
    assert.strictEqual(err.message, `unable to load config file: ${filename}`);
    assert.ok(!config);
});

test("ngrpc.loadConfigForPM2", async () => {
    const cfg = await ngrpc.loadConfig();
    const pm2Cfg = ngrpc.loadConfigForPM2();

    assert.ok(pm2Cfg.apps.length > 0);

    for (const pm2App of pm2Cfg.apps) {
        if (!pm2App.script) {
            throw new Error("the app's script cannot be empty");
        }

        const ext = path.extname(pm2App.script);
        const app = cfg.apps.find(item => item.name === pm2App.name);

        if (!app) {
            throw new Error(`app [${pm2App.name}] is not found`);
        }

        if (app.name.includes(" ")) {
            assert.strictEqual(pm2App.args, `"${app.name}"`);
        } else {
            assert.strictEqual(pm2App.args, app.name);
        }

        assert.deepStrictEqual(pm2App.env ?? {}, app.env ?? {});

        if (app.stdout && app.stderr) {
            assert.strictEqual(pm2App.out_file, app.stdout);
            assert.strictEqual(pm2App.err_file, app.stderr);
        } else if (app.stdout && !app.stderr) {
            assert.strictEqual(pm2App.log_file, app.stdout);
        }

        if (ext === ".js") {
            assert.strictEqual(pm2App.interpreter_args, "-r source-map-support/register");
        } else if (ext === ".ts") {
            assert.strictEqual(pm2App.interpreter_args, "-r ts-node/register");
        } else if (ext === ".go") {
            assert.strictEqual(pm2App.interpreter, "go");
            assert.strictEqual(pm2App.interpreter_args, "run");
        } else if (ext === ".exe" || !ext) {
            assert.strictEqual(pm2App.interpreter, "none");
        } else {
            throw new Error(`entry file '${app.entry}' of app [${app.name}] is recognized`);
        }
    }
});

test("ngrpc.start", async () => {
    let app: RpcApp | undefined;

    try {
        app = await ngrpc.start("example-server");
        assert.strictEqual(app.name, "example-server");

        const reply = await services.ExampleService.sayHello({ name: "World" });
        assert.strictEqual(reply.message, "Hello, World");
        await app.stop();
    } catch (err) {
        await app?.stop();
        throw err;
    }
});

test("ngrpc.start without app name", async function () {
    this.timeout(5_000);

    spawnSync("ngrpc", ["start", "example-server"], { encoding: "utf8" });
    let app: RpcApp | undefined;

    try {
        app = await ngrpc.start();

        const reply = await services.ExampleService.sayHello({ name: "World" });
        assert.strictEqual(reply.message, "Hello, World");

        await app.stop();
        spawnSync("ngrpc", ["stop"]);
        await sleep(1_000); // Host.Stop waited a while for message flushing, we wait here too
    } catch (err) {
        await app?.stop();
        spawnSync("ngrpc", ["stop"]);
        await sleep(1_000);
        throw err;
    }
});


test("ngrpc.startWithConfig", async () => {
    const cfg = await ngrpc.loadConfig();
    const cfgApp = cfg.apps.find(item => item.name === "example-server");

    if (!cfgApp) {
        throw new Error("app [example-server] not found");
    }

    cfgApp.entry = "entry/main.ts";
    let app: RpcApp | undefined;

    try {
        app = await ngrpc.startWithConfig("example-server", cfg);
        assert.strictEqual(app.name, "example-server");

        const reply = await services.ExampleService.sayHello({ name: "World" });
        assert.strictEqual(reply.message, "Hello, World");
        await app.stop();
    } catch (err) {
        await app?.stop();
        throw err;
    }
});

test("ngrpc.startWithConfig with xds protocol", async () => {
    const cfg = await ngrpc.loadConfig();
    const cfgApp = cfg.apps.find(item => item.name === "example-server");

    if (!cfgApp) {
        throw new Error("app [example-server] not found");
    }

    cfgApp.entry = "entry/main.ts";
    cfgApp.uri = "xds:localhost:4000";

    const [err, app] = await _try(ngrpc.startWithConfig("example-server", cfg));

    assert.ok(err.message.includes("'xds:' protocol is used in app"));
    assert.ok(!app);
});

test("ngrpc.getServiceClient", async () => {
    let app: RpcApp | undefined;

    try {
        app = await ngrpc.start("post-server");

        const ins1 = ngrpc.getServiceClient("services.PostService");
        const ins2 = ngrpc.getServiceClient("services.PostService", "post-server");
        const ins3 = ngrpc.getServiceClient("services.PostService", "grpcs://localhost:4002");

        assert.ok(!!ins1);
        assert.ok(!!ins2);
        assert.ok(!!ins3);

        await app.stop();
    } catch (err) {
        await app?.stop();
        throw err;
    }
});

test("ngrpc.runSnippet", async function () {
    this.timeout(5_000);

    spawnSync("ngrpc", ["start", "example-server"], { encoding: "utf8" });
    let message: string | undefined;

    try {
        await ngrpc.runSnippet(async () => {
            const reply = await services.ExampleService.sayHello({ name: "World" });
            message = reply.message;
        });

        assert.strictEqual(message, "Hello, World");
        spawnSync("ngrpc", ["stop"]);
        await sleep(1_000); // Host.Stop waited a while for message flushing, we wait here too
    } catch (err) {
        spawnSync("ngrpc", ["stop"]);
        await sleep(1_000);
        throw err;
    }
});

test("app.stop and app.onStop", async () => {
    let app: RpcApp | undefined;

    try {
        app = await ngrpc.start("example-server");
        let stopped = false;

        app.onStop(() => {
            stopped = true;
        });

        await app.stop();

        assert.ok(stopped);
    } catch (err) {
        await app?.stop();
        throw err;
    }
});

test("app.reload and app.onReload", async () => {
    let app: RpcApp | undefined;

    try {
        app = await ngrpc.start("example-server");
        let reloaded = false;

        app.onReload(() => {
            reloaded = true;
        });

        await app.reload();

        assert.ok(reloaded);

        app.stop();
    } catch (err) {
        await app?.stop();
        throw err;
    }
});
