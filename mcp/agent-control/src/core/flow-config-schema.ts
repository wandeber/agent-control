export const flowConfigJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-control.local/schemas/flow-config.schema.json",
  title: "Agent Control Flow Config",
  type: "object",
  additionalProperties: false,
  required: ["id", "initial_step", "steps"],
  properties: {
    id: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    initial_step: { type: "string", minLength: 1 },
    policy: { type: "object", additionalProperties: false, properties: { strict: { type: "boolean" }, plan_artifact: { type: "string" }, work_packages: { type: "object", additionalProperties: false, required: ["approval_decision", "manifest_step", "execution_step", "integration_step"], properties: { approval_decision: { type: "string" }, approval_value: { type: "string" }, success_condition: { $ref: "#/$defs/condition" }, manifest_step: { type: "string" }, execution_step: { type: "string" }, integration_step: { type: "string" } } } } },
    state: { type: "object", additionalProperties: true },
    preferences: { type: "object", additionalProperties: { type: "object", properties: { values: { type: "array", minItems: 1, items: { type: "string" } }, artifact_key: { type: "string" }, owner: { enum: ["requester", "orchestrator"] } }, required: ["values"], additionalProperties: false } },
    prompts: {
      type: "object",
      additionalProperties: { $ref: "#/$defs/promptSource" }
    },
    artifacts: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 }
        }
      }
    },
    roles: {
      type: "object",
      additionalProperties: { $ref: "#/$defs/promptOwner" }
    },
    steps: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          execution: { enum: ["worker", "coordinator"] },
          sandbox: { enum: ["read_only", "workspace"] },
          decision: { type: "object", properties: { key: { type: "string" }, artifact_key: { type: "string" }, authority: { enum: ["user", "coordinator"] }, owner: { enum: ["requester", "orchestrator"] } }, required: ["key"], additionalProperties: false },
          evidence_operations: { type: "array", items: { type: "string" } },
          evidence_gates: { type: "array", items: { enum: ["planner", "expert"] } },
          requires: { $ref: "#/$defs/condition" },
          requires_evidence: { type: "array", items: { $ref: "#/$defs/evidenceRequirement" } },
          role: { type: "string", minLength: 1 },
          agent_id: { type: "string", minLength: 1 },
          prompt: { type: "string", minLength: 1 },
          prompt_ref: { type: "string", minLength: 1 },
          prompt_path: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          inputs: {
            type: "object",
            additionalProperties: { $ref: "#/$defs/artifactReference" }
          },
          outputs: {
            type: "object",
            additionalProperties: { $ref: "#/$defs/artifactReference" }
          },
          report: {
            type: "object",
            additionalProperties: false,
            properties: {
              tool: { type: "string", minLength: 1 },
              schema: { $ref: "#/$defs/resultSchema" }
            }
          },
          on: {
            type: "object",
            additionalProperties: { $ref: "#/$defs/action" }
          }
        }
      }
    }
  },
  $defs: {
    evidenceRequirement: { type: "object", additionalProperties: false, required: ["receipt"], properties: { receipt: { type: "string" }, kind: { type: "string" }, require_current: { type: "boolean" }, require_approved: { type: "boolean" }, owner_role: { type: "string" }, validation_mode: { enum: ["focused", "complete_gate"] } } },
    promptSource: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 }
      },
      oneOf: [{ required: ["path"] }, { required: ["text"] }]
    },
    promptOwner: {
      type: "object",
      additionalProperties: false,
      properties: {
        backend: { type: "string", minLength: 1 },
        model: { type: ["string", "null"] },
        reasoning_effort: { type: ["string", "null"], description: "Codex-thread reasoning effort. Omit or clear to inherit the Codex default." },
        agent_lifecycle: {
          type: "string",
          enum: ["reuse", "fresh_per_step"],
          default: "reuse"
        },
        backend_options: {
          type: "object",
          additionalProperties: false,
          properties: {
            codex_subagent: {
              type: "object",
              additionalProperties: false,
              properties: {
                fork_turns: {
                  type: "string",
                  pattern: "^(none|all|[1-9][0-9]*)$"
                }
              }
            }
          }
        },
        description: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
        prompt_ref: { type: "string", minLength: 1 },
        prompt_path: { type: "string", minLength: 1 }
      }
    },
    artifactReference: {
      type: "object",
      additionalProperties: false,
      required: ["artifact"],
      properties: {
        artifact: { type: "string", minLength: 1 },
        required: { type: "boolean" }
      }
    },
    resultSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { const: "object" },
        required: {
          type: "array",
          items: { type: "string", minLength: 1 }
        },
        properties: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { enum: ["string", "number", "boolean", "object", "array", "null"] },
              enum: {
                type: "array",
                items: {
                  anyOf: [
                    { type: "string" },
                    { type: "number" },
                    { type: "boolean" },
                    { type: "null" }
                  ]
                }
              }
            }
          }
        }
      }
    },
    condition: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["equals"],
          properties: {
            equals: {
              type: "object",
              additionalProperties: false,
              required: ["var", "value"],
              properties: {
                var: { type: "string", minLength: 1 },
                value: {}
              }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["exists"],
          properties: {
            exists: {
              type: "object",
              additionalProperties: false,
              required: ["var"],
              properties: {
                var: { type: "string", minLength: 1 }
              }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["all"],
          properties: {
            all: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/$defs/condition" }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["any"],
          properties: {
            any: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/$defs/condition" }
            }
          }
        }
      ]
    },
    action: {
      type: "object",
      additionalProperties: false,
      properties: {
        requires: { $ref: "#/$defs/condition" },
        requires_evidence: { type: "array", items: { $ref: "#/$defs/evidenceRequirement" } },
        set: { type: "object", additionalProperties: true },
        notify: { type: "string", minLength: 1 },
        to: { type: "string", minLength: 1 },
        finish: { type: "boolean" },
        transitions: {
          type: "array",
          items: { $ref: "#/$defs/transition" }
        }
      }
    },
    transition: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
        when: { $ref: "#/$defs/condition" },
        requires: { $ref: "#/$defs/condition" },
        requires_evidence: { type: "array", items: { $ref: "#/$defs/evidenceRequirement" } },
        set: { type: "object", additionalProperties: true },
        notify: { type: "string", minLength: 1 },
        to: { type: "string", minLength: 1 },
        finish: { type: "boolean" },
        transitions: {
          type: "array",
          items: { $ref: "#/$defs/transition" }
        }
      }
    }
  }
} as const;
