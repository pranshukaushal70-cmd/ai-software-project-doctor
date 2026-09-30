/**
 * Security rule catalogue. Every finding references one of these entries, so
 * its impact, recommendation and CWE/OWASP classification are always explainable.
 */
export interface SecurityRuleDefinition {
  id: string;
  /** Short machine-friendly finding type, stored as Finding.type. */
  type: string;
  category: "SECRET" | "SECURITY";
  title: string;
  cwe: string;
  /** OWASP Top 10 (2021) category. */
  owasp: string;
  impact: string;
  recommendation: string;
}

const rule = (r: SecurityRuleDefinition) => r;

const SECRET_IMPACT =
  "Anyone who can read the repository (or its history, forks and CI logs) can use this credential. Removing it from the latest commit does not revoke it.";
const SECRET_RECOMMENDATION =
  "Revoke and rotate the credential now, then load it from an environment variable or a secret manager. Purge it from git history (git filter-repo) if the repository was ever shared.";

export const SECURITY_RULES = {
  // ------------------------------------------------------------ secrets
  privateKey: rule({
    id: "secret/private-key",
    type: "private-key",
    category: "SECRET",
    title: "Private key committed to the repository",
    cwe: "CWE-321",
    owasp: "A02:2021 Cryptographic Failures",
    impact: "A committed private key lets anyone impersonate the server or user it belongs to, or decrypt traffic and data protected by it.",
    recommendation: "Revoke the key pair and issue a new one. Keep private keys out of the repository (secret manager, mounted file) and purge the key from git history.",
  }),
  cloudCredential: rule({
    id: "secret/cloud-credential",
    type: "cloud-credential",
    category: "SECRET",
    title: "Cloud provider credential",
    cwe: "CWE-798",
    owasp: "A07:2021 Identification and Authentication Failures",
    impact: `${SECRET_IMPACT} Cloud credentials can expose data and run up costs within minutes of leaking.`,
    recommendation: SECRET_RECOMMENDATION,
  }),
  apiToken: rule({
    id: "secret/api-token",
    type: "api-token",
    category: "SECRET",
    title: "API token or key for a third-party service",
    cwe: "CWE-798",
    owasp: "A07:2021 Identification and Authentication Failures",
    impact: SECRET_IMPACT,
    recommendation: SECRET_RECOMMENDATION,
  }),
  databaseUrl: rule({
    id: "secret/database-credentials",
    type: "database-credentials",
    category: "SECRET",
    title: "Connection string with an embedded password",
    cwe: "CWE-798",
    owasp: "A07:2021 Identification and Authentication Failures",
    impact: "The connection string grants direct access to the database or broker with the embedded user's privileges.",
    recommendation: "Build the connection string from environment variables at runtime and rotate the password.",
  }),
  jwt: rule({
    id: "secret/json-web-token",
    type: "json-web-token",
    category: "SECRET",
    title: "Hard-coded JSON Web Token",
    cwe: "CWE-798",
    owasp: "A07:2021 Identification and Authentication Failures",
    impact: "A committed JWT can be replayed until it expires; long-lived tokens effectively act as passwords.",
    recommendation: "Remove the token, invalidate it if it was ever valid, and obtain tokens at runtime.",
  }),
  hardcodedSecret: rule({
    id: "secret/hardcoded-credential",
    type: "hardcoded-credential",
    category: "SECRET",
    title: "Hard-coded password or secret",
    cwe: "CWE-798",
    owasp: "A07:2021 Identification and Authentication Failures",
    impact: "Credentials in source code are shared with everyone who can read the code and cannot be rotated without a code change.",
    recommendation: SECRET_RECOMMENDATION,
  }),
  committedEnvFile: rule({
    id: "secret/committed-env-file",
    type: "committed-env-file",
    category: "SECRET",
    title: "Environment file with values is committed",
    cwe: "CWE-538",
    owasp: "A05:2021 Security Misconfiguration",
    impact: ".env files usually hold real credentials for one environment; committing them publishes those values to every clone.",
    recommendation: "Remove the file from git, add it to .gitignore, and commit a .env.example with empty values instead.",
  }),

  // ------------------------------------------------------------ injection
  codeInjection: rule({
    id: "injection/dynamic-code-execution",
    type: "code-injection",
    category: "SECURITY",
    title: "Dynamic code execution",
    cwe: "CWE-95",
    owasp: "A03:2021 Injection",
    impact: "Evaluating a string built at runtime runs attacker-controlled code if any part of it can be influenced by input.",
    recommendation: "Avoid eval-style APIs. Parse data with a real parser (JSON.parse, ast.literal_eval) or dispatch through an explicit lookup table.",
  }),
  commandInjection: rule({
    id: "injection/os-command",
    type: "command-injection",
    category: "SECURITY",
    title: "OS command built from a dynamic string",
    cwe: "CWE-78",
    owasp: "A03:2021 Injection",
    impact: "Commands run through a shell interpret metacharacters (; | $() …), so interpolated input can run arbitrary commands on the host.",
    recommendation: "Call the program directly with an argument array and no shell (execFile/spawn, subprocess.run([...]), ProcessBuilder), and validate inputs against an allow-list.",
  }),
  sqlInjection: rule({
    id: "injection/sql",
    type: "sql-injection",
    category: "SECURITY",
    title: "SQL query built by string concatenation or interpolation",
    cwe: "CWE-89",
    owasp: "A03:2021 Injection",
    impact: "Values spliced into SQL text can change the query's structure, allowing data theft, modification or authentication bypass.",
    recommendation: "Use parameterised queries or prepared statements (placeholders such as ? or $1) and pass values separately; never build SQL with + , template literals, f-strings or %.",
  }),
  xss: rule({
    id: "injection/xss-sink",
    type: "xss",
    category: "SECURITY",
    title: "HTML injected from a dynamic value",
    cwe: "CWE-79",
    owasp: "A03:2021 Injection",
    impact: "Writing unescaped values as HTML lets injected markup and scripts run in the user's browser (cross-site scripting).",
    recommendation: "Assign textContent instead of innerHTML, let the framework escape output, or sanitise with a vetted library such as DOMPurify.",
  }),

  // ------------------------------------------------------------ unsafe APIs
  deserialization: rule({
    id: "unsafe/deserialization",
    type: "insecure-deserialization",
    category: "SECURITY",
    title: "Unsafe deserialization",
    cwe: "CWE-502",
    owasp: "A08:2021 Software and Data Integrity Failures",
    impact: "These deserializers can instantiate arbitrary objects; feeding them untrusted data can lead to remote code execution.",
    recommendation: "Use a data-only format (JSON), yaml.safe_load, or an allow-listed object filter; never deserialize data from users or the network with pickle/ObjectInputStream.",
  }),
  tlsVerificationDisabled: rule({
    id: "crypto/tls-verification-disabled",
    type: "tls-verification-disabled",
    category: "SECURITY",
    title: "TLS certificate verification is disabled",
    cwe: "CWE-295",
    owasp: "A02:2021 Cryptographic Failures",
    impact: "Without certificate verification any network attacker can impersonate the server and read or modify the traffic (man-in-the-middle).",
    recommendation: "Keep verification on. For private certificate authorities, configure the CA bundle (ca option, REQUESTS_CA_BUNDLE, a trust store) instead of disabling checks.",
  }),
  jwtVerificationDisabled: rule({
    id: "crypto/jwt-verification-disabled",
    type: "jwt-verification-disabled",
    category: "SECURITY",
    title: "JWT signature verification is disabled",
    cwe: "CWE-347",
    owasp: "A02:2021 Cryptographic Failures",
    impact: "Tokens are accepted without checking their signature, so anyone can forge a token with arbitrary claims.",
    recommendation: "Always verify the signature and pin the expected algorithms (e.g. algorithms=[\"RS256\"]).",
  }),
  weakHash: rule({
    id: "crypto/weak-hash",
    type: "weak-hash",
    category: "SECURITY",
    title: "Weak hash algorithm (MD5/SHA-1)",
    cwe: "CWE-328",
    owasp: "A02:2021 Cryptographic Failures",
    impact: "MD5 and SHA-1 have practical collision attacks. Used for signatures, integrity or passwords they no longer provide security.",
    recommendation: "Use SHA-256 or better for integrity, and a password hash (argon2id, bcrypt, scrypt) for passwords. If the hash is only a non-security checksum, mark it as such (e.g. usedforsecurity=False).",
  }),
  weakCipher: rule({
    id: "crypto/weak-cipher",
    type: "weak-cipher",
    category: "SECURITY",
    title: "Weak cipher or insecure cipher mode",
    cwe: "CWE-327",
    owasp: "A02:2021 Cryptographic Failures",
    impact: "DES/RC4 are broken and ECB mode leaks patterns in the plaintext; data encrypted this way is not confidential.",
    recommendation: "Use an authenticated mode such as AES-GCM (or ChaCha20-Poly1305) with a random IV/nonce per message.",
  }),
  insecureRandom: rule({
    id: "crypto/insecure-randomness",
    type: "insecure-randomness",
    category: "SECURITY",
    title: "Predictable random value used for a security token",
    cwe: "CWE-338",
    owasp: "A02:2021 Cryptographic Failures",
    impact: "General-purpose PRNGs are predictable; tokens, salts or passwords generated with them can be guessed.",
    recommendation: "Use a cryptographically secure generator: crypto.randomBytes / crypto.randomUUID, Python's secrets module, java.security.SecureRandom.",
  }),
  unsafeCFunction: rule({
    id: "memory/unsafe-c-function",
    type: "unsafe-c-function",
    category: "SECURITY",
    title: "Unbounded C string function",
    cwe: "CWE-120",
    owasp: "A06:2021 Vulnerable and Outdated Components",
    impact: "These functions write without checking the destination size; oversized input overflows the buffer and can lead to code execution.",
    recommendation: "Use bounded alternatives (fgets, snprintf, strlcpy/strncpy with explicit termination) and always pass the buffer size.",
  }),
  debugMode: rule({
    id: "config/debug-mode",
    type: "debug-mode",
    category: "SECURITY",
    title: "Debug mode enabled in application code",
    cwe: "CWE-489",
    owasp: "A05:2021 Security Misconfiguration",
    impact: "Framework debug modes expose stack traces and, for Flask/Werkzeug, an interactive debugger that allows code execution.",
    recommendation: "Read the debug flag from configuration and make sure it is off in production.",
  }),
} as const;

export type SecurityRuleKey = keyof typeof SECURITY_RULES;
