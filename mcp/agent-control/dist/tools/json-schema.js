export function objectSchema(properties, required = []) {
    return {
        type: "object",
        properties,
        required,
        additionalProperties: false
    };
}
export function stringProperty(description) {
    return { type: "string", description };
}
export function booleanProperty(description) {
    return { type: "boolean", description };
}
export function numberProperty(description) {
    return { type: "number", description };
}
export function stringArrayProperty(description) {
    return { type: "array", items: { type: "string" }, description };
}
export function enumProperty(values, description) {
    return { type: "string", enum: [...values], description };
}
