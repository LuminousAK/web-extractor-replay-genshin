const fs = require("fs");
const path = require("path");
const express = require("express");
const { spawn } = require("child_process");
const { Command } = require("commander");
const Proxy = require("http-mitm-proxy").Proxy;


// 命令行参数解析
const program = new Command();
program
    .description("Run a local proxy server with HAR resource mapping")
    .requiredOption("-d, --project-dir <path>", "项目目录")
    .option("-c, --config <path>", "配置文件路径", "config.json")
    .option("-k, --no-ignore-cert-errors", "启动浏览器时，不忽略证书错误。默认忽略。（注意!该选项可能导致浏览器无法连接代理。）")
program.parse(process.argv);
const options = program.opts();

// 读取配置文件
let config = {}
if (fs.existsSync(options.config)) {
    config = JSON.parse(fs.readFileSync(options.config, "utf-8"));
}

const PROXY_PORT = config.server.proxyPort || 3000;
const WEB_PORT = config.server.webPort || 3001;
const projectDir = options.projectDir;

const BROWSER_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

const autoLaunch = config.browser.autoLaunch;
const executablePath = config.browser.executablePath;

let shouldIgnoreCertErrors;
// 命令行优先级更高
if (options.ignoreCertErrors === false) {
    shouldIgnoreCertErrors = false;
    console.info("ℹ️ 根据命令行参数，浏览器将校验 SSL 证书。")
} else {
    // 配置文件
    shouldIgnoreCertErrors = config.browser?.ignoreCertificateErrors ?? true;
}

// 读取映射表
const mappingPath = path.join(projectDir, "url_mapping.json");
if (!fs.existsSync(mappingPath)) {
  console.error("❌ 找不到映射文件 url_mapping.json，请先运行 Python HAR 下载脚本！");
  process.exit(1);
}
const mapping_json = JSON.parse(fs.readFileSync(mappingPath, "utf-8"));
const urlMapping = mapping_json.url_mapping;
const entryPoint = mapping_json.entry_point;

// ==========================================================
// 创建并配置 MITM 代理服务器
// ==========================================================
const proxy = new Proxy();

proxy.sslCaDir = config.server.sslCaDir;
proxy.sslCaKeyFile = path.join(proxy.sslCaDir, "ca.key");
proxy.sslCaCertFile = path.join(proxy.sslCaDir, "ca.crt");

const spoofHeaders = config.proxyRules.spoofHeaders

proxy.onError((ctx, err) =>{
    console.error("⚠️ 代理出错:", err);
});

//拦截HTTP/HTTPS请求
proxy.onRequest((ctx, callback)=> {
    console.log('------------------------------------------------');
    const fullUrl = ctx.isSSL
        ? `https://${ctx.clientToProxyRequest.headers.host}${ctx.clientToProxyRequest.url}`
        : `http://${ctx.clientToProxyRequest.headers.host}${ctx.clientToProxyRequest.url}`;

    console.log(`📡 请求: ${fullUrl}`);

    if (urlMapping[fullUrl]) {
        // 命中本地资源
        const localFilePath = path.join(projectDir, urlMapping[fullUrl]);
        if (fs.existsSync(localFilePath)) {
            console.log(`✅ 本地命中: ${fullUrl}`);
            const fileStream = fs.createReadStream(localFilePath);

            const headers = {
                "Access-Control-Allow-Credentials": "true",
                'Access-Control-Allow-Origin': ctx.clientToProxyRequest.headers["origin"] || "*",
                // 'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': '*',
            };

            ctx.proxyToClientResponse.writeHead(200, headers);
            fileStream.pipe(ctx.proxyToClientResponse);
            return;
        }
    }

    // 未命中，如果是需要回源到指定域名下的请求，就伪装它的 Origin 和 Referer
    if (!urlMapping[fullUrl] && spoofHeaders.enabled){
        const shouldSpoof = spoofHeaders.targetDomains.some(domain => fullUrl.includes(domain));
        if (shouldSpoof){
            // 修改 Origin 和 Referer 头，让服务器以为是合法来源
            let fakeOrigin;
            if (spoofHeaders.fakeOrigin === "auto"){
                fakeOrigin = entryPoint.origin;
            }
            else{
                fakeOrigin = spoofHeaders.fakeOrigin;
            }
            ctx.clientToProxyRequest.headers['origin'] = fakeOrigin;
            ctx.clientToProxyRequest.headers['referer'] = `${fakeOrigin}/`;
        }
    }

    // 未命中 → 回源
    console.log(`🌐 回源: ${fullUrl}`);
    return callback();
});

// 拦截服务器响应，并添加 CORS 头
proxy.onResponse((ctx, callback) => {

    if (ctx.serverToProxyResponse) {
        const headers = ctx.serverToProxyResponse.headers;

        // 以不区分大小写的方式，寻找并删除任何形式的 'Access-Control-Allow-Origin'以及其他字段
        const corsHeadersToOverwrite = [
            'access-control-allow-origin',
            'access-control-allow-credentials'
        ];

        for (const headerToOverwrite of corsHeadersToOverwrite){
            const headerKeyToDelete = Object.keys(headers).find(
                key => key.toLowerCase() === headerToOverwrite
            )
            if (headerKeyToDelete) {
                delete headers[headerKeyToDelete]
            }
        }

        // 设置 CORS 相关的头部
        headers['Access-Control-Allow-Origin'] = BROWSER_ORIGIN;
        headers['Access-Control-Allow-Credentials'] = 'true';
        // headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        headers['Access-Control-Allow-Headers'] = '*';
    }

    return callback();
});

// ==========================================================
// 创建并配置 Express Web 服务器
// ==========================================================
const app = express();
app.use(express.static(projectDir));

// ==========================================================
// 启动所有服务和浏览器
// ==========================================================
function launchBrowser(){
    if (!autoLaunch){
        console.info("ℹ️ 自动启动浏览器已禁用。请手动配置代理并打开网页。");
        return;
    }

    if (!executablePath || !fs.existsSync(executablePath)){
        console.warn(`⚠️ 浏览器路径未配置或无效: "${executablePath}"`);
        console.warn("   请在 config.json 中设置正确的 browser.executablePath，或禁用 autoLaunch。");
        return;
    }

    console.log("📂 即将启动独立 Edge 浏览器...");

    const tempProfileDir = path.join(__dirname, "edge-temp-profile");

    // 创建临时配置目录（如果不存在）
    if (!fs.existsSync(tempProfileDir)) {
        fs.mkdirSync(tempProfileDir);
    }

    const entryPointFile = entryPoint.local_file;
    const startUrl = `${BROWSER_ORIGIN}/${entryPointFile}`;

    const browserArgs = [
        `--user-data-dir=${tempProfileDir}`,
        `--proxy-server=127.0.0.1:${PROXY_PORT}`,
        // "--ignore-certificate-errors",
        "--no-first-run",
        "--no-default-browser-check",
    ];
    if (shouldIgnoreCertErrors) {
        browserArgs.push("--ignore-certificate-errors");
        console.info("ℹ️ 浏览器将忽略 SSL 证书错误。");
    }
    browserArgs.push(startUrl);

    spawn(executablePath, browserArgs, { detached: true, stdio: "ignore" });
}
proxy.listen({port: PROXY_PORT, host: '127.0.0.1'}, () => {
    console.log(`🚀 MITM 代理启动中: http://127.0.0.1:${PROXY_PORT}`);

    app.listen(WEB_PORT, () => {
        console.log(`🚀 本地 Web 服务器启动于: ${BROWSER_ORIGIN}`);
        console.log(`📂 项目 "${projectDir}" 的内容已托管。`);

        launchBrowser();
    });
});
