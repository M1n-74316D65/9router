import { z } from "zod";

// Claude tools carry JSON Schema in input_schema. Covers the common subset; anything else becomes z.any().
export function toZod(schema) {
  if (!schema || typeof schema !== "object") return z.any();
  let out;
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((v) => typeof v === "string")) {
    out = z.enum(schema.enum);
  } else {
    switch (schema.type) {
      case "string":
        out = z.string();
        break;
      case "number":
      case "integer":
        out = z.number();
        break;
      case "boolean":
        out = z.boolean();
        break;
      case "array":
        out = z.array(toZod(schema.items));
        break;
      case "object":
        out = z.object(toShape(schema));
        break;
      default:
        out = z.any();
    }
  }
  return schema.description ? out.describe(schema.description) : out;
}

// Top-level object schema -> raw shape for the SDK tool() helper.
export function toShape(schema) {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([key, prop]) => {
      const zodProp = toZod(prop);
      return [key, required.has(key) ? zodProp : zodProp.optional()];
    }),
  );
}
