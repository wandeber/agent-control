import type { z } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schema: z.ZodTypeAny;
}

export function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

export function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
}

export function booleanProperty(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

export function numberProperty(description: string): Record<string, unknown> {
  return { type: "number", description };
}

export function stringArrayProperty(description: string): Record<string, unknown> {
  return { type: "array", items: { type: "string" }, description };
}

export function enumProperty(values: readonly string[], description: string): Record<string, unknown> {
  return { type: "string", enum: [...values], description };
}
