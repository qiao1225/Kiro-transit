import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root, ".env");
const configFile = path.join(root, "config.json");

const gatewayKey = `kg-${crypto.randomBytes(16).toString("hex")}`;

fs.writeFileSync(envFile, `KIRO_GATEWAY_KEY=${gatewayKey}\n`);

const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
config.kiroGatewayApiKey = gatewayKey;
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

console.log("已生成 Kiro Gateway 内部密钥并写入 .env / config.json");
console.log(`KIRO_GATEWAY_KEY=${gatewayKey}`);