import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
if (!files.length) throw new Error("Stage the explicit release files before auditing.");
const prohibited = /(^|\/)(\.env(\.local)?|\.secrets|node_modules|\.vercel|bin|config\.json)(\/|$)|bridge-config\.js$/;
const secret = /(?:sk-(?:proj-|ant-)[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
for (const file of files) {
  if (prohibited.test(file)) throw new Error(`Private/runtime file staged: ${file}`);
  if (/\.(png|jpg|jpeg|gif|webp|ico)$/i.test(file)) continue;
  const content = await readFile(file, "utf8");
  if (secret.test(content)) throw new Error(`Credential-shaped content in ${file}`);
  if (/C:\\Users\\ASUS|tunnel_[a-f0-9]{12,}/.test(content)) throw new Error(`Personal configuration in ${file}`);
}
console.log(`PASS: ${files.length} staged files; no excluded runtime paths, recognized credentials or personal tunnel configuration.`);
