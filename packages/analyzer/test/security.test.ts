import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GrammarId } from "../src/metrics/languages";
import { analyzeCode } from "../src/metrics";
import { parseSource } from "../src/metrics/parser";
import { scanRepository } from "../src/scanner";
import { createSecurityScanner, inspectTree, maskSecret, scanTextForSecrets, SECURITY_RULES } from "../src/security";
import type { SecretScanFile } from "../src/security/secrets";

// Token-shaped values are assembled at runtime so this repository never contains
// strings that secret scanners (including GitHub push protection) treat as real keys.
const rep = (s: string, n: number) => s.repeat(n);
const FAKE = {
  aws: ["AKIA", rep("Q7", 8)].join(""),
  awsSecret: rep("wJalrXUtnFEMIK7MDENGbPxRfiCY", 2).slice(0, 40),
  github: ["ghp", rep("aB3d", 9)].join("_"),
  gitlab: ["glpat", rep("x9Yz", 6)].join("-"),
  slack: ["xoxb", "1234567890", rep("abC1", 6)].join("-"),
  slackHook: ["https://hooks.slack.com/services", "T0AAAAAAA", "B0BBBBBBB", rep("cD4e", 6)].join("/"),
  stripeLive: ["sk", "live", rep("4eC39HqLyjWDarjtT1zdp7dc", 1)].join("_"),
  stripeTest: ["sk", "test", rep("4eC39HqLyjWDarjtT1zdp7dc", 1)].join("_"),
  anthropic: ["sk-ant-api03", rep("Ab1-_", 20)].join("-"),
  openai: ["sk-proj", rep("Zx9Kq", 10)].join("-"),
  npm: ["npm", rep("Tk8m", 9)].join("_"),
  google: ["AIza", rep("Sy9f", 8), "abc"].join(""),
  sendgrid: ["SG", rep("q1W2e3R4t5", 2) + "ab", rep("Z9y8X7w6V5", 4) + "abc"].join("."),
  jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join("."),
};

const SRC: SecretScanFile = { path: "src/config.ts", kind: "SOURCE", isEnvFile: false, isEnvTemplate: false };
const scan = (text: string, file: Partial<SecretScanFile> = {}) => scanTextForSecrets(text, { ...SRC, ...file });
const ruleIds = (fs: Array<{ rule: string }>) => fs.map((f) => SECURITY_RULES[f.rule as keyof typeof SECURITY_RULES].id);

describe("secret detection", () => {
  it.each([
    ["AWS access key ID", `const id = "${FAKE.aws}";`, "secret/cloud-credential", "HIGH"],
    ["AWS secret access key", `aws_secret_access_key = ${FAKE.awsSecret}`, "secret/cloud-credential", "CRITICAL"],
    ["GitHub token", `const t = '${FAKE.github}'`, "secret/api-token", "CRITICAL"],
    ["GitLab token", `token: ${FAKE.gitlab}`, "secret/api-token", "CRITICAL"],
    ["Slack token", `SLACK=${FAKE.slack}`, "secret/api-token", "HIGH"],
    ["Slack webhook", `post("${FAKE.slackHook}")`, "secret/api-token", "HIGH"],
    ["Stripe live key", `stripe(${JSON.stringify(FAKE.stripeLive)})`, "secret/api-token", "CRITICAL"],
    ["Stripe test key", `stripe(${JSON.stringify(FAKE.stripeTest)})`, "secret/api-token", "LOW"],
    ["Anthropic key", `new Anthropic({ apiKey: "${FAKE.anthropic}" })`, "secret/api-token", "CRITICAL"],
    ["OpenAI key", `OPENAI="${FAKE.openai}"`, "secret/api-token", "CRITICAL"],
    ["npm token", `//registry.npmjs.org/:_authToken=${FAKE.npm}`, "secret/api-token", "CRITICAL"],
    ["Google API key", `key=${FAKE.google}`, "secret/cloud-credential", "HIGH"],
    ["SendGrid key", `sg.setApiKey('${FAKE.sendgrid}')`, "secret/api-token", "CRITICAL"],
    ["JWT", `const auth = "Bearer ${FAKE.jwt}";`, "secret/json-web-token", "MEDIUM"],
  ])("detects a %s", (_label, line, ruleId, severity) => {
    const found = scan(line);
    expect(found).toHaveLength(1);
    expect(ruleIds(found)).toEqual([ruleId]);
    expect(found[0]!.severity).toBe(severity);
    expect(found[0]!.line).toBe(1);
  });

  it("never puts the secret value into evidence, key or data", () => {
    for (const value of Object.values(FAKE)) {
      for (const f of scan(`const apiKey = "${value}";\npassword = "${value}"`)) {
        const serialised = JSON.stringify(f);
        expect(serialised).not.toContain(value);
        // The identifying prefix may be shown (e.g. "ghp_", the Slack webhook host); the rest never is.
        expect(serialised).not.toContain(value.slice(-16));
      }
    }
    const [pw] = scan(`db.connect({ password: "Tr0ub4dor&3xyz" })`);
    expect(pw!.evidence).toMatch(/password: "(?:…\[redacted\]|<redacted>)"/);
    expect(JSON.stringify(pw)).not.toContain("Tr0ub4dor");
  });

  it("keeps a non-secret identifying prefix in the mask", () => {
    expect(maskSecret(FAKE.github, 4)).toBe("ghp_…[redacted]");
    expect(maskSecret("short", 4)).toBe("s…[redacted]"); // never reveals more than a third
    expect(maskSecret("hunter22")).toBe("…[redacted]");
  });

  it("detects hard-coded passwords and secrets assigned in code and config", () => {
    const code = scan(
      [
        `const password = "Tr0ub4dor&3";`,
        `config.clientSecret = 'q8Z!mK2@pL9#';`,
        `DB = { "db_password": "s3cr3t-Value" }`,
        `private static final String API_KEY = "k-2df8a9e1c3b4";`,
      ].join("\n"),
    );
    expect(code.map((f) => [f.line, f.severity])).toEqual([
      [1, "HIGH"],
      [2, "HIGH"],
      [3, "HIGH"],
      [4, "HIGH"],
    ]);
    expect(code.every((f) => f.rule === "hardcodedSecret")).toBe(true);

    const yaml = scan("database:\n  password: pr0d-Pa55word\n  user: app\n", { path: "config/app.yml", kind: "CONFIG" });
    expect(yaml).toMatchObject([{ rule: "hardcodedSecret", line: 2, severity: "MEDIUM" }]);
  });

  it.each([
    [`const password = process.env.DB_PASSWORD;`],
    [`const password = "";`],
    [`password: "changeme"`],
    [`const apiKey = "\${API_KEY}";`],
    [`label: { password: "Enter your password" }`],
    [`const PASSWORD_FIELD = "password";`],
    [`tokenType: "Bearer-token-type"`],
    [`const passwordResetUrl = "https://example.com/reset";`],
    [`t("auth.password.label")`],
    [`const secretName = "prod-db-secret";`],
    [`const passenger = "seat-12A-window";`],
    [`if (isSecretVisible === "yes-shown") {}`],
    [`const api_key = "<your-api-key>";`],
    [`API_KEY=YOUR_API_KEY_HERE`],
    [`<input autoComplete={isSignup ? "new-password" : "current-password"} />`],
    [`fetch(url, { credentials: "same-origin" });`],
    [`const mode = hasKey ? "token-auth" : "secret-auth";`],
    [`password = os.environ["DB_PASSWORD"]`],
  ])("ignores placeholders and non-secret values: %s", (line) => {
    expect(scan(line, { path: "config/settings.env", kind: "CONFIG" })).toEqual([]);
  });

  it("detects passwords in connection strings, lowering severity for local hosts", () => {
    const remote = scan(`DATABASE_URL="postgresql://app:Xk92_mq7PzLw@db.prod.internal:5432/app"`);
    expect(remote).toMatchObject([{ rule: "databaseUrl", severity: "HIGH" }]);
    expect(remote[0]!.evidence).toContain("postgresql://app:…[redacted]@db.prod.internal");
    const local = scan(`url = "mysql://root:devpass99@localhost/app"`);
    expect(local).toMatchObject([{ rule: "databaseUrl", severity: "LOW" }]);
    expect(local[0]!.evidence).toContain("development credential");
    expect(scan(`url = "postgres://user:\${DB_PASSWORD}@host/db"`)).toEqual([]);
    expect(scan(`url = "postgres://localhost:5432/db"`)).toEqual([]);
  });

  it("reports private keys only when key material follows the header", () => {
    const body = rep("MIIEowIBAAKCAQEA7x", 4);
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", body, body, "-----END RSA PRIVATE KEY-----"].join("\n");
    const found = scan(pem, { path: "certs/server.key", kind: "OTHER" });
    expect(found).toMatchObject([{ rule: "privateKey", severity: "CRITICAL", line: 1 }]);
    expect(found[0]!.evidence).not.toContain(body);
    expect(scan(`const KEY = "-----BEGIN PRIVATE KEY-----\\n${body}\\n-----END PRIVATE KEY-----";`)).toMatchObject([{ rule: "privateKey" }]);
    // Code that only mentions the header (a PEM parser) is not a leaked key.
    expect(scan(`if (pem.startsWith("-----BEGIN RSA PRIVATE KEY-----")) {\n  return parse(pem);\n}`)).toEqual([]);
  });

  it("lowers severity in test and documentation files and says why", () => {
    const [f] = scan(`const key = "${FAKE.stripeLive}";`, { path: "tests/billing.test.ts", kind: "TEST" });
    expect(f).toMatchObject({ severity: "HIGH" });
    expect(f!.evidence).toContain("test file");
    const [doc] = scan(`password = "Tr0ub4dor&3"`, { path: "README.md", kind: "DOCUMENTATION" });
    expect(doc).toMatchObject({ severity: "LOW" });
  });

  it("treats .env files specially: unquoted values count, templates only report real tokens", () => {
    const env = scan("DB_HOST=db\nDB_PASSWORD=Xk92_mq7PzLw\nJWT_SECRET=\n", { path: ".env", kind: "CONFIG", isEnvFile: true });
    expect(env).toMatchObject([{ rule: "hardcodedSecret", line: 2, severity: "HIGH" }]);
    const template = scan(`DB_PASSWORD=example-password\nGITHUB_TOKEN=${FAKE.github}\n`, { path: ".env.example", kind: "CONFIG", isEnvTemplate: true });
    expect(ruleIds(template)).toEqual(["secret/api-token"]);
  });

  it("reads names after an escaped newline inside a string", () => {
    const found = scan(`files["a.py"] = "import os\\nDB_PASSWORD = 'Tr0ub4dor&3'\\n";`);
    expect(found[0]!.line).toBe(1); // one physical line containing a literal backslash-n
    expect(found).toMatchObject([{ rule: "hardcodedSecret", data: { name: "DB_PASSWORD" } }]);
  });

  it("reports one finding per secret when patterns overlap", () => {
    const found = scan(`const stripeSecretKey = "${FAKE.stripeLive}";`);
    expect(ruleIds(found)).toEqual(["secret/api-token"]);
  });
});

// ---------------------------------------------------------------- insecure patterns

async function patterns(grammar: GrammarId, source: string, path = "src/app") {
  const tree = await parseSource(grammar, source, 5000);
  try {
    return inspectTree(tree!, grammar, source, path).map((f) => ({ rule: SECURITY_RULES[f.rule].id, severity: f.severity, line: f.line }));
  } finally {
    tree!.delete();
  }
}

describe("insecure patterns: JavaScript / TypeScript", () => {
  it.each<[string, string, string, string]>([
    ["eval of a runtime value", "eval(userInput);", "injection/dynamic-code-execution", "HIGH"],
    ["new Function", "const f = new Function('a', body);", "injection/dynamic-code-execution", "HIGH"],
    ["setTimeout with a built string", "setTimeout('run(' + id + ')', 10);", "injection/dynamic-code-execution", "MEDIUM"],
    ["child_process.exec with a template", "const cp = require('child_process');\ncp.exec(`convert ${file} out.png`);", "injection/os-command", "HIGH"],
    ["imported execSync", "import { execSync } from 'node:child_process';\nexecSync('git log ' + ref);", "injection/os-command", "HIGH"],
    ["spawn with shell: true", "const { spawn } = require('child_process');\nspawn('ls', ['-l'], { shell: true });", "injection/os-command", "MEDIUM"],
    ["SQL via template literal", "db.query(`SELECT * FROM users WHERE id = ${id}`);", "injection/sql", "HIGH"],
    ["SQL via concatenation", "pool.execute('DELETE FROM t WHERE name = \"' + name + '\"');", "injection/sql", "HIGH"],
    ["Prisma unsafe raw", "prisma.$queryRawUnsafe(`SELECT * FROM t WHERE a = ${a}`);", "injection/sql", "HIGH"],
    ["innerHTML", "el.innerHTML = comment.body;", "injection/xss-sink", "MEDIUM"],
    ["document.write", "document.write(location.hash);", "injection/xss-sink", "MEDIUM"],
    ["rejectUnauthorized: false", "https.request({ host, rejectUnauthorized: false });", "crypto/tls-verification-disabled", "HIGH"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';", "crypto/tls-verification-disabled", "HIGH"],
    ["JWT alg none", "jwt.verify(token, key, { algorithms: ['none'] });", "crypto/jwt-verification-disabled", "HIGH"],
    ["MD5", "crypto.createHash('md5').update(pw).digest('hex');", "crypto/weak-hash", "MEDIUM"],
    ["createCipher", "crypto.createCipher('aes-256-cbc', password);", "crypto/weak-cipher", "MEDIUM"],
    ["ECB mode", "crypto.createCipheriv('aes-128-ecb', key, null);", "crypto/weak-cipher", "MEDIUM"],
    ["Math.random token", "const resetToken = Math.random().toString(36).slice(2);", "crypto/insecure-randomness", "MEDIUM"],
  ])("flags %s", async (_name, source, rule, severity) => {
    const found = await patterns("typescript", source);
    expect(found.map((f) => f.rule)).toEqual([rule]);
    expect(found[0]!.severity).toBe(severity);
  });

  it("flags dangerouslySetInnerHTML in TSX", async () => {
    expect(await patterns("tsx", "export const A = ({ html }) => <div dangerouslySetInnerHTML={{ __html: html }} />;")).toMatchObject([
      { rule: "injection/xss-sink", severity: "MEDIUM" },
    ]);
  });

  it.each([
    ["eval of a literal", "eval('1 + 1');"],
    ["regex exec", "const m = /a(b)/.exec(text); pattern.exec(input);"],
    ["exec without child_process", "db.exec(command);"],
    ["parameterised SQL", "db.query('SELECT * FROM users WHERE id = $1', [id]);"],
    ["tagged template SQL", "prisma.$queryRaw`SELECT * FROM t WHERE a = ${a}`;"],
    ["non-SQL template", "logger.query(`fetching ${id}`);"],
    ["literal innerHTML", "el.innerHTML = '';"],
    ["textContent", "el.textContent = comment.body;"],
    ["rejectUnauthorized true", "https.request({ rejectUnauthorized: true });"],
    ["sha256", "crypto.createHash('sha256');"],
    ["createCipheriv with GCM", "crypto.createCipheriv('aes-256-gcm', key, iv);"],
    ["Math.random for layout", "const jitter = Math.random() * 100;"],
    ["commented-out eval", "// eval(userInput);\n/* cp.exec(`rm ${x}`) */"],
    ["string mentioning eval", "const help = 'never call eval(userInput)';"],
    ["execFile without shell", "const { execFile } = require('child_process');\nexecFile('git', ['log', ref]);"],
  ])("does not flag %s", async (_name, source) => {
    expect(await patterns("typescript", source)).toEqual([]);
  });
});

describe("insecure patterns: Python", () => {
  it.each<[string, string, string, string]>([
    ["eval", "result = eval(expr)", "injection/dynamic-code-execution", "HIGH"],
    ["os.system", "os.system('ping ' + host)", "injection/os-command", "HIGH"],
    ["subprocess shell=True dynamic", "subprocess.run(f'tar xf {name}', shell=True)", "injection/os-command", "HIGH"],
    ["subprocess shell=True literal", "subprocess.call('ls -l', shell=True)", "injection/os-command", "LOW"],
    ["f-string SQL", "cur.execute(f\"SELECT * FROM users WHERE name = '{name}'\")", "injection/sql", "HIGH"],
    ["%-formatted SQL", "cursor.execute(\"DELETE FROM t WHERE id = %s\" % item_id)", "injection/sql", "HIGH"],
    [".format SQL", "db.execute('UPDATE t SET a = {} WHERE id = 1'.format(a))", "injection/sql", "HIGH"],
    ["pickle.loads", "obj = pickle.loads(request.data)", "unsafe/deserialization", "HIGH"],
    ["yaml.load without Loader", "cfg = yaml.load(stream)", "unsafe/deserialization", "HIGH"],
    ["yaml.load with unsafe Loader", "cfg = yaml.load(stream, Loader=yaml.Loader)", "unsafe/deserialization", "HIGH"],
    ["requests verify=False", "requests.get(url, verify=False)", "crypto/tls-verification-disabled", "HIGH"],
    ["unverified SSL context", "ctx = ssl._create_unverified_context()", "crypto/tls-verification-disabled", "HIGH"],
    ["CERT_NONE", "ctx.verify_mode = ssl.CERT_NONE", "crypto/tls-verification-disabled", "HIGH"],
    ["jwt.decode verify=False", "claims = jwt.decode(token, verify=False)", "crypto/jwt-verification-disabled", "HIGH"],
    ["verify_signature False", "jwt.decode(token, key, options={'verify_signature': False})", "crypto/jwt-verification-disabled", "HIGH"],
    ["md5", "digest = hashlib.md5(data).hexdigest()", "crypto/weak-hash", "MEDIUM"],
    ["hashlib.new sha1", "h = hashlib.new('sha1')", "crypto/weak-hash", "MEDIUM"],
    ["DES", "cipher = DES.new(key, DES.MODE_CBC, iv)", "crypto/weak-cipher", "MEDIUM"],
    ["AES ECB", "cipher = AES.new(key, AES.MODE_ECB)", "crypto/weak-cipher", "MEDIUM"],
    ["random token", "reset_token = ''.join(random.choice(chars) for _ in range(32))", "crypto/insecure-randomness", "MEDIUM"],
    ["Flask debug", "app.run(host='0.0.0.0', debug=True)", "config/debug-mode", "MEDIUM"],
  ])("flags %s", async (_name, source, rule, severity) => {
    const found = await patterns("python", source);
    expect(found.map((f) => f.rule)).toEqual([rule]);
    expect(found[0]!.severity).toBe(severity);
  });

  it("flags DEBUG = True only in Django settings modules", async () => {
    expect(await patterns("python", "DEBUG = True\n", "mysite/settings.py")).toMatchObject([{ rule: "config/debug-mode" }]);
    expect(await patterns("python", "DEBUG = True\n", "tools/cli.py")).toEqual([]);
  });

  it.each([
    ["literal eval", "x = eval('2 + 2')"],
    ["subprocess list without shell", "subprocess.run(['tar', 'xf', name])"],
    ["parameterised SQL", "cur.execute('SELECT * FROM users WHERE name = %s', (name,))"],
    ["plain f-string print", "print(f'hello {name}')"],
    ["safe_load", "cfg = yaml.safe_load(stream)"],
    ["yaml.load SafeLoader", "cfg = yaml.load(stream, Loader=yaml.SafeLoader)"],
    ["verify=True", "requests.get(url, verify=True)"],
    ["md5 not for security", "h = hashlib.md5(data, usedforsecurity=False)"],
    ["sha256", "h = hashlib.sha256(data)"],
    ["random for sampling", "sample = random.choice(rows)"],
    ["secrets module", "token = secrets.token_urlsafe(32)"],
    ["app.run without debug", "app.run(port=8000)"],
  ])("does not flag %s", async (_name, source) => {
    expect(await patterns("python", source)).toEqual([]);
  });
});

describe("insecure patterns: Java", () => {
  const wrap = (body: string) => `class A { void f() throws Exception { ${body} } }`;
  it.each<[string, string, string, string]>([
    ["Runtime.exec", "Runtime.getRuntime().exec(\"ping \" + host);", "injection/os-command", "HIGH"],
    ["concatenated SQL", "stmt.executeQuery(\"SELECT * FROM users WHERE id = \" + id);", "injection/sql", "HIGH"],
    ["String.format SQL", "jdbc.queryForList(String.format(\"SELECT * FROM t WHERE a = '%s'\", a));", "injection/sql", "HIGH"],
    ["MD5 digest", "MessageDigest md = MessageDigest.getInstance(\"MD5\");", "crypto/weak-hash", "MEDIUM"],
    ["DES cipher", "Cipher c = Cipher.getInstance(\"DES/CBC/PKCS5Padding\");", "crypto/weak-cipher", "MEDIUM"],
    ["AES default ECB", "Cipher c = Cipher.getInstance(\"AES\");", "crypto/weak-cipher", "MEDIUM"],
    ["ObjectInputStream", "Object o = new ObjectInputStream(socket.getInputStream()).readObject();", "unsafe/deserialization", "MEDIUM"],
    ["java.util.Random token", "Random sessionToken = new Random();", "crypto/insecure-randomness", "MEDIUM"],
    ["NoopHostnameVerifier", "builder.setSSLHostnameVerifier(NoopHostnameVerifier.INSTANCE);", "crypto/tls-verification-disabled", "HIGH"],
  ])("flags %s", async (_name, body, rule, severity) => {
    const found = await patterns("java", wrap(body));
    expect(found.map((f) => f.rule)).toEqual([rule]);
    expect(found[0]!.severity).toBe(severity);
  });

  it.each([
    ["prepared statement", "PreparedStatement ps = conn.prepareStatement(\"SELECT * FROM users WHERE id = ?\"); ps.setInt(1, id);"],
    ["SHA-256", "MessageDigest.getInstance(\"SHA-256\");"],
    ["AES/GCM", "Cipher.getInstance(\"AES/GCM/NoPadding\");"],
    ["literal exec", "Runtime.getRuntime().exec(\"ls\");"],
    ["Random for shuffling", "Random rng = new Random(); Collections.shuffle(list, rng);"],
  ])("does not flag %s", async (_name, body) => {
    expect(await patterns("java", wrap(body))).toEqual([]);
  });
});

describe("insecure patterns: C / C++", () => {
  const wrap = (body: string) => `#include <stdio.h>\nvoid f(char *in, char *cmd) { char buf[16]; ${body} }`;
  it.each<[string, string, string, string]>([
    ["gets", "gets(buf);", "memory/unsafe-c-function", "HIGH"],
    ["strcpy", "strcpy(buf, in);", "memory/unsafe-c-function", "MEDIUM"],
    ["sprintf", "sprintf(buf, \"%s\", in);", "memory/unsafe-c-function", "MEDIUM"],
    ["scanf %s", "scanf(\"%s\", buf);", "memory/unsafe-c-function", "MEDIUM"],
    ["system with a variable", "system(cmd);", "injection/os-command", "HIGH"],
    ["curl peer verification off", "curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);", "crypto/tls-verification-disabled", "HIGH"],
    ["EVP_md5", "EVP_DigestInit_ex(ctx, EVP_md5(), NULL);", "crypto/weak-hash", "MEDIUM"],
    ["DES ECB", "EVP_EncryptInit_ex(ctx, EVP_des_ecb(), NULL, key, NULL);", "crypto/weak-cipher", "MEDIUM"],
  ])("flags %s", async (_name, body, rule, severity) => {
    const found = await patterns("c", wrap(body));
    expect(found.map((f) => f.rule)).toEqual([rule]);
    expect(found[0]!.severity).toBe(severity);
  });

  it.each([
    ["snprintf", "snprintf(buf, sizeof buf, \"%s\", in);"],
    ["fgets", "fgets(buf, sizeof buf, stdin);"],
    ["bounded scanf", "scanf(\"%15s\", buf);"],
    ["literal system", "system(\"clear\");"],
    ["curl verification on", "curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);"],
  ])("does not flag %s", async (_name, body) => {
    expect(await patterns("c", wrap(body))).toEqual([]);
  });

  it("applies to C++ as well", async () => {
    expect(await patterns("cpp", "void f(const char* s) { char b[8]; std::strcpy(b, s); }")).toMatchObject([{ rule: "memory/unsafe-c-function" }]);
  });
});

describe("insecure pattern evidence", () => {
  it("quotes the code, names the line and never contains a secret-looking literal", async () => {
    const src = `const apiKey = "${FAKE.github}";\ncp.exec(\`curl -H 'Authorization: ${FAKE.github}' \${url}\`);\n`;
    const tree = await parseSource("javascript", `const cp = require('child_process');\n${src}`, 5000);
    const [f] = inspectTree(tree!, "javascript", `const cp = require('child_process');\n${src}`, "src/a.js");
    tree!.delete();
    expect(f!.evidence).toMatch(/^`cp\.exec\(.*` at line 3 runs a dynamically built command/);
    expect(f!.evidence).not.toContain(FAKE.github);
  });
});

// ---------------------------------------------------------------- integration

async function analyzeRepo(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pd-security-test-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), content);
    }
    const repo = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
    const security = createSecurityScanner();
    const code = await analyzeCode(repo.files, { onTree: security.inspectTree });
    const plain = await analyzeCode(repo.files);
    return { code, plain, security: await security.finish(repo) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("createSecurityScanner", () => {
  const repo = {
    "src/db.ts": "export function find(db: any, id: string) {\n  return db.query(`SELECT * FROM t WHERE id = ${id}`);\n}\n",
    "src/config.py": `import os\nAPI_TOKEN = "${FAKE.github}"\nDEBUG_PASSWORD = "Tr0ub4dor&3"\n`,
    "tests/db.test.ts": "import { find } from '../src/db';\neval(input);\n",
    ".env": "DB_PASSWORD=Xk92_mq7PzLw\nPORT=3000\n",
    ".env.example": "DB_PASSWORD=\nPORT=3000\n",
    "docs/setup.md": "Set `password: \"changeme\"` in your config.\n",
    "assets/logo.png": "\u0000\u0001binary",
  };

  it("combines pattern and secret findings with CWE data and stable, unique fingerprints", async () => {
    const { security } = await analyzeRepo(repo);
    const summary = security.summary;
    const byRule = Object.fromEntries(security.findings.map((f) => [`${f.path}:${f.ruleId}`, f.severity]));
    expect(byRule).toEqual({
      "src/db.ts:injection/sql": "HIGH",
      "src/config.py:secret/api-token": "CRITICAL",
      "src/config.py:secret/hardcoded-credential": "HIGH",
      ".env:secret/hardcoded-credential": "HIGH",
      ".env:secret/committed-env-file": "MEDIUM",
    });
    // Test files are measured but not inspected for insecure patterns.
    expect(security.findings.some((f) => f.path.startsWith("tests/"))).toBe(false);
    expect(summary.totals).toMatchObject({ findings: 5, secrets: 4, insecurePatterns: 1, sourceFilesInspected: 2, filesWithFindings: 3 });
    expect(summary.totals.bySeverity).toMatchObject({ CRITICAL: 1, HIGH: 3, MEDIUM: 1 });
    expect(summary.envFiles).toEqual([".env"]);
    expect(summary.rules[0]).toMatchObject({ id: "secret/api-token", cwe: "CWE-798", maxSeverity: "CRITICAL", count: 1 });
    expect(summary.topFiles[0]).toMatchObject({ path: "src/config.py", findings: 2, maxSeverity: "CRITICAL" });

    for (const f of security.findings) {
      expect(f.category).toBe(f.ruleId.startsWith("secret/") ? "SECRET" : "SECURITY");
      expect(f.data).toMatchObject({ cwe: expect.stringMatching(/^CWE-\d+$/), owasp: expect.stringContaining("2021") });
      expect(f.analyzer).toBe("security");
      expect(JSON.stringify(f)).not.toContain(FAKE.github);
      expect(JSON.stringify(f)).not.toContain("Xk92_mq7PzLw");
    }
    expect(new Set(security.findings.map((f) => f.fingerprint)).size).toBe(security.findings.length);

    const again = await analyzeRepo(repo);
    expect(again.security.findings.map((f) => f.fingerprint).sort()).toEqual(security.findings.map((f) => f.fingerprint).sort());
  });

  it("leaves Phase 2 code metrics unchanged", async () => {
    const { code, plain } = await analyzeRepo(repo);
    const strip = (c: typeof code) => ({ files: c.files, findings: c.findings, totals: c.summary.totals });
    expect(strip(code)).toEqual(strip(plain));
  });

  it("keeps the most severe findings when capped", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pd-security-cap-"));
    try {
      await writeFile(path.join(root, "a.py"), Array.from({ length: 12 }, (_, i) => `h${i} = hashlib.md5(x)`).join("\n") + `\nk = "${FAKE.stripeLive}"\n`);
      const repoScan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
      const security = createSecurityScanner({ maxFindings: 5 });
      await analyzeCode(repoScan.files, { onTree: security.inspectTree });
      const res = await security.finish(repoScan);
      expect(res.summary.findings).toEqual({ total: 13, stored: 5, truncated: true });
      expect(res.findings[0]).toMatchObject({ severity: "CRITICAL", ruleId: "secret/api-token" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("survives a hook that throws without losing code metrics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pd-security-hook-"));
    try {
      await writeFile(path.join(root, "a.js"), "export const a = 1;\n");
      const repoScan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
      const res = await analyzeCode(repoScan.files, {
        onTree: () => {
          throw new Error("consumer bug");
        },
      });
      expect(res.files.map((f) => f.path)).toEqual(["a.js"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
