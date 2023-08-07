import App from "."; // replace `.` with `@hyurl/grpc-boot`

if (require.main?.filename === __filename) {
    const appName = process.argv[2];
    const config = process.argv[3];

    App.boot(appName, config).then(() => {
        process.send("ready");
    }).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
