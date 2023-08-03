import * as fs from "fs";
import * as path from "path";
import * as FRON from "fron";
import { Options as ProtoOptions, loadSync } from "@grpc/proto-loader";
import {
    ChannelCredentials,
    ChannelOptions,
    GrpcObject,
    Server,
    ServerCredentials,
    ServiceClientConstructor,
    connectivityState,
    credentials,
    loadPackageDefinition
} from "@grpc/grpc-js";
import { serve, unserve, connect, LoadBalancer, ConnectionManager, ServerConfig } from "@hyurl/grpc-async";
import get = require("lodash/get");
import isEqual = require("lodash/isEqual");
import hash = require("string-hash");
import * as net from "net";
import isSocketResetError = require("is-socket-reset-error");
import { absPath, ensureDir } from "./util";
import { findDependencies } from "require-chain";

/** These type represents the structures and properties set in the config file. */
export type Config = {
    $schema?: string;
    package: string;
    protoDirs: string[];
    protoOptions: ProtoOptions,
    apps: {
        name: string;
        uri: string;
        serve?: boolean;
        services: string[];
        cert?: string;
        key?: string;
        connectTimeout?: number;
        options?: ChannelOptions;
    }[];
    sockFile?: string;
};

/**
 * This type represents an interface that supports lifecycle events on the gRPC
 * app. If a service implements this interface, when the app starts and the
 * service is loaded (or reloaded), the `init()` method will be automatically
 * called, we can add some async logic inside it, for example, establishing
 * database connection, which is normally not possible in the default
 * `constructor()` method since it doesn't support asynchronous codes. And when
 * the app is about to stop, or the service is about to be reloaded, the
 * `destroy()` method will be called, which gives the ability to clean up and
 * release resource.
 */
export interface LifecycleSupportInterface {
    init(): Promise<void>;
    destroy(): Promise<void>;
}

/**
 * This type represents a struct of message that contains a `route` key that can
 * be used in the internal client load balancer. When the client sending a
 * request which implements this interface, the program will automatically route
 * the traffic to a certain server evaluated by the `route` key, which can be
 * set in the following forms:
 * 
 * - a URI or address that corresponds to the ones that set in the config file;
 * - an app's name that corresponds to the ones that set in the config file;
 * - if none of the above matches, use the hash algorithm on the `route` value;
 * - if `route` value is set, then the default round-robin algorithm is used for
 *      routing.
 */
export interface RoutableMessageStruct {
    route: string;
}

/**
 * The very gRPC app constructor of the gRPC Boot package.
 */
export class App {
    protected conf: Config = null;
    protected oldConf: Config = null;
    protected pkgDef: GrpcObject;
    protected server: Server;
    protected manager: ConnectionManager;
    protected serverName: string;
    protected serverRegistry = new Map<string, { ctor: ServiceClientConstructor, ins: any; }>();
    protected sslOptions: { cert: Buffer, key: Buffer; } = null;
    protected serverOptions: ChannelOptions = null;
    protected rootNsp: string;
    protected clientRegistry = new Map<string, Config["apps"]>();

    // The Host-Guest model is a mechanism used to hold communication between
    // all apps running on the same machine.
    //
    // When a app starts, regarding serves as a server or just pure clients, it
    // joins the party and tries to gain the host-ship. If succeeds, it becomes
    // the host app and others become guests. The host app starts a guest client
    // that connects to itself as well. Through the host app, guests can talk to
    // each other.
    //
    // This mechanism is primarily used for the CLI tool sending control
    // commands to the apps. When the CLI tool starts, it becomes one of the
    // member of the party (it starts a pure clients app), and use this 
    // communication channel to send commands like `reload` and `stop` to other
    // apps.
    protected host: net.Server = null;
    protected hostClients: { socket: net.Socket, app?: string; }[] = [];
    protected hostCallbacks = new Map<string, (result: any) => void>();
    protected guest: net.Socket = null;

    protected isStopped = false;
    protected _onReload: () => void = null;
    protected _onStop: () => void = null;

    constructor(protected config: string = "") {
        this.conf = App.loadConfig(config);
    }

    protected static loadConfig(config: string = "") {
        config = absPath(config || "boot.config.json");
        const fileContent = fs.readFileSync(config, "utf8");
        const conf: Config = FRON.parse(fileContent, config);

        if (conf.protoOptions) {
            // In the config file, we set the following properties in string
            // format, whereas they needs to be the corresponding constructor,
            // so we convert them before using them.
            if ((conf.protoOptions.longs as any) === "String") {
                conf.protoOptions.longs = String;
            } else if ((conf.protoOptions.longs as any) === "Number") {
                conf.protoOptions.longs = Number;
            }

            if ((conf.protoOptions.enums as any) === "String") {
                conf.protoOptions.enums = String;
            }

            if ((conf.protoOptions.bytes as any) === "Array") {
                conf.protoOptions.bytes = Array;
            } else if ((conf.protoOptions.bytes as any) === "String") {
                conf.protoOptions.bytes = String;
            }
        }

        return conf;
    }

    protected async loadProtoFiles(dirs: string[], options: ProtoOptions, reload = false) {
        if (!reload && this.pkgDef)
            return;

        // recursively scan for `.proto` files
        const filenames: string[] = await (async function scan(dirs: string[]) {
            const filenames: string[] = [];

            for (const dir of dirs) {
                const files = await fs.promises.readdir(dir);
                const subDirs: string[] = [];

                for (const file of files) {
                    const filename = path.join(dir, file);
                    const stat = await fs.promises.stat(filename);

                    if (stat.isFile() && file.endsWith(".proto")) {
                        filenames.push(filename);
                    } else if (stat.isDirectory()) {
                        subDirs.push(filename);
                    }
                }

                if (subDirs.length) {
                    filenames.push(...await scan(subDirs));
                }
            }

            return filenames;
        })(dirs);

        // `load()` method is currently buggy, so we use `loadSync()` instead.
        this.pkgDef = loadPackageDefinition(loadSync(filenames, options));
    }

    protected async initServer(appName: string, reload = false) {
        const app = this.conf.apps.find(app => app.name === appName);

        if (!app) {
            throw new Error(`gRPC app [${appName}] doesn't exist in the config file`);
        } else if (!app.serve) {
            throw new Error(`gRPC app [${appName}] is not intended to be served`);
        }

        const { protocol, hostname, port } = new URL(app.uri);
        let address = hostname;
        let newServer = !this.server;
        let useSSL = false;
        let cert: Buffer;
        let key: Buffer;

        if (protocol === "xds:") {
            throw new Error(`gRPC app [${app.name}] cannot be served since it uses 'xds:' protocol`);
        } else if (protocol === "grpcs:" || protocol === "https:") {
            if (!app.cert) {
                throw new Error(`Missing 'cert' config for app [${app.name}]`);
            } else if (!app.key) {
                throw new Error(`Missing 'key' config for app [${app.name}]`);
            } else if (!port) {
                address += ":443";
            }

            useSSL = true;
        } else if ((protocol === "grpc:" || protocol === "http:") && !port) {
            address += ":80";
        } else if (port) {
            address += ":" + port;
        }

        if (reload) {
            if (this.sslOptions) {
                if (!useSSL) { // SSL to non-SSL
                    this.sslOptions = null;
                    newServer = true;
                } else {
                    cert = await fs.promises.readFile(app.cert);
                    key = await fs.promises.readFile(app.key);

                    if (Buffer.compare(cert, this.sslOptions.cert) ||
                        Buffer.compare(key, this.sslOptions.key)
                    ) {
                        // SSL credentials changed
                        this.sslOptions = { cert, key };
                        newServer = true;
                    }
                }
            } else if (useSSL) { // non-SSL to SSL
                cert = await fs.promises.readFile(app.cert);
                key = await fs.promises.readFile(app.key);
                this.sslOptions = { cert, key };
                newServer = true;
            }

            if (this.oldConf) {
                const oldApp = this.oldConf.apps.find(app => app.name === appName);

                if (!oldApp || oldApp.uri !== app.uri || !isEqual(oldApp.options, app.options)) {
                    // server configurations changed
                    newServer = true;
                }
            }
        }

        if (reload && this.server) {
            // Unserve old service instance and possibly call the `destroy()`
            // lifecycle method.
            // 
            // This part of code resides here instead of inside the `_reload()`
            // method is because if there is something wrong with the
            // configuration and we fail to reload the app, the old service
            // instances can still work.
            for (const [_, { ctor, ins }] of this.serverRegistry) {
                if (typeof ins.destroy === "function") {
                    await (ins as LifecycleSupportInterface).destroy();
                }

                unserve(this.server, ctor);
            }

            // Remove cached files and their dependencies so, when reloading,
            // they could be reimported and use any changes inside them.
            const filenames = [...this.serverRegistry.keys()].map(serviceName => {
                return path.join(process.cwd(), serviceName.split(".").join(path.sep));
            });
            const dependencies = findDependencies(filenames);

            [...filenames, ...dependencies].forEach(filename => {
                delete require.cache[filename];
            });
        }

        if (newServer || !this.server) {
            await this.loadProtoFiles(this.conf.protoDirs, this.conf.protoOptions);
            this.server?.forceShutdown();
            this.server = new Server(app.options);
            this.serverName = app.name;
        }

        for (const serviceName of app.services) {
            const filename = path.join(process.cwd(), serviceName.split(".").join(path.sep));
            const exports = await import(filename);
            let ctor: (new () => any) & { getInstance(): any; };
            let ins: any;

            // The service class file must be implemented as a module that has a
            // default export which is the very service class itself.
            if (typeof exports.default === "function") {
                ctor = exports.default;
            } else {
                console.error(`service '${serviceName}' is not correctly implemented`);
                continue;
            }

            if (typeof ctor.getInstance === "function") {
                // Support explicit singleton designed, in case the service
                // should used in another place without RPC tunneling.
                ins = ctor.getInstance();
            } else {
                ins = new ctor();
            }

            const protoCtor = get(this.pkgDef as object, serviceName);
            serve(this.server, protoCtor, ins);
            this.serverRegistry.set(serviceName, { ctor: protoCtor, ins });
        }

        if (newServer) {
            await new Promise<void>(async (resolve, reject) => {
                let cred: ServerCredentials;

                // Create different knd of server credentials according to
                // whether the `cert` and `key` are set.
                if (cert && key) {
                    cred = ServerCredentials.createSsl(cert, [{
                        private_key: key,
                        cert_chain: cert,
                    }], true);
                } else {
                    cred = ServerCredentials.createInsecure();
                }

                this.server.bindAsync(address, cred, (err) => {
                    this.server.start();

                    if (err) {
                        reject(err);
                    } else {
                        console.info(`gRPC app [${app.name}] started at '${app.uri}'`);
                        resolve();
                    }
                });
            });
        }
    }

    protected async initClients(reload = false) {
        await this.loadProtoFiles(this.conf.protoDirs, this.conf.protoOptions);

        this.manager ||= new ConnectionManager();
        const rootNsp = this.conf.package;
        // @ts-ignore
        global[rootNsp] ||= this.manager.useChainingSyntax(rootNsp);

        const certs = new Map<string, Buffer>();
        const keys = new Map<string, Buffer>();

        // Preload `cert`s and `key`s so in the "connection" phase, there would
        // be no latency for loading resources asynchronously.
        for (const app of this.conf.apps) {
            if (app.cert) {
                const filename = absPath(app.cert);
                const cert = await fs.promises.readFile(filename);
                certs.set(filename, cert);
            }

            if (app.key) {
                const filename = absPath(app.key);
                const key = await fs.promises.readFile(filename);
                keys.set(filename, key);
            }
        }

        // Reorganize client-side configuration based on the service name since
        // the gRPC clients are created based on the service.
        const clientRegistry = this.conf.apps.reduce((registry, app) => {
            for (const serviceName of app.services) {
                const apps = registry.get(serviceName);

                if (apps) {
                    apps.push(app);
                } else {
                    registry.set(serviceName, [app]);
                }
            }

            return registry;
        }, new Map<string, Config["apps"]>());

        if (reload) {
            this.clientRegistry.forEach((_, serviceName) => {
                if (!clientRegistry.has(serviceName)) {
                    // Remove redundant service client or load balancer.
                    this.manager.deregister(serviceName, true);
                }
            });
        }

        const getAddress = (app: Config["apps"][0]) => {
            const { protocol, hostname, port } = new URL(app.uri);
            let address = hostname;

            if (protocol === "xds:") {
                address = app.uri;
            } else if (protocol === "grpcs:" || protocol === "https:") {
                if (!app.cert) {
                    throw new Error(`Missing 'cert' config for app [${app.name}]`);
                } else if (!app.key) {
                    throw new Error(`Missing 'key' config for app [${app.name}]`);
                } else if (!port) {
                    address += ":443";
                }
            } else if ((protocol === "grpc:" || protocol === "http:") && !port) {
                address += ":80";
            } else if (port) {
                address += ":" + port;
            }

            return address;
        };
        const getConnectConfig = (app: Config["apps"][0]) => {
            const address = getAddress(app);
            let cred: ChannelCredentials;

            if (app.uri.startsWith("grpcs:") || app.uri.startsWith("https:")) {
                const cert = certs.get(absPath(app.cert));
                const key = keys.get(absPath(app.key));
                cred = credentials.createSsl(cert, key, cert);
            } else {
                cred = credentials.createInsecure();
            }

            return { address, credentials: cred };
        };

        clientRegistry.forEach((apps, serviceName) => {
            if (reload && this.clientRegistry.has(serviceName)) {
                // Remove old service client or load balancer.
                // 
                // We remove the connection just before it is reloaded, so that
                // if for some reason we fail to reload it, that old connection
                // can still be available.
                // 
                // Unlike the server-side, client-side doesn't have lifecycle
                // logic and the connection doesn't happen immediately, and we
                // preloaded the `cert`s and `key`s, so there would be no real
                // delay for re-register.
                this.manager.deregister(serviceName, true);
            }

            if (apps.length === 1) {
                const [app] = apps;
                const { address, credentials: cred } = getConnectConfig(app);

                const client = connect(get(this.pkgDef as object, serviceName), address, cred, {
                    ...(app.options ?? null),
                    connectTimeout: app.connectTimeout || 120_000,
                });

                this.manager.register(client);
            } else {
                // If there are multiple apps that serve the same service, use
                // the client-side load-balancer to hold the connections.
                const servers: ServerConfig[] = apps.map(app => {
                    const { address, credentials: cred } = getConnectConfig(app);
                    return {
                        address,
                        credentials: cred,
                        options: {
                            ...(app.options ?? null),
                            connectTimeout: app.connectTimeout || 120_000,
                        },
                    } satisfies ServerConfig;
                });
                const balancer = new LoadBalancer(
                    get(this.pkgDef as object, serviceName),
                    servers,
                    (ctx) => {
                        const addresses: string[] = ctx.servers
                            .filter(item => item.state !== connectivityState.SHUTDOWN)
                            .map(item => item.address);
                        let route: string;

                        if (typeof ctx.params === "string") {
                            route = ctx.params;
                        } else if (ctx.params &&
                            typeof ctx.params === "object" &&
                            !Array.isArray(ctx.params) &&
                            typeof ctx.params.route === "string"
                        ) {
                            route = ctx.params.route;
                        }

                        if (route) {
                            if (addresses.includes(route)) {
                                return route; // explicitly use a server instance
                            } else {
                                const app = apps.find(
                                    app => app.name === route || app.uri === route
                                );

                                if (app) {
                                    const address = getAddress(app);

                                    if (addresses.includes(address)) {
                                        return address;
                                    }
                                }
                            }

                            // use hash
                            const id = hash(route);
                            return addresses[id % addresses.length];
                        }

                        // use round-robin
                        return addresses[ctx.acc % addresses.length];
                    }
                );

                this.manager.register(balancer);
            }
        });

        this.clientRegistry = clientRegistry;
    }

    /**
     * Starts the app programmatically.
     * 
     * @param app The app's name that should be started as a server. If not
     *  provided, the app only connects to other servers but not serves as one.
     */
    async start(app = "") {
        if (app) {
            await this.initServer(app);
        }

        await this.initClients();
        await this.tryHost();

        // Only run the lifecycle `init()` functions when all the necessary
        // procedure are done, so that any logic, for example, calling another
        // service's methods in the `init()` method, is valid since the
        // connection has been established.
        for (const [, { ins }] of this.serverRegistry) {
            if (typeof ins.init === "function") {
                await ins.init();
            }
        }
    }

    /** Stops the app programmatically. */
    async stop() {
        return await this._stop();
    }

    protected async _stop(msgId: string = "") {
        for (const [_, { ins }] of this.serverRegistry) {
            if (typeof ins.destroy === "function") {
                await (ins as LifecycleSupportInterface).destroy();
            }
        }

        this.manager?.close();
        this.server?.forceShutdown();
        this.isStopped = true;

        if (msgId) {
            // If `msgId` is provided, that means the stop event is issued by
            // a guest app, for example, the CLI tool, in this case, we need
            // to send feedback to acknowledge the sender that the process has
            // finished.
            let result: string;

            if (this.serverName) {
                result = `gRPC app [${this.serverName}] stopped`;
            } else {
                result = "gRPC clients stopped";
            }

            this.guest?.end(JSON.stringify({
                cmd: "reply",
                msgId: msgId,
                result
            }));

            if (this.host) {
                this.hostClients.forEach(({ socket }) => {
                    if (socket !== this.guest) {
                        socket.end();
                    }
                });
                this.host.close(() => {
                    this._onStop?.();
                });
            } else {
                this._onStop?.();
            }
        } else {
            this.guest?.destroy();
            this._onStop?.();
        }
    }

    /** Reloads the app programmatically. */
    async reload() {
        return await this._reload();
    }

    protected async _reload(msgId: string = "") {
        this.oldConf = this.conf;
        this.conf = App.loadConfig(this.config);

        // Pre-reload `.proto` files so they won't be duplicated reloaded in the
        // `initServer()` or `initClients()` functions.
        await this.loadProtoFiles(this.conf.protoDirs, this.conf.protoOptions, true);

        if (this.server) {
            await this.initServer(this.serverName, true);
        }

        await this.initClients(true);

        // Same as in the `start()` function, we only run the lifecycle `init()`
        // functions when all the necessary procedure are done, so that any
        // logic, for example, calling another service's methods in the `init()`
        // method, is valid since the connection has been established.
        for (const [, { ins }] of this.serverRegistry) {
            if (typeof ins.init === "function") {
                await ins.init();
            }
        }

        if (msgId) {
            // If `msgId` is provided, that means the stop event is issued by
            // a guest app, for example, the CLI tool, in this case, we need
            // to send feedback to acknowledge the sender that the process has
            // finished.
            let result: string;

            if (this.serverName) {
                result = `gRPC app [${this.serverName}] reloaded`;
            } else {
                result = `gRPC clients reloaded`;
            }

            this.guest?.write(JSON.stringify({ cmd: "reply", msgId: msgId, result }));
        }

        this._onReload?.();
    }

    /** Registers a callback to run after the app is reloaded. */
    onReload(callback: () => void) {
        this._onReload = callback;
    }

    /** Registers a callback to run after the app is stopped. */
    onStop(callback: () => void) {
        this._onStop = callback;
    }

    /**
     * Try to make the current app as the host app for communications.
     */
    protected async tryHost() {
        const _sockFile = absPath(this.conf.sockFile || "boot.sock");
        const sockFile = absPath(this.conf.sockFile || "boot.sock", true);

        await ensureDir(path.dirname(_sockFile));

        if (fs.existsSync(_sockFile)) {
            // If the socket file already exists, there either be the host app
            // already exists or the socket file is left there because an
            // unclean shutdown of the previous host app. We need to first try
            // to connect to it, if not succeeded, delete it and try to gain the
            // host-ship.
            try {
                await new Promise<void>((resolve, reject) => {
                    this.tryConnect(sockFile, resolve, reject);
                });
                return;
            } catch {
                fs.unlinkSync(_sockFile);
            }
        }

        await new Promise<void>((resolve, reject) => {
            const host = net.createServer(client => {
                client.setNoDelay(true);
                client.on("data", (buf) => {
                    const json = buf.toString();

                    try {
                        const msg = JSON.parse(json) as {
                            cmd: "connect" | "reload" | "stop" | "reply",
                            app?: string,
                            msgId?: string;
                        };

                        if (msg.cmd === "connect") {
                            // After a guest establish the socket connection, it sends a `connect`
                            // command indicates a signing-in, we then store the client in the
                            // `hostClients` property for broadcast purposes.

                            if (msg.app) {
                                if (!this.conf.apps.some(app => app.name === msg.app)) {
                                    client.destroy(new Error(`Invalid app name '${msg.app}'`));
                                } else if (this.hostClients.some(item => item.app === msg.app)) {
                                    client.destroy(new Error(`gRPC app [${msg}] is already running`));
                                } else {
                                    this.hostClients.push({ socket: client, app: msg.app });
                                }
                            } else {
                                this.hostClients.push({ socket: client });
                            }
                        } else if (msg.cmd === "reload" || msg.cmd == "stop") {
                            // When the host app receives a control command, it distribute the
                            // command to the target app or all apps if the app is not specified.

                            if (msg.app) {
                                const _client = this.hostClients.find(item => item.app === msg.app);

                                if (_client) {
                                    const msgId = Math.random().toString(16).slice(2);

                                    _client.socket.write(JSON.stringify({ cmd: msg.cmd, msgId }));
                                    this.hostCallbacks.set(msgId, (reply) => {
                                        client.end(JSON.stringify(reply));
                                    });
                                } else {
                                    client.destroy(new Error(`gRPC app [${msg.app}] is not running`));
                                }
                            } else {
                                let count = 0;
                                let limit = this.hostClients.length;

                                this.hostClients.forEach(_client => {
                                    const msgId = Math.random().toString(16).slice(2);

                                    _client.socket.write(JSON.stringify({ cmd: msg.cmd, msgId }));
                                    this.hostCallbacks.set(msgId, (reply) => {
                                        client.write(JSON.stringify(reply));

                                        if (++count === limit) {
                                            client.end();
                                        }
                                    });
                                });
                            }
                        } else if (msg.cmd === "reply") {
                            // When a guest app finishes a control command, it send feedback via the
                            // `reply` command, we use the `msgId` to retrieve the callback, run it
                            // and remove it.

                            if (msg.msgId) {
                                const callback = this.hostCallbacks.get(msg.msgId);

                                if (callback) {
                                    callback(msg);
                                    this.hostCallbacks.delete(msg.msgId);
                                }
                            }
                        } else {
                            client.destroy(new Error(`Invalid message: ${json}`));
                        }
                    } catch (err) {
                        client.destroy(new Error(`Invalid message: ${json}`));
                    }
                }).on("close", () => {
                    // Remove the client from the list if it has been stopped.
                    this.hostClients = this.hostClients.filter(item => item.socket !== client);
                });
            });

            host.listen(sockFile, () => {
                this.host = host;

                // Connect to self so that we can use the same control logic.
                this.tryConnect(sockFile, resolve, reject);

                if (this.serverName) {
                    console.info(`gRPC app [${this.serverName}] has become the host server`);
                } else {
                    console.info("This app has become the host server");
                }
            });
        });
    }

    /**
     * Try to connect to the host server of app control.
     * 
     * @param sockFile 
     * @param resolve 
     * @param reject 
     */
    protected tryConnect(sockFile: string, resolve: () => void, reject: (err: Error) => void) {
        const client = net.createConnection(sockFile, () => {
            client.write(JSON.stringify({ cmd: "connect", app: this.serverName }));
            this.guest = client;
            resolve();
        });

        client.setNoDelay(true);
        client.on("data", (buf) => {
            try {
                const msg = JSON.parse(buf.toString()) as {
                    cmd: "reload" | "stop";
                    msgId: string;
                };

                if (msg.cmd === "reload") {
                    this._reload(msg.msgId).catch(console.error);
                } else if (msg.cmd === "stop") {
                    this._stop(msg.msgId).catch(console.error);
                } else {
                    // ignore other messages
                }
            } catch {
                // ignore other messages
            }
        }).on("end", () => {
            if (!this.host && !this.isStopped) {
                // If the connection is closed by the host server and the client is not marked
                // closed, it indicates that the server is closed by a guest app (mainly the CLI
                // tool), the client now is able to retry gaining the host-ship.
                this.tryHost().catch(console.error);
            }
        }).on("error", err => {
            if (isSocketResetError(err) && !this.host && !this.isStopped) {
                // if the connection is interrupted, for example, force terminated by `ctrl + C`,
                // and the client is not marked closed, the client now is able to retry gaining the
                // host-ship.
                this.tryHost().catch(console.error);
            } else {
                reject(err);
            }
        });
    }

    /**
     * Sends control command to the gRPC apps.
     * 
     * @param cmd 
     * @param app The app's name that should received the command. If not provided,
     *  the command is sent to all apps.
     * @param config Use a custom config file.
     */
    static async sendCommand(cmd: "reload" | "stop", app = "", config = "") {
        const conf = this.loadConfig(config);
        const sockFile = absPath(conf.sockFile || "boot.sock", true);

        await new Promise<void>((resolve, reject) => {
            const client = net.createConnection(sockFile, () => {
                client.write(JSON.stringify({ cmd, app }));
            });

            client.setNoDelay(true);
            client.on("data", (buf) => {
                const json = buf.toString();

                try {
                    const reply = JSON.parse(json) as {
                        result?: string;
                        error?: string;
                    };

                    if (reply.error) {
                        console.error(reply.error);
                    } else {
                        console.info(reply.result ?? null);
                    }
                } catch (err) {
                    console.error(err);
                    console.log(json);
                }
            }).on("end", resolve).once("error", reject);
        });
    }

    /**
     * Runs a snippet inside the gRPC apps context.
     * 
     * This function is for temporary scripting usage, it starts a temporary
     * pure-clients app so we can use the services as we normally do in our
     * program, and after the main `fn` function is run, the app is
     * automatically stopped.
     * 
     * @param fn The function needs to be run.
     * @param config Use a custom config file.
     */
    static async runSnippet(fn: () => void | Promise<void>, config: string = void 0) {
        try {
            const app = new App(config);

            await app.start();
            await fn();
            await app.stop();
        } catch (err) {
            console.error(err);
        }
    }
}
