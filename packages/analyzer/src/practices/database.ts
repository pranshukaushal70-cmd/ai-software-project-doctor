import type { Detection } from "../scanner";
import { snippet } from "../metrics/evidence";
import { basename, lineIndex, type RawPracticeFinding, type TextFile } from "./types";

/**
 * Database analysis: reads Prisma schemas, SQL DDL (schema files and migrations)
 * and ORM model declarations as text, and checks the schema and how it is
 * managed. No database is contacted.
 */

export interface DatabaseSummary {
  /** A database technology, schema, model or SQL table was found. */
  detected: boolean;
  /** ORMs, drivers and schema tools, each with the file it was derived from. */
  technologies: Array<{ name: string; evidence: string }>;
  schemaFiles: string[];
  /** ORM models / entities declared in code or a Prisma schema. */
  models: number;
  /** Tables created by SQL DDL. */
  tables: number;
  /** Foreign-key relations seen in the schema. */
  relations: number;
  migrations: { tools: string[]; files: number };
  unindexedForeignKeys: number;
  tablesWithoutPrimaryKey: number;
  /** Places where the ORM changes the schema at start-up ("path:line"). */
  autoSchemaSync: string[];
}

const MIGRATION_TOOLS: Array<{ re: RegExp; tool: string }> = [
  { re: /(?:^|\/)migrations\/[^/]+\/migration\.sql$/, tool: "Prisma Migrate" },
  { re: /(?:^|\/)migrations\/\d{4}_\w+\.py$/, tool: "Django migrations" },
  { re: /(?:^|\/)(?:alembic|migrations)\/versions\/[^/]+\.py$/, tool: "Alembic" },
  { re: /(?:^|\/)db\/migration\/V\d[\w.]*__[^/]+\.sql$/, tool: "Flyway" },
  { re: /(?:^|\/)(?:db|resources)\/[\w/-]*changelog[^/]*\.(?:xml|ya?ml|json|sql)$/i, tool: "Liquibase" },
  { re: /(?:^|\/)db\/migrate\/[^/]+\.rb$/, tool: "Rails migrations" },
  { re: /(?:^|\/)migrations?\/[^/]+\.(?:[cm]?js|ts)$/, tool: "JavaScript migrations" },
  { re: /(?:^|\/)migrations?\/[^/]*\.sql$|(?:^|\/)\d+_[\w-]+\.(?:up|down)\.sql$/, tool: "SQL migrations" },
];

const ident = (s: string) =>
  s
    .trim()
    .replace(/["`[\]]/g, "")
    .split(".")
    .pop()!
    .toLowerCase();
const columnList = (s: string) =>
  s
    .split(",")
    .map((c) => ident(c.replace(/\(.*$/, "").replace(/\s+(?:ASC|DESC|NULLS\s+\w+)\b.*$/i, "")))
    .filter(Boolean);
/** True when some index's leading columns are exactly the foreign-key columns. */
const covered = (fk: string[], indexes: string[][]) => indexes.some((ix) => fk.every((c, i) => ix[i] === c));

/** Index of the parenthesis closing the one at `open`, or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Splits on commas that are not inside parentheses; each part keeps the offset of its first non-blank character. */
function topLevelParts(body: string): Array<{ text: string; offset: number }> {
  const parts: Array<{ text: string; offset: number }> = [];
  const push = (from: number, to: number) => {
    const raw = body.slice(from, to);
    parts.push({ text: raw.trim(), offset: from + (raw.length - raw.trimStart().length) });
  };
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, body.length);
  return parts;
}

// ---------------------------------------------------------------- Prisma

interface SchemaStats {
  models: number;
  relations: number;
}

function analyzePrisma(f: TextFile, raw: RawPracticeFinding[]): SchemaStats {
  const provider = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"(\w+)"/.exec(f.text)?.[1] ?? null;
  // MySQL (InnoDB) creates an index for every foreign key; MongoDB has no foreign keys.
  const indexesForeignKeys = provider === "mysql" || provider === "mongodb";
  const lines = f.text.split(/\r?\n/);
  const stats: SchemaStats = { models: 0, relations: 0 };
  let model: { name: string; indexes: string[][]; relations: Array<{ field: string; cols: string[]; line: number }> } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\/\/.*$/, "");
    if (!model) {
      const start = /^\s*model\s+(\w+)\s*\{/.exec(line);
      if (start) model = { name: start[1]!, indexes: [], relations: [] };
      continue;
    }
    if (/^\s*\}/.test(line)) {
      stats.models++;
      stats.relations += model.relations.length;
      for (const r of model.relations) {
        if (indexesForeignKeys || covered(r.cols, model.indexes)) continue;
        raw.push({
          rule: "unindexedForeignKey",
          path: f.path,
          severity: "LOW",
          line: r.line,
          evidence: `Model \`${model.name}\`: relation \`${r.field}\` uses ${r.cols.map((c) => `\`${c}\``).join(", ")}, which no @id, @unique, @@index or @@unique starts with${provider ? ` (provider: ${provider})` : ""}.`,
          key: `${model.name}.${r.cols.join(",")}`,
          data: { model: model.name, columns: r.cols, provider },
        });
      }
      model = null;
      continue;
    }
    const block = /^\s*@@(?:id|unique|index)\s*\(\s*(?:fields\s*:\s*)?\[([^\]]*)\]/.exec(line);
    if (block) {
      model.indexes.push(columnList(block[1]!));
      continue;
    }
    const field = /^\s*(\w+)\s+\w+[[\]?]*\s*(.*)$/.exec(line);
    if (!field) continue;
    const attrs = field[2]!;
    if (/@id\b|@unique\b/.test(attrs)) model.indexes.push([field[1]!.toLowerCase()]);
    const rel = /@relation\([^)]*?fields\s*:\s*\[([^\]]*)\]/.exec(attrs);
    if (rel) model.relations.push({ field: field[1]!, cols: columnList(rel[1]!), line: i + 1 });
  }
  return stats;
}

// ---------------------------------------------------------------- SQL DDL

interface SqlSchema {
  tables: Map<string, { path: string; line: number; hasPrimaryKey: boolean; temporary: boolean }>;
  foreignKeys: Array<{ table: string; cols: string[]; path: string; line: number }>;
  indexes: Map<string, string[][]>;
  mysql: boolean;
}

/** Removes SQL comments, keeping offsets (and therefore line numbers) intact. */
const stripSqlComments = (sql: string) =>
  sql.replace(/--[^\n]*/g, (m) => " ".repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

const NAME = String.raw`((?:["\`[]?[\w$]+["\`\]]?\.)?["\`[]?[\w$]+["\`\]]?)`;
const CREATE_TABLE = new RegExp(String.raw`\bCREATE\s+(TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}\s*\(`, "gi");
const CREATE_INDEX = new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:${NAME}\s+)?ON\s+(?:ONLY\s+)?${NAME}\s*(?:USING\s+\w+\s*)?\(([^)]*)\)`, "gi");
const ALTER_FK = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?${NAME}[\s\S]{0,300}?\bFOREIGN\s+KEY\s*\(([^)]*)\)`, "gi");

function readSql(f: TextFile, schema: SqlSchema) {
  const sql = stripSqlComments(f.text);
  const at = lineIndex(sql);
  if (/\bENGINE\s*=|\bAUTO_INCREMENT\b/i.test(sql)) schema.mysql = true;
  const addIndex = (table: string, cols: string[]) => {
    const list = schema.indexes.get(table) ?? [];
    list.push(cols);
    schema.indexes.set(table, list);
  };

  for (const m of sql.matchAll(CREATE_TABLE)) {
    const table = ident(m[2]!);
    const open = m.index + m[0].length - 1;
    const close = closingParen(sql, open);
    if (close < 0) continue;
    const body = sql.slice(open + 1, close);
    const line = at(m.index);
    schema.tables.set(table, { path: f.path, line, hasPrimaryKey: /\bPRIMARY\s+KEY\b/i.test(body), temporary: !!m[1] });
    for (const { text: p, offset } of topLevelParts(body)) {
      const partLine = at(open + 1 + offset);
      const constraint = /^(?:CONSTRAINT\s+\S+\s+)?(PRIMARY\s+KEY|UNIQUE(?:\s+KEY|\s+INDEX)?|FOREIGN\s+KEY|KEY|INDEX)\s*(?:\S+\s*)?\(([^)]*)\)/i.exec(p);
      if (constraint) {
        const cols = columnList(constraint[2]!);
        if (/^FOREIGN/i.test(constraint[1]!)) schema.foreignKeys.push({ table, cols, path: f.path, line: partLine });
        else addIndex(table, cols);
        continue;
      }
      const column = /^["`[]?([\w$]+)["`\]]?\s+/.exec(p);
      if (!column) continue;
      const col = column[1]!.toLowerCase();
      if (/\bPRIMARY\s+KEY\b|\bUNIQUE\b/i.test(p)) addIndex(table, [col]);
      if (/\bREFERENCES\b/i.test(p)) schema.foreignKeys.push({ table, cols: [col], path: f.path, line: partLine });
    }
  }
  for (const m of sql.matchAll(CREATE_INDEX)) addIndex(ident(m[2]!), columnList(m[3]!));
  for (const m of sql.matchAll(ALTER_FK)) schema.foreignKeys.push({ table: ident(m[1]!), cols: columnList(m[2]!), path: f.path, line: at(m.index) });
}

// ---------------------------------------------------------------- ORMs in code

const SQLALCHEMY_FK_COLUMN = /^\s*(\w+)\s*(?::[^=\n]*)?=\s*(?:db\.|sa\.)?(?:Column|mapped_column)\s*\(/;

/** SQLAlchemy never indexes foreign keys implicitly; a column needs index=True (or an explicit Index). */
function sqlalchemyForeignKeys(f: TextFile, raw: RawPracticeFinding[]): number {
  const lines = f.text.split("\n");
  let relations = 0;
  let offset = 0;
  lines.forEach((line, i) => {
    const lineStart = offset;
    offset += line.length + 1;
    const m = SQLALCHEMY_FK_COLUMN.exec(line);
    if (!m) return;
    const start = lineStart + line.indexOf("(");
    const end = closingParen(f.text, start);
    const call = f.text.slice(start, end < 0 ? start + 400 : end + 1);
    if (!/\bForeignKey\s*\(/.test(call)) return;
    relations++;
    const col = m[1]!;
    if (/\b(?:index|primary_key|unique)\s*=\s*True\b/.test(call) || new RegExp(String.raw`\bIndex\s*\([^)]*\b${col}\b`).test(f.text)) return;
    raw.push({
      rule: "unindexedForeignKey",
      path: f.path,
      severity: "LOW",
      line: i + 1,
      evidence: `\`${snippet(line)}\`: foreign-key column \`${col}\` has no index=True and no Index() refers to it.`,
      key: col,
      data: { columns: [col], orm: "SQLAlchemy" },
    });
  });
  return relations;
}

interface OrmUse {
  name: string;
  models: number;
  path: string;
  /** Migration tools this ORM is normally used with; any of them counts. */
  expects: string[];
}

const AUTO_SYNC: Array<{ re: RegExp; what: string; kinds: ReadonlyArray<TextFile["kind"]> }> = [
  { re: /["']?\bsynchronize["']?\s*:\s*true\b/, what: "TypeORM synchronize: true", kinds: ["SOURCE", "CONFIG"] },
  { re: /\.sync\s*\(\s*\{[^}]*\b(?:force|alter)\s*:\s*true/, what: "Sequelize sync({ force/alter: true })", kinds: ["SOURCE"] },
  { re: /ddl-auto\s*[=:]\s*["']?(?:update|create|create-drop)\b/, what: "Hibernate ddl-auto", kinds: ["CONFIG"] },
  { re: /hbm2ddl\.auto\s*[=:]\s*["']?(?:update|create|create-drop)\b/, what: "Hibernate hbm2ddl.auto", kinds: ["CONFIG"] },
];

export function analyzeDatabase(files: readonly TextFile[], allPaths: readonly string[], frameworks: readonly Detection[]): { raw: RawPracticeFinding[]; summary: DatabaseSummary } {
  const raw: RawPracticeFinding[] = [];
  const technologies = new Map<string, string>();
  for (const d of frameworks) if (d.category === "database") technologies.set(d.name, d.evidence);

  const migrationFiles = allPaths.filter((p) => MIGRATION_TOOLS.some((t) => t.re.test(p)));
  const migrationTools = [...new Set(migrationFiles.map((p) => MIGRATION_TOOLS.find((t) => t.re.test(p))!.tool))];
  const hasMigrations = migrationFiles.length > 0 || allPaths.some((p) => basename(p) === "alembic.ini");

  // Prisma schemas.
  let models = 0;
  let relations = 0;
  const prismaSchemas = files.filter((f) => f.path.endsWith(".prisma"));
  for (const f of prismaSchemas) {
    const s = analyzePrisma(f, raw);
    models += s.models;
    relations += s.relations;
    technologies.set("Prisma", technologies.get("Prisma") ?? f.path);
  }

  // SQL DDL.
  const schema: SqlSchema = { tables: new Map(), foreignKeys: [], indexes: new Map(), mysql: false };
  const sqlFiles = files.filter((f) => f.path.toLowerCase().endsWith(".sql"));
  for (const f of sqlFiles) readSql(f, schema);
  let tablesWithoutPrimaryKey = 0;
  for (const [table, t] of schema.tables) {
    if (t.hasPrimaryKey || t.temporary) continue;
    tablesWithoutPrimaryKey++;
    raw.push({
      rule: "tableWithoutPrimaryKey",
      path: t.path,
      severity: "MEDIUM",
      line: t.line,
      evidence: `\`CREATE TABLE ${table}\` declares no PRIMARY KEY.`,
      key: table,
      data: { table },
    });
  }
  // SQL generated from a Prisma schema is checked through the schema itself.
  if (!schema.mysql && prismaSchemas.length === 0) {
    const seen = new Set<string>();
    for (const fk of schema.foreignKeys) {
      const id = `${fk.table}(${fk.cols.join(",")})`;
      if (seen.has(id) || covered(fk.cols, schema.indexes.get(fk.table) ?? [])) continue;
      seen.add(id);
      raw.push({
        rule: "unindexedForeignKey",
        path: fk.path,
        severity: "LOW",
        line: fk.line,
        evidence: `Foreign key \`${id}\` has no index, primary key or unique constraint starting with ${fk.cols.length === 1 ? "that column" : "those columns"} in the SQL files.`,
        key: id,
        data: { table: fk.table, columns: fk.cols },
      });
    }
  }
  relations += schema.foreignKeys.length;

  // ORM models declared in code.
  const orms: OrmUse[] = [];
  const addOrm = (name: string, count: number, path: string, expects: string[]) => {
    if (count === 0) return;
    const existing = orms.find((o) => o.name === name);
    if (existing) existing.models += count;
    else orms.push({ name, models: count, path, expects });
    technologies.set(name, technologies.get(name) ?? path);
  };
  const autoSchemaSync: string[] = [];
  const mysql = schema.mysql || [...technologies.keys()].some((n) => /mysql/i.test(n));
  for (const f of files) {
    if (f.kind !== "SOURCE" && f.kind !== "CONFIG") continue;
    const text = f.text;
    if (f.kind === "SOURCE" && f.language === "python") {
      if (/from\s+django\.db\s+import\s+models|import\s+django/.test(text)) addOrm("Django ORM", (text.match(/^class\s+\w+\(\s*(?:models\.)?Model\s*\)/gm) ?? []).length, f.path, ["Django migrations"]);
      if (/sqlalchemy/i.test(text)) {
        addOrm("SQLAlchemy", (text.match(/__tablename__\s*=/g) ?? []).length, f.path, ["Alembic", "SQL migrations"]);
        if (!mysql) relations += sqlalchemyForeignKeys(f, raw);
      }
    }
    if (f.kind === "SOURCE" && (f.language === "typescript" || f.language === "javascript")) {
      if (/from\s+['"]typeorm['"]|require\(\s*['"]typeorm['"]/.test(text)) addOrm("TypeORM", (text.match(/@Entity\s*\(/g) ?? []).length, f.path, ["JavaScript migrations", "SQL migrations"]);
      if (/sequelize/i.test(text)) addOrm("Sequelize", (text.match(/\.define\s*\(\s*['"]|\bextends\s+Model\b/g) ?? []).length, f.path, ["JavaScript migrations", "SQL migrations"]);
      if (/mongoose/.test(text)) addOrm("Mongoose", (text.match(/mongoose\.model\s*\(|\bmodel\s*\(\s*['"]\w+['"]\s*,/g) ?? []).length, f.path, []);
    }
    if (f.kind === "SOURCE" && f.language === "java" && /@Entity\b/.test(text)) addOrm("JPA / Hibernate", (text.match(/@Entity\b/g) ?? []).length, f.path, ["Flyway", "Liquibase", "SQL migrations"]);

    // Test configuration (application-test.properties, test/ormconfig.json) may recreate the schema on purpose.
    if (f.kind === "CONFIG" && /(?:^|\/)[^/]*test[^/]*$|(?:^|\/)tests?\//i.test(f.path)) continue;
    for (const s of AUTO_SYNC) {
      if (!s.kinds.includes(f.kind)) continue;
      const m = s.re.exec(text);
      if (!m) continue;
      const line = lineIndex(text)(m.index);
      autoSchemaSync.push(`${f.path}:${line}`);
      raw.push({
        rule: "autoSchemaSync",
        path: f.path,
        severity: "MEDIUM",
        line,
        evidence: `\`${snippet(text.split("\n")[line - 1] ?? "")}\` (${s.what}) lets the ORM change the schema when the application starts.`,
        key: s.what,
        data: { mechanism: s.what },
      });
    }
  }
  models += orms.reduce((n, o) => n + o.models, 0);

  if (!hasMigrations) {
    const unmanaged: Array<{ name: string; path: string; models: number }> = [];
    for (const f of prismaSchemas) unmanaged.push({ name: "Prisma", path: f.path, models: (f.text.match(/^\s*model\s+\w+/gm) ?? []).length });
    for (const o of orms) if (o.expects.length > 0 && autoSchemaSync.length === 0) unmanaged.push(o);
    for (const u of unmanaged.filter((x) => x.models > 0)) {
      raw.push({
        rule: "noMigrations",
        path: u.path,
        severity: "LOW",
        line: null,
        evidence: `${u.models} ${u.name} ${u.models === 1 ? "model is" : "models are"} declared, but the repository contains no migration files${u.name === "Prisma" ? " (no prisma/migrations directory; the schema may be applied with `prisma db push`)" : ""}.`,
        key: u.name,
        data: { orm: u.name, models: u.models },
      });
    }
  }

  const schemaFiles = [...prismaSchemas.map((f) => f.path), ...sqlFiles.filter((f) => [...schema.tables.values()].some((t) => t.path === f.path)).map((f) => f.path)];
  const unindexedForeignKeys = raw.filter((r) => r.rule === "unindexedForeignKey").length;
  return {
    raw,
    summary: {
      detected: technologies.size > 0 || schemaFiles.length > 0 || models > 0 || schema.tables.size > 0,
      technologies: [...technologies].map(([name, evidence]) => ({ name, evidence })),
      schemaFiles: schemaFiles.slice(0, 50),
      models,
      tables: schema.tables.size,
      relations,
      migrations: { tools: migrationTools, files: migrationFiles.length },
      unindexedForeignKeys,
      tablesWithoutPrimaryKey,
      autoSchemaSync,
    },
  };
}
