#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ENV_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-)([^}]*))?\}/g;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || args.help) {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  const flowId = stringArg(args, "flow") ?? "development-flow-v1";
  const envFile = resolve(stringArg(args, "agents-env") ?? stringArg(args, "env-file") ?? ".agents.env");
  const configPath = resolveFlowConfigPath({
    flowId,
    configFile: stringArg(args, "config-file"),
    agentctl: stringArg(args, "agentctl"),
  });
  const variables = discoverFlowVariables(configPath);
  const envValues = readEnvFile(envFile);

  if (command === "list") {
    printJson({
      flow_id: flowId,
      config_path: configPath,
      env_file: envFile,
      variables: variables.map((variable) => ({
        ...variable,
        configured: Object.prototype.hasOwnProperty.call(envValues, variable.name),
        current_value: maskIfSensitive(variable.name, envValues[variable.name]),
      })),
    });
    return;
  }

  if (command === "template") {
    const block = buildTemplateBlock(flowId, variables);
    process.stdout.write(`${block}\n`);
    return;
  }

  if (command === "set") {
    const sets = parseSetArgs(args.set ?? []);
    if (Object.keys(sets).some(key => /_(MODEL|REASONING_EFFORT)$/.test(key))) throw new Error("Model overrides belong in .agents/models.toml; use flow-model-configurator.mjs.");
    const allowUnknown = Boolean(args["allow-unknown"]);
    validateSetKeys(sets, variables, allowUnknown);
    const dryRun = Boolean(args["dry-run"]);
    const result = writeEnvOverrides({
      envFile,
      flowId,
      variables,
      sets,
      dryRun,
    });
    printJson(result);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [], set: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      const key = arg.slice(2, equalsIndex);
      const value = arg.slice(equalsIndex + 1);
      pushArg(args, key, value);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      pushArg(args, key, true);
      continue;
    }

    pushArg(args, key, next);
    index += 1;
  }

  return args;
}

function pushArg(args, key, value) {
  if (key === "set") {
    args.set.push(value);
    return;
  }
  args[key] = value;
}

function stringArg(args, key) {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveFlowConfigPath({ flowId, configFile, agentctl }) {
  if (configFile) {
    return resolve(configFile);
  }

  const executable = agentctl ?? "agentctl";
  const result = spawnSync(executable, ["flow", "catalog", "get", "--flow", flowId], {
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(
      `Unable to run ${executable}. Pass --config-file or make agentctl available: ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    throw new Error(`agentctl flow catalog get failed:\n${result.stderr || result.stdout}`);
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`agentctl did not return JSON: ${error.message}`);
  }

  if (!payload.config_path) {
    throw new Error(`Catalog entry for ${flowId} did not include config_path.`);
  }

  return payload.config_path;
}

function discoverFlowVariables(configPath) {
  const text = readFileSync(configPath, "utf8");
  const byName = new Map();

  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trimStart().startsWith("#")) {
      return;
    }

    ENV_PLACEHOLDER_RE.lastIndex = 0;
    let match;
    while ((match = ENV_PLACEHOLDER_RE.exec(line))) {
      const [, name, operator, fallback = null] = match;
      const existing = byName.get(name) ?? {
        name,
        kind: classifyVariable(name),
        operator: operator ?? null,
        default: fallback,
        required: !operator,
        occurrences: [],
      };

      if (!existing.default && fallback) {
        existing.default = fallback;
      }
      if (!existing.operator && operator) {
        existing.operator = operator;
      }
      existing.required = existing.required && !operator;
      existing.occurrences.push({
        line: index + 1,
        text: line.trim(),
      });
      byName.set(name, existing);
    }
  });

  return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function classifyVariable(name) {
  if (name.endsWith("_BACKEND")) return "backend";
  if (name.endsWith("_MODEL")) return "model";
  if (name.includes("SERVER") || name.includes("URL")) return "endpoint";
  return "config";
}

function readEnvFile(envFile) {
  if (!existsSync(envFile)) {
    return {};
  }

  const values = {};
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return values;
}

function unquoteEnvValue(rawValue) {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

function maskIfSensitive(name, value) {
  if (typeof value !== "string") return null;
  if (/(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name)) {
    return "<set>";
  }
  return value;
}

function buildTemplateBlock(flowId, variables) {
  const lines = [`# Agent Control flow overrides: ${flowId}`];

  for (const variable of variables) {
    const fallback = variable.default ?? "";
    const suffix = variable.required ? "required" : `default: ${fallback}`;
    lines.push(`# ${variable.kind}; ${suffix}`);
    lines.push(`# ${variable.name}=${fallback}`);
  }

  return lines.join("\n");
}

function parseSetArgs(setArgs) {
  const entries = {};
  for (const item of setArgs) {
    const separatorIndex = item.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`Invalid --set value "${item}". Expected KEY=value.`);
    }
    const key = item.slice(0, separatorIndex);
    const value = item.slice(separatorIndex + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment key "${key}".`);
    }
    entries[key] = value;
  }
  return entries;
}

function validateSetKeys(sets, variables, allowUnknown) {
  if (allowUnknown) return;
  const known = new Set(variables.map((variable) => variable.name));
  const unknown = Object.keys(sets).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flow variable(s): ${unknown.join(", ")}. Use --allow-unknown only for explicit extra keys.`
    );
  }
}

function writeEnvOverrides({ envFile, flowId, variables, sets, dryRun }) {
  const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const hadTrailingNewline = existing.endsWith("\n");
  const lines = existing.length > 0 ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const updated = [];
  const appended = [];

  for (const [key, value] of Object.entries(sets)) {
    const lineIndex = lines.findIndex((line) =>
      new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}=`).test(line)
    );
    const nextLine = `${key}=${quoteEnvValue(value)}`;

    if (lineIndex === -1) {
      appended.push(key);
      continue;
    }

    lines[lineIndex] = nextLine;
    updated.push(key);
  }

  if (appended.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`# Agent Control flow overrides: ${flowId}`);
    const knownByName = new Map(variables.map((variable) => [variable.name, variable]));
    for (const key of appended) {
      const variable = knownByName.get(key);
      if (variable) {
        const fallback = variable.default ? `; default: ${variable.default}` : "";
        lines.push(`# ${variable.kind}${fallback}`);
      }
      lines.push(`${key}=${quoteEnvValue(sets[key])}`);
    }
  }

  const nextText = `${lines.join("\n")}${hadTrailingNewline || lines.length > 0 ? "\n" : ""}`;

  if (!dryRun) {
    writeFileSync(envFile, nextText, "utf8");
  }

  return {
    dry_run: dryRun,
    env_file: envFile,
    updated_keys: updated,
    appended_keys: appended,
  };
}

function quoteEnvValue(value) {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage() {
  process.stderr.write(`Usage:
  flow-env-configurator.mjs list --flow <flow-id> [--agents-env .agents.env]
  flow-env-configurator.mjs template --flow <flow-id> [--agents-env .agents.env]
  flow-env-configurator.mjs set --flow <flow-id> --set KEY=value [--set KEY=value]

Options:
  --config-file <path>   Read placeholders from a flow file path instead of Agent Control catalog.
  --agents-env <path>    Project-local env file to inspect or update. Defaults to .agents.env.
  --agentctl <path>      agentctl executable path. Defaults to PATH lookup.
  --allow-unknown        Permit writing keys not present in the selected flow.
  --dry-run              Show the write result without editing the env file.
`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
